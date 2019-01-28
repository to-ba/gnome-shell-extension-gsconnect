'use strict';

const ByteArray = imports.byteArray;
const Gio = imports.gi.Gio;
const GLib = imports.gi.GLib;
const GObject = imports.gi.GObject;

const Core = imports.service.protocol.core;
const DBus = imports.service.components.dbus;
const Multiplex = imports.service.protocol.multiplex;


/**
 * org.bluez Interfaces
 */
const BluezNode = Gio.DBusNodeInfo.new_for_xml(`
<node>
  <interface name="org.bluez.ProfileManager1">
    <method name="RegisterProfile">
      <arg name="profile" type="o" direction="in"/>
      <arg name="UUID" type="s" direction="in"/>
      <arg name="options" type="a{sv}" direction="in"/>
    </method>
    <method name="UnregisterProfile">
      <arg name="profile" type="o" direction="in"/>
    </method>
  </interface>

  <!-- Device (eg. /org/bluez/hci0/dev_00_00_00_00_00_00) -->
  <interface name="org.bluez.Device1">
    <!-- Methods -->
    <method name="Disconnect"/>
    <method name="Connect"/>
    <method name="ConnectProfile">
      <arg name="UUID" type="s" direction="in"/>
    </method>
    <method name="DisconnectProfile">
      <arg name="UUID" type="s" direction="in"/>
    </method>
    <method name="Pair"/>
    <method name="CancelPairing"/>
    <!-- Properties -->
    <property name="Address" type="s" access="read"/>
    <property name="AddressType" type="s" access="read"/>
    <property name="Name" type="s" access="read"/>
    <property name="Alias" type="s" access="readwrite"/>
    <property name="Class" type="u" access="read"/>
    <property name="Appearance" type="q" access="read"/>
    <property name="Icon" type="s" access="read"/>
    <property name="Paired" type="b" access="read"/>
    <property name="Trusted" type="b" access="readwrite"/>
    <property name="Blocked" type="b" access="readwrite"/>
    <property name="LegacyPairing" type="b" access="read"/>
    <property name="RSSI" type="n" access="read"/>
    <property name="Connected" type="b" access="read"/>
    <property name="UUIDs" type="as" access="read"/>
    <property name="Modalias" type="s" access="read"/>
    <property name="Adapter" type="o" access="read"/>
    <property name="ManufacturerData" type="a{qv}" access="read"/>
    <property name="ServiceData" type="a{sv}" access="read"/>
    <property name="TxPower" type="n" access="read"/>
    <property name="ServicesResolved" type="b" access="read"/>
  </interface>

  <!-- Profile (to be exported) -->
  <interface name="org.bluez.Profile1">
    <!-- Methods -->
    <method name="Release"/>
    <method name="NewConnection">
      <arg name="device" type="o" direction="in"/>
      <arg name="fd" type="h" direction="in"/>
      <arg name="fd_properties" type="a{sv}" direction="in"/>
    </method>
    <method name="RequestDisconnection">
      <arg name="object_path" type="o" direction="in"/>
    </method>
  </interface>
</node>
`);


/**
 * Proxy for org.bluez.Adapter1 interface
 */
const DEVICE_INFO = BluezNode.lookup_interface('org.bluez.Device1');
const PROFILE_INFO = BluezNode.lookup_interface('org.bluez.Profile1');
const PROFILE_MANAGER_INFO = BluezNode.lookup_interface('org.bluez.ProfileManager1');

const ProfileManager1Proxy = DBus.makeInterfaceProxy(PROFILE_MANAGER_INFO);


/**
 * Service Discovery Protocol Record and Service UUID
 */
const SERVICE_RECORD = gsconnect.get_resource(`${gsconnect.app_id}.sdp.xml`);
const SERVICE_UUID = '185f3df4-3268-4e3f-9fca-d4d5059915bd';
const SERVICE_PROFILE = {
    RequireAuthorization: new GLib.Variant('b', false),
    RequireAuthentication: new GLib.Variant('b', true),
    ServiceRecord: new GLib.Variant('s', SERVICE_RECORD)
};


/**
 * Bluez Channel Service
 */
var ChannelService = GObject.registerClass({
    GTypeName: 'GSConnectBluetoothChannelService',
    Implements: [Gio.DBusInterface],
    Properties: {
        'devices': GObject.param_spec_variant(
            'devices',
            'Devices',
            'A list of Bluez devices supporting the KDE Connect protocol',
            new GLib.VariantType('as'),
            null,
            GObject.ParamFlags.READABLE
        )
    }
}, class ChannelService extends Gio.DBusProxy {

    _init() {
        // Throw immediately if GJS < 1.54
        if (imports.system.version < 15400) {
            throw new Error('Bluetooth not supported');
        }

        super._init({
            g_bus_type: Gio.BusType.SYSTEM,
            g_name: 'org.bluez',
            g_object_path: '/',
            g_interface_name: 'org.freedesktop.DBus.ObjectManager',
            g_flags: Gio.DBusProxyFlags.DO_NOT_AUTO_START_AT_CONSTRUCTION
        });

        // The full device map
        this._devices = new Map();

        // Asynchronous init
        this._init_async();
    }

    // A list of device proxies supporting the KDE Connect Service UUID
    get devices() {
        let devices = Array.from(this._devices.values());
        return devices.filter(bludev => bludev.UUIDs.includes(SERVICE_UUID));
    }

    get service() {
        return Gio.Application.get_default();
    }

    async _init_async() {
        try {
            await this.init_promise();

            // Get a profile manager
            this._profileManager = new ProfileManager1Proxy({
                g_bus_type: Gio.BusType.SYSTEM,
                g_name: 'org.bluez',
                g_object_path: '/org/bluez',
                g_flags: Gio.DBusProxyFlags.DO_NOT_AUTO_START_AT_CONSTRUCTION
            });
            await this._profileManager.init_promise();

            // Export the service profile interface
            this._profile = new DBus.Interface({
                g_connection: this.g_connection,
                g_instance: this,
                g_interface_info: PROFILE_INFO,
                g_object_path: '/org/gnome/Shell/Extensions/GSConnect/Bluetooth'
            });

            // Watch the service
            this._nameOwnerChangedId = this.connect(
                'notify::g-name-owner',
                this._onNameOwnerChanged.bind(this)
            );

            this._onNameOwnerChanged();
        } catch (e) {
            if (e instanceof Gio.DBusError) {
                Gio.DBusError.strip_remote_error(e);
            }

            warning(`GSConnect: Bluetooth Error: ${e.message}`);
            this.destroy();
        }
    }

    vfunc_g_signal(sender_name, signal_name, parameters) {
        try {
            // Wait until the name is properly owned
            if (!this.g_name_owner === null) return;

            parameters = parameters.deep_unpack();

            switch (true) {
                case (signal_name === 'InterfacesAdded'):
                    this._onInterfacesAdded(...parameters);
                    break;

                case (signal_name === 'InterfacesRemoved'):
                    this._onInterfacesRemoved(...parameters);
                    break;
            }
        } catch (e) {
            logError(e);
        }
    }

    async _getDeviceProxy(object_path) {
        try {
            let proxy = new Gio.DBusProxy({
                g_bus_type: Gio.BusType.SYSTEM,
                g_name: this.g_name_owner,
                g_object_path: object_path,
                g_interface_name: 'org.bluez.Device1'
            });
            await proxy.init_promise();

            // Initialize properties and methods
            DBus.proxyMethods(proxy, DEVICE_INFO);
            DBus.proxyProperties(proxy, DEVICE_INFO);

            //
            proxy.close = function() {
                if (this._muxer) {
                    debug(`GSConnect: Disconnecting ${this.Alias}`);
                    this._muxer.close();
                    this._muxer = null;
                }
            };

            // Set a null channel
            proxy._muxer = null;

            return proxy;
        } catch (e) {
            warning(e);
            return undefined;
        }
    }

    /**
     * org.freedesktop.DBus.ObjectManager.InterfacesAdded
     *
     * @param {string} object_path - Path interfaces have been removed from
     * @param {object[]} - ??
     */
    async _onInterfacesAdded(object_path, interfaces) {
        try {
            for (let interface_name in interfaces) {
                // Only handle devices
                if (interface_name !== 'org.bluez.Device1') continue;

                // We track all devices in case their service UUIDs change later
                if (this._devices.has(object_path)) continue;

                // Setup the device proxy
                let proxy = await this._getDeviceProxy(object_path);
                if (proxy === undefined) continue;

                // Watch for connected/paired changes
                proxy.__deviceChangedId = proxy.connect(
                    'g-properties-changed',
                    this._onDeviceChanged.bind(this)
                );

                // Store the proxy and emit notify::devices
                this._devices.set(proxy.g_object_path, proxy);
                this.notify('devices');
            }
        } catch (e) {
            logError(e, object_path);
        }
    }

    /**
     * org.freedesktop.DBus.ObjectManager.InterfacesRemoved
     *
     * @param {string} object_path - Path interfaces have been removed from
     * @param {string[]} - List of interface names removed
     */
    async _onInterfacesRemoved(object_path, interfaces) {
        try {
            // An empty interface list means the object is being removed
            if (interfaces.length === 0) return;

            for (let interface_name of interfaces) {
                // Only handle devices
                if (interface_name !== 'org.bluez.Device1') continue;

                // Get the proxy
                let proxy = this._devices.get(object_path);
                if (proxy === undefined) continue;

                // Stop watching for connected/paired changes
                proxy.disconnect(proxy.__deviceChangedId);
                this.RequestDisconnection(object_path);

                // Release the proxy and emit notify::devices
                this._devices.delete(object_path);
                this.notify('devices');
            }
        } catch (e) {
            logError(e, object_path);
        }
    }

    _onDeviceChanged(proxy, changed, invalidated) {
        // Try connecting if the device has just connected or resolved services
        changed = changed.full_unpack();

        if (changed.hasOwnProperty('Connected')) {
            if (changed.Connected) {
                this._connectDevice(proxy);
            } else {
                this.RequestDisconnection(proxy.g_object_path);
            }
        } else if (changed.ServicesResolved) {
            this._connectDevice(proxy);
        }
    }

    async _onNameOwnerChanged() {
        try {
            if (this.g_name_owner === null) {
                // Ensure we've removed all devices before restarting
                for (let bludev of this._devices.values()) {
                    bludev.disconnect(bludev.__deviceChangedId);
                    this._devices.delete(bludev.g_object_path);
                }

                await this._getManagedObjects();
            } else {
                // Register the service profile
                await this._profileManager.RegisterProfile(
                    this._profile.g_object_path,
                    SERVICE_UUID,
                    SERVICE_PROFILE
                );

                // Add current devices
                let objects = await this._getManagedObjects();

                for (let [object_path, object] of Object.entries(objects)) {
                    await this._onInterfacesAdded(object_path, object);
                }
            }
        } catch (e) {
            logError(e);
        }
    }


    /**
     * org.freedesktop.DBus.ObjectManager.GetManagedObjects
     *
     * @return {object} - Dictionary of managed object paths and interface names
     */
    _getManagedObjects() {
        return new Promise((resolve, reject) => {
            this.call(
                'GetManagedObjects',
                null,
                Gio.DBusCallFlags.NONE,
                -1,
                null,
                (proxy, res) => {
                    try {
                        let variant = proxy.call_finish(res);
                        resolve(variant.deep_unpack()[0]);
                    } catch (e) {
                        reject(e);
                    }
                }
            );
        });
    }

    /**
     * Attempt to connect the service profile to @bludev
     *
     * @param {Gio.DBusProxy} bludev - A org.bluez.Device1 interface proxy
     */
    async _connectDevice(bludev) {
        try {
            // This device already has a connected or connecting channel
            if (bludev._muxer) {
                debug('already connected', bludev.Alias);
                return;
            }

            // Only try connecting paired bluetooth devices
            if (bludev.Paired) {
                debug('requesting bluetooth connection', bludev.Alias);
                await bludev.ConnectProfile(SERVICE_UUID);
            }
        } catch (e) {
            // Silence errors (for now)
        }
    }

    /**
     * This method gets called when the service daemon unregisters the profile.
     * A profile can use it to do cleanup tasks. There is no need to unregister
     * the profile, because when this method gets called it has already been
     * unregistered.
     */
    async Release() {
        debug('Release');
        return;
    }

    /**
     * This method gets called when a new service level connection has been
     * made and authorized.
     *
     * @param {string} - DBus object path
     * @param {number} - A number for the incoming connection's file-descriptor
     * @param {object} - An object of properties for the file-descriptor
     */
    async NewConnection(object_path, fd, fd_properties) {
        debug(`(${object_path}, ${fd}, ${JSON.stringify(fd_properties)})`);

        let bludev = this._devices.get(object_path);

        try {
            // Create a Gio.SocketConnection from the file-descriptor
            let connection = new Gio.SocketConnection({
                socket: Gio.Socket.new_from_fd(fd)
            });

            bludev._muxer = new Multiplex.Connection(connection);
            bludev._muxer.cancellable.connect(bludev.close.bind(bludev));

            // TODO: We can't differentiate incoming or outgoing connections so
            // Channel.negotiate() will decide based on the first message
            let channel = bludev._muxer._default;
            await channel.negotiate(connection);

            channel.identity.body.bluetoothHost = bludev.Address;
            channel.identity.body.bluetoothPath = bludev.g_object_path;

            // Unlike Lan channels, we accept all new connections since they
            // have to be paired over bluetooth anyways
            let device = await this.service._ensureDevice(channel.identity);

            // Attach a device to the channel
            channel.attach(device);
        } catch (e) {
            bludev.close();
            warning(e, bludev.Alias);
        }
    }

    /**
     * This method gets called when a profile gets disconnected.
     *
     * The file descriptor is no longer owned by the service daemon and the
     * profile implementation needs to take care of cleaning up all
     * connections.
     *
     * If multiple file descriptors are indicated via NewConnection, it is
     * expected that all of them are disconnected before returning from this
     * method call.
     *
     * @param {string} object_path - DBus object path
     * @return {undefined} - void return value
     */
    async RequestDisconnection(object_path) {
        debug(object_path);

        try {
            let bludev = this._devices.get(object_path);

            if (bludev) {
                bludev.close();
            }
        } catch (e) {
            debug(e);
            // Silence errors (for now)
        }
    }

    broadcast(object_path) {
        try {
            let bludev = this._devices.get(object_path);

            if (bludev) {
                this._connectDevice(bludev);
            }
        } catch (e) {
            debug(e, object_path);
        }
    }

    destroy() {
        this.disconnect(this._nameOwnerChangedId);

        for (let bludev of this._devices.values()) {
            bludev.close();
        }

        if (this._profile) {
            this._profile.destroy();
        }

        if (this._profileManager) {
            this._profileManager.destroy();
            this._profileManager = null;
        }
    }
});


var Transfer = Multiplex.Transfer;

