// The light the snow is drawn in: a port of windows/src/light.rs, reading GNOME's background settings.

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GdkPixbuf from 'gi://GdkPixbuf';

import {smoothstep} from './simulation.js';

/// The scene turns warmer at dawn and dusk, cooler and dimmer at night.
/// Clock-based rather than solar: close enough for mood, and needs no location.
export function daylight() {
    const now = GLib.DateTime.new_now_local();
    const hour = now.get_hour() + now.get_minute() / 60;
    const day = smoothstep(6, 8.5, hour) * (1 - smoothstep(17.5, 20.5, hour));
    const golden = Math.min(Math.exp(-(((hour - 7.6) / 1.1) ** 2)) + Math.exp(-(((hour - 18.6) / 1.2) ** 2)), 1);
    const night = [0.86, 0.89, 0.97];
    const warm = [1, 0.965, 0.915];
    return night.map((value, i) => {
        const base = value + (1 - value) * day;
        return base + (warm[i] - base) * golden * 0.55;
    });
}

/// Shadows in the snow pick up the colour of the desktop picture along the bottom of the screen.
/// GNOME shows one picture on every display, so one tint serves them all.
export class Wallpaper {
    constructor(changed) {
        this._changed = changed;
        this._background = new Gio.Settings({schema_id: 'org.gnome.desktop.background'});
        this._interface = new Gio.Settings({schema_id: 'org.gnome.desktop.interface'});
        this._ids = [
            [this._background, this._background.connect('changed', () => this._update())],
            [this._interface, this._interface.connect('changed::color-scheme', () => this._update())],
        ];
        this._cancellable = null;
        this._key = null;
        this.tint = [0, 0, 0, 0];
        this._update();
    }

    destroy() {
        this._cancellable?.cancel();
        for (const [settings, id] of this._ids)
            settings.disconnect(id);
        this._ids = [];
    }

    _update() {
        const dark = this._interface.get_string('color-scheme') === 'prefer-dark';
        const options = this._background.get_string('picture-options');
        const uri = this._background.get_string(dark ? 'picture-uri-dark' : 'picture-uri') ||
            this._background.get_string('picture-uri');
        const color = this._background.get_string('primary-color');
        const path = options === 'none' ? null : pictureFile(uri);
        const modified = path ? Gio.File.new_for_path(path).query_info('time::modified', 0, null)
            ?.get_modification_date_time()?.to_unix() : 0;
        const key = path ? `${path}@${modified}` : `color ${color}`;
        if (key === this._key)
            return;
        this._key = key;
        this._cancellable?.cancel();
        this._cancellable = null;
        if (!path) {
            this._set(parseColor(color));
            return;
        }
        // Decoding a large picture takes a moment, so it happens off the compositor's thread.
        const cancellable = new Gio.Cancellable();
        this._cancellable = cancellable;
        Gio.File.new_for_path(path).read_async(GLib.PRIORITY_LOW, cancellable, (file, result) => {
            try {
                const stream = file.read_finish(result);
                GdkPixbuf.Pixbuf.new_from_stream_at_scale_async(stream, 64, 64, true, cancellable, (source, done) => {
                    try {
                        this._set(averageBottom(GdkPixbuf.Pixbuf.new_from_stream_finish(done)));
                    } catch (error) {
                        if (!error.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED))
                            this._set(parseColor(color));
                    }
                });
            } catch (error) {
                if (!error.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED))
                    this._set(parseColor(color));
            }
        });
    }

    /// The backdrop's average colour along the bottom quarter, brought to the brightness of snow in shade.
    _set(average) {
        if (!average) {
            this.tint = [0, 0, 0, 0];
        } else {
            const luminance = average[0] * 0.2126 + average[1] * 0.7152 + average[2] * 0.0722;
            const shade = 0.775 / Math.max(luminance, 0.04);
            this.tint = [...average.map(channel => Math.min(channel * shade, 1)), 0.35];
        }
        this._changed();
    }
}

/// The picture a background URI shows: the file itself, or for a slideshow, the first picture it lists.
function pictureFile(uri) {
    if (!uri)
        return null;
    let path;
    try {
        path = Gio.File.new_for_uri(uri).get_path();
    } catch {
        return null;
    }
    if (!path || !GLib.file_test(path, GLib.FileTest.EXISTS))
        return null;
    if (!path.endsWith('.xml'))
        return path;
    try {
        const [, contents] = GLib.file_get_contents(path);
        const match = new TextDecoder().decode(contents).match(/<(?:file|from)>\s*([^<\s][^<]*?)\s*<\/(?:file|from)>/);
        return match && GLib.file_test(match[1], GLib.FileTest.EXISTS) ? match[1] : null;
    } catch {
        return null;
    }
}

function averageBottom(pixbuf) {
    const pixels = pixbuf.get_pixels();
    const width = pixbuf.get_width();
    const height = pixbuf.get_height();
    const stride = pixbuf.get_rowstride();
    const channels = pixbuf.get_n_channels();
    const sum = [0, 0, 0];
    let count = 0;
    // Rows run top-down, so the bottom of the picture is at the end.
    for (let y = Math.floor(height * 3 / 4); y < height; y++) {
        for (let x = 0; x < width; x++) {
            const i = y * stride + x * channels;
            for (let c = 0; c < 3; c++)
                sum[c] += pixels[i + c] / 255;
            count++;
        }
    }
    return count > 0 ? sum.map(channel => channel / count) : null;
}

function parseColor(text) {
    const match = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})/i.exec(text ?? '');
    return match ? match.slice(1, 4).map(hex => parseInt(hex, 16) / 255) : null;
}
