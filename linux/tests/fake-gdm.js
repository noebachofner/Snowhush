// Stands in for GDM on the test system bus, so GNOME Shell offers its lock screen. For linux/tests/headless.sh only.
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

const node = `<node><interface name="org.gnome.DisplayManager.Manager"><property name="Version" type="s" access="read"/></interface></node>`;
const service = Gio.DBusExportedObject.wrapJSObject(node, {Version: '46.0'});
service.export(Gio.DBus.system, '/org/gnome/DisplayManager/Manager');
Gio.bus_own_name_on_connection(Gio.DBus.system, 'org.gnome.DisplayManager', Gio.BusNameOwnerFlags.NONE, null, null);
new GLib.MainLoop(null, false).run();
