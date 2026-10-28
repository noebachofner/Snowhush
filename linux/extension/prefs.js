// The settings in the Extensions app: the same options as the snowflake's menu.

import Adw from 'gi://Adw';
import Gio from 'gi://Gio';
import Gtk from 'gi://Gtk';

import {ExtensionPreferences} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

import {SNOWFALLS, snowfallTitle} from './simulation.js';

export default class SnowhushPreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        const settings = this.getSettings();
        window._settings = settings;
        const page = new Adw.PreferencesPage({title: 'Snowhush', icon_name: 'weather-snow-symbolic'});
        window.add(page);

        const snow = new Adw.PreferencesGroup({title: 'Snow', description: "It's snowing on your desktop."});
        page.add(snow);
        const snowfall = new Adw.ComboRow({
            title: 'Snowfall',
            subtitle: 'Variable lets the snowfall rise and ease on its own over the day.',
            model: Gtk.StringList.new(SNOWFALLS.map(snowfallTitle)),
        });
        const sync = () => {
            const index = SNOWFALLS.indexOf(settings.get_string('snowfall'));
            if (index >= 0 && snowfall.selected !== index)
                snowfall.selected = index;
        };
        sync();
        settings.connect('changed::snowfall', sync);
        snowfall.connect('notify::selected', () => settings.set_string('snowfall', SNOWFALLS[snowfall.selected]));
        snow.add(snowfall);
        snow.add(this._switch(settings, 'accumulate', 'Accumulate', 'Snow piles up on the ground and on windows.'));
        const melt = this._switch(settings, 'melt-snow', 'Melt Snow', 'The drift thaws slowly, so it never takes over the screen.');
        settings.bind('accumulate', melt, 'sensitive', Gio.SettingsBindFlags.GET);
        snow.add(melt);
        const windows = this._switch(settings, 'snow-on-windows', 'Snow on Windows', 'Snow settles along the tops of windows.');
        settings.bind('behind-windows', windows, 'sensitive', Gio.SettingsBindFlags.GET | Gio.SettingsBindFlags.INVERT_BOOLEAN);
        snow.add(windows);

        const desktop = new Adw.PreferencesGroup({title: 'Desktop'});
        page.add(desktop);
        desktop.add(this._switch(settings, 'behind-windows', 'Behind Windows', 'Snow falls on the desktop behind your windows.'));
        desktop.add(this._switch(settings, 'show-in-screenshots', 'Show in Screenshots',
            'Screenshots, recordings and screen sharing include the snow. Otherwise it is left out of screenshots, ' +
            'and hidden while the screen is shared or recorded.'));
        desktop.add(this._switch(settings, 'open-at-login', 'Open at Login', 'Snowhush starts snowing when you log in.'));
    }

    _switch(settings, key, title, subtitle) {
        const row = new Adw.SwitchRow({title, subtitle});
        settings.bind(key, row, 'active', Gio.SettingsBindFlags.DEFAULT);
        return row;
    }
}
