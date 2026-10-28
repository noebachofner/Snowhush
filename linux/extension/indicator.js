// The snowflake in the top bar (or Zorin's taskbar) and its menu, laid out like the menu on macOS and Windows.

import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GObject from 'gi://GObject';
import St from 'gi://St';

import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import {Slider} from 'resource:///org/gnome/shell/ui/slider.js';

import {SNOWFALLS, Snowfall, snowfallTitle} from './simulation.js';

/// A slider with a stop per option: the keyboard and the scroll wheel move a stop at a time, and a drag
/// settles on the nearest stop when it ends.
const StopSlider = GObject.registerClass(
class StopSlider extends Slider {
    _init(stops, index) {
        super._init(index / (stops - 1));
        this._stops = stops;
        this._scrolled = 0;
        this.connect('drag-end', () => this.setIndex(this.index));
    }

    get index() {
        return Math.round(this.value * (this._stops - 1));
    }

    setIndex(index) {
        this.value = Math.min(Math.max(index, 0), this._stops - 1) / (this._stops - 1);
    }

    scroll(event) {
        const direction = event.get_scroll_direction();
        if (event.get_flags() & Clutter.EventFlags.FLAG_POINTER_EMULATED)
            return Clutter.EVENT_PROPAGATE;
        if (direction === Clutter.ScrollDirection.UP || direction === Clutter.ScrollDirection.RIGHT) {
            this.setIndex(this.index + 1);
        } else if (direction === Clutter.ScrollDirection.DOWN || direction === Clutter.ScrollDirection.LEFT) {
            this.setIndex(this.index - 1);
        } else if (direction === Clutter.ScrollDirection.SMOOTH) {
            // A touchpad scrolls in small amounts; a stop takes a notch's worth.
            const [, dy] = event.get_scroll_delta();
            this._scrolled -= dy;
            if (Math.abs(this._scrolled) >= 1) {
                this.setIndex(this.index + Math.sign(this._scrolled));
                this._scrolled = 0;
            }
        }
        return Clutter.EVENT_STOP;
    }

    vfunc_key_press_event(event) {
        const key = event.get_key_symbol();
        if (key === Clutter.KEY_Right || key === Clutter.KEY_Left) {
            const forward = (key === Clutter.KEY_Right) !== (this.get_text_direction() === Clutter.TextDirection.RTL);
            this.setIndex(this.index + (forward ? 1 : -1));
            return Clutter.EVENT_STOP;
        }
        return super.vfunc_key_press_event(event);
    }
});

/// `app` is the extension: it holds the settings and the snow, and checks for updates and quits.
export const Indicator = GObject.registerClass(
class Indicator extends PanelMenu.Button {
    _init(app) {
        super._init(0.5, 'Snowhush', false);
        this._app = app;
        this._settings = app.getSettings();
        this.accessible_name = 'Snowhush';

        this._icon = new St.Icon({
            gicon: Gio.icon_new_for_string(`${app.path}/icons/snowhush-symbolic.svg`),
            style_class: 'system-status-icon',
        });
        this.add_child(this._icon);

        const header = new PopupMenu.PopupMenuItem('Snowfall', {reactive: false, can_focus: false});
        header.add_style_class_name('snowhush-header');
        // Dimmed rather than coloured, so it suits light and dark menus alike.
        header.label.opacity = 160;
        this.menu.addMenuItem(header);

        const sliderItem = new PopupMenu.PopupBaseMenuItem({activate: false, style_class: 'snowhush-slider-item'});
        const box = new St.BoxLayout({vertical: true, x_expand: true});
        this._slider = new StopSlider(SNOWFALLS.length, this._snowfallIndex());
        this._slider.accessible_name = 'Snowfall';
        this._caption = new St.Label({style_class: 'snowhush-caption', x_align: Clutter.ActorAlign.CENTER, opacity: 160});
        box.add_child(this._slider);
        box.add_child(this._caption);
        sliderItem.add_child(box);
        sliderItem.connect('key-press-event', (item, event) => this._slider.vfunc_key_press_event(event));
        this._slider.connect('notify::value', () => this._slid());
        this.menu.addMenuItem(sliderItem);

        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
        this._accumulate = this._switch('Accumulate', 'accumulate');
        this._melt = this._switch('Melt Snow', 'melt-snow');
        this._windows = this._switch('Snow on Windows', 'snow-on-windows');
        this._clear = this.menu.addAction('Clear Snow', () => this._app.snow?.clear());

        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
        this._behind = this._switch('Behind Windows', 'behind-windows');
        this._screenshots = this._switch('Show in Screenshots', 'show-in-screenshots');
        this._login = this._switch('Open at Login', 'open-at-login');

        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
        this.menu.addAction('Check for Updates…', () => this._app.checkForUpdates(true));
        this.menu.addAction('Quit', () => this._app.quit());

        this._settingsId = this._settings.connect('changed', () => this._sync());
        this.menu.connect('open-state-changed', (menu, open) => {
            if (open)
                this._sync();
        });
        this._sync();
    }

    destroy() {
        if (this._settingsId) {
            this._settings.disconnect(this._settingsId);
            this._settingsId = 0;
        }
        super.destroy();
    }

    _switch(title, key) {
        const item = new PopupMenu.PopupSwitchMenuItem(title, this._settings.get_boolean(key));
        item.connect('toggled', (source, state) => this._settings.set_boolean(key, state));
        this.menu.addMenuItem(item);
        return item;
    }

    _snowfallIndex() {
        const index = SNOWFALLS.indexOf(this._settings.get_string('snowfall'));
        return index < 0 ? SNOWFALLS.indexOf(Snowfall.STEADY) : index;
    }

    _slid() {
        const snowfall = SNOWFALLS[this._slider.index];
        this._caption.text = snowfallTitle(snowfall);
        if (this._settings.get_string('snowfall') !== snowfall)
            this._settings.set_string('snowfall', snowfall);
    }

    _sync() {
        const settings = this._settings;
        const snowfall = SNOWFALLS[this._snowfallIndex()];
        if (!this._slider._dragging && this._slider.index !== this._snowfallIndex())
            this._slider.setIndex(this._snowfallIndex());
        this._caption.text = snowfallTitle(snowfall);
        this._slider.accessible_description = snowfallTitle(snowfall);
        const accumulate = settings.get_boolean('accumulate');
        const behind = settings.get_boolean('behind-windows');
        this._accumulate.setToggleState(accumulate);
        this._melt.setToggleState(settings.get_boolean('melt-snow'));
        this._melt.setSensitive(accumulate);
        this._windows.setToggleState(settings.get_boolean('snow-on-windows'));
        this._windows.setSensitive(!behind);
        this._clear.setSensitive(this._app.snow?.hasSnow() ?? false);
        this._behind.setToggleState(behind);
        this._screenshots.setToggleState(settings.get_boolean('show-in-screenshots'));
        this._login.setToggleState(settings.get_boolean('open-at-login'));
        // A dimmed snowflake while no snow falls.
        this._icon.opacity = snowfall === Snowfall.OFF ? 110 : 255;
    }
});
