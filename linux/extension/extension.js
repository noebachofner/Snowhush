// Snowhush for GNOME: it's snowing on your desktop.
//
// The extension behaves like the app on macOS and Windows. It opens at login when Open at Login is on; Quit stops
// the snow and removes the snowflake until Snowhush is opened again from the app grid, whose launcher asks the
// extension over D-Bus.

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import {Indicator} from './indicator.js';
import {Snow} from './snow.js';
import {Updates} from './updates.js';
import {Welcome} from './welcome.js';

const BUS_PATH = '/dev/snowhush/Snowhush';
const BUS_INTERFACE = `
<node>
  <interface name="dev.snowhush.Snowhush">
    <method name="Open"/>
    <method name="Quit"/>
    <property name="Running" type="b" access="read"/>
  </interface>
</node>`;

export default class SnowhushExtension extends Extension {
    enable() {
        this._settings = this.getSettings();
        this.snow = null;
        const extension = this;
        this._service = Gio.DBusExportedObject.wrapJSObject(BUS_INTERFACE, {
            Open() {
                extension.open();
            },
            Quit() {
                extension.quit();
            },
            get Running() {
                return Boolean(extension.snow);
            },
        });
        this._service.export(Gio.DBus.session, BUS_PATH);
        // At login the extension starts with the session; otherwise, as when just installed or turned on, it opens.
        if (!Main.layoutManager._startingUp || this._settings.get_boolean('open-at-login'))
            this.open();
    }

    disable() {
        // The extension keeps running on the lock screen, so the drifts are still there after unlocking;
        // it is only turned off when the extension itself is.
        this.quit();
        this._service?.unexport();
        this._service = null;
        this._settings = null;
    }

    /// Starts the snow and shows the snowflake in the panel.
    open() {
        if (this.snow)
            return;
        this.snow = new Snow(this._settings);
        this._indicator = new Indicator(this);
        Main.panel.addToStatusArea(this.uuid, this._indicator);
        this._sessionId = Main.sessionMode.connect('updated', () => this._sessionChanged());
        this._sessionChanged();
        this._updates = new Updates(this);
        if (!this._settings.get_boolean('welcomed')) {
            this._welcomeTimer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 1200, () => {
                this._welcomeTimer = 0;
                this._welcome();
                return GLib.SOURCE_REMOVE;
            });
        }
        this._emitRunning();
    }

    /// Stops the snow and takes the snowflake away until Snowhush is opened again.
    quit() {
        if (!this.snow)
            return;
        if (this._welcomeTimer)
            GLib.source_remove(this._welcomeTimer);
        this._welcomeTimer = 0;
        this._welcomeCard?.destroy();
        this._welcomeCard = null;
        if (this._sessionId)
            Main.sessionMode.disconnect(this._sessionId);
        this._sessionId = 0;
        this._updates?.destroy();
        this._updates = null;
        this._indicator?.destroy();
        this._indicator = null;
        this.snow.destroy();
        this.snow = null;
        this._emitRunning();
    }

    checkForUpdates(asked) {
        this._updates?.check(asked);
    }

    _welcome() {
        // Not over the lock screen: it waits for the next login instead.
        if (Main.sessionMode.isLocked)
            return;
        try {
            this._welcomeCard = new Welcome(this, {
                scatter: pieces => this.snow?.scatter(pieces),
                skipped: () => this.snow?.releaseSnowfall(),
                finished: () => {
                    this._welcomeCard = null;
                    this._settings?.set_boolean('welcomed', true);
                },
            });
        } catch (error) {
            console.log(`Snowhush: welcome failed: ${error.message}`);
            this.snow?.releaseSnowfall();
            this._settings.set_boolean('welcomed', true);
        }
    }

    _sessionChanged() {
        // The panel on the lock screen keeps an extension's icons unless told otherwise.
        if (this._indicator)
            this._indicator.container.visible = !Main.sessionMode.isLocked;
    }

    _emitRunning() {
        this._service?.emit_property_changed('Running', new GLib.Variant('b', Boolean(this.snow)));
    }
}
