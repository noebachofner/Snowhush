// What the system is doing that the snow has to fit around: power, the lock screen, the screens sleeping,
// the overview, and screen sharing and recording.

import Gio from 'gi://Gio';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';

/// How much the snow may spend on drawing.
export const PowerBudget = Object.freeze({
    FULL: 'full',
    /// On battery: no frame rates above 60, which are hard to tell apart in snow anyway.
    BATTERY: 'battery',
    /// Power saver: a little less snow, drawn a little less often.
    SAVER: 'saver',
});

const PROFILES = [
    ['org.freedesktop.UPower.PowerProfiles', '/org/freedesktop/UPower/PowerProfiles'],
    ['net.hadess.PowerProfiles', '/net/hadess/PowerProfiles'],
];

/// Calls `changed` whenever any of its readings change.
export class SystemState {
    constructor(changed) {
        this._changed = changed;
        this._signals = [];
        this._cancellable = new Gio.Cancellable();
        this._onBattery = false;
        this._powerSaver = false;
        this._sharing = new Set();

        this._proxy('org.freedesktop.UPower', '/org/freedesktop/UPower', 'org.freedesktop.UPower', proxy => {
            this._onBattery = proxy.get_cached_property('OnBattery')?.unpack() ?? false;
        });
        this._profiles(0);

        this._track(Main.sessionMode, 'updated', () => this._changed());
        if (Main.screenShield)
            this._track(Main.screenShield, 'active-changed', () => this._changed());
        const monitors = global.backend.get_monitor_manager();
        this._track(monitors, 'power-save-mode-changed', () => this._changed());
        this._track(Main.overview, 'showing', () => this._changed());
        this._track(Main.overview, 'hidden', () => this._changed());
        this._track(St.Settings.get(), 'notify::enable-animations', () => this._changed());
        const remote = global.backend.get_remote_access_controller?.();
        if (remote) {
            this._track(remote, 'new-handle', (controller, handle) => {
                this._sharing.add(handle);
                const id = handle.connect('stopped', () => {
                    handle.disconnect(id);
                    this._sharing.delete(handle);
                    this._changed();
                });
                this._changed();
            });
        }
    }

    destroy() {
        this._cancellable.cancel();
        for (const [object, id] of this._signals)
            object.disconnect(id);
        this._signals = [];
    }

    get budget() {
        if (this._powerSaver)
            return PowerBudget.SAVER;
        return this._onBattery ? PowerBudget.BATTERY : PowerBudget.FULL;
    }

    get locked() {
        return Main.sessionMode.isLocked || Boolean(Main.screenShield?.active);
    }

    /// The displays are blanked or switched off.
    get asleep() {
        return global.backend.get_monitor_manager().power_save_mode > 0;
    }

    get overview() {
        return Main.overview.visible;
    }

    /// The screen is being shared or recorded.
    get sharing() {
        return this._sharing.size > 0;
    }

    /// The person prefers less motion: Animations is off under Accessibility or in Tweaks.
    get calm() {
        return !St.Settings.get().enable_animations;
    }

    /// Asks the power profiles service, under its current name or the one it had before.
    _profiles(index) {
        const [name, path] = PROFILES[index];
        this._proxy(name, path, name, proxy => {
            this._powerSaver = proxy.get_cached_property('ActiveProfile')?.unpack() === 'power-saver';
        }, () => {
            if (index + 1 < PROFILES.length)
                this._profiles(index + 1);
        });
    }

    /// A proxy for a system service, read now and whenever its properties change.
    _proxy(name, path, iface, read, missing = () => {}) {
        Gio.DBusProxy.new_for_bus(Gio.BusType.SYSTEM, Gio.DBusProxyFlags.DO_NOT_AUTO_START, null, name, path, iface,
            this._cancellable, (source, result) => {
                let proxy;
                try {
                    proxy = Gio.DBusProxy.new_for_bus_finish(result);
                } catch {
                    missing();
                    return;
                }
                if (!proxy.get_name_owner()) {
                    missing();
                    return;
                }
                read(proxy);
                this._track(proxy, 'g-properties-changed', () => {
                    read(proxy);
                    this._changed();
                });
                this._changed();
            });
    }

    _track(object, signal, handler) {
        this._signals.push([object, object.connect(signal, handler)]);
    }
}
