// Shown on first launch, as on macOS and Windows: getting started crumbles the card into snow that falls onto
// the desktop. A port of windows/src/welcome.rs and card.rs, drawn with Cairo and crumbled on the GPU.

import Cairo from 'cairo';
import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import GdkPixbuf from 'gi://GdkPixbuf';
import Meta from 'gi://Meta';
import Pango from 'gi://Pango';
import PangoCairo from 'gi://PangoCairo';
import Shell from 'gi://Shell';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';

const WIDTH = 440;
const HEIGHT = 430;
/// Room around the card for its shadow.
const MARGIN = 36;
const TITLE = "IT'S SNOWING\nON YOUR DESKTOP.";
const BODY = 'Snowhush lives in the system tray. Click its snowflake to change the snowfall, let the drift melt, ' +
    'or keep the snow off your windows. Sweep it aside with your cursor.';
const BUTTON_LABEL = 'GET STARTED';
const BACKGROUND = [0.105, 0.088, 0.072];
const INK = [0.93, 0.9, 0.85];
const MUTED = [0.78, 0.75, 0.7];
const LABEL = [0.09, 0.075, 0.06];
const BUTTON = [190, 44];
const ICON_SIZE = 112;
/// Spacing of the pieces that fly off.
const CELL = 6;
/// Seconds over which a spot fades out once the front reaches it.
const FEATHER = 0.05;

/// The noise of the crumbling front, the same in JavaScript and in the shader: a hash without sines, which come
/// out differently on the GPU, and value noise built on it.
const NOISE = `
float crumble_hash(vec2 p) {
    vec3 p3 = fract(vec3(p.xyx) * 0.1031);
    p3 += dot(p3, p3.yzx + 33.33);
    return fract((p3.x + p3.y) * p3.z);
}

float crumble_noise(vec2 p) {
    vec2 i = floor(p);
    vec2 f = p - i;
    vec2 u = f * f * (3.0 - 2.0 * f);
    float top = crumble_hash(i) + (crumble_hash(i + vec2(1.0, 0.0)) - crumble_hash(i)) * u.x;
    float bottom = crumble_hash(i + vec2(0.0, 1.0)) + (crumble_hash(i + vec2(1.0, 1.0)) - crumble_hash(i + vec2(0.0, 1.0))) * u.x;
    return top + (bottom - top) * u.y;
}

// The front sweeps down in about half a second, held back here and there by smooth noise and roughened by a fine
// grain so its edge looks like crumbling snow. The point is in DIPs from the card's top left.
float crumble_arrival(vec2 point) {
    float from_top = point.y / ${HEIGHT.toFixed(1)};
    // The noise runs up from the bottom, as on the Mac, so the front looks the same.
    vec2 p = vec2(point.x, ${HEIGHT.toFixed(1)} - point.y);
    float broad = crumble_noise(p / 46.0) * 0.65 + crumble_noise(p / 15.0 + vec2(7.3, 2.1)) * 0.35;
    return from_top * 0.5 + broad * 0.2 + crumble_hash(floor(p * 1.7)) * 0.035;
}

uniform float elapsed;
uniform float size_x;
uniform float size_y;
`;

const FADE = `
    vec2 dip = cogl_tex_coord_in[0].xy * vec2(size_x, size_y);
    // Each pixel takes the front of the nearest point on the card, so the shadow goes with it.
    vec2 point = clamp(dip - vec2(${MARGIN.toFixed(1)}), vec2(0.0), vec2(${WIDTH.toFixed(1)}, ${HEIGHT.toFixed(1)}));
    float alpha = clamp((crumble_arrival(point) - elapsed) / ${FEATHER.toFixed(3)}, 0.0, 1.0);
    cogl_color_out *= alpha;
`;

const fract = x => x - Math.floor(x);

function hash(x, y) {
    let [a, b, c] = [fract(x * 0.1031), fract(y * 0.1031), fract(x * 0.1031)];
    const d = a * (b + 33.33) + b * (c + 33.33) + c * (a + 33.33);
    a += d;
    b += d;
    c += d;
    return fract((a + b) * c);
}

function valueNoise(x, y) {
    const [x0, y0] = [Math.floor(x), Math.floor(y)];
    const [fx, fy] = [x - x0, y - y0];
    const [u, v] = [fx * fx * (3 - 2 * fx), fy * fy * (3 - 2 * fy)];
    const top = hash(x0, y0) + (hash(x0 + 1, y0) - hash(x0, y0)) * u;
    const bottom = hash(x0, y0 + 1) + (hash(x0 + 1, y0 + 1) - hash(x0, y0 + 1)) * u;
    return top + (bottom - top) * v;
}

/// When the front reaches a point, in DIPs from the card's top left.
function arrival(x, y) {
    const fromTop = y / HEIGHT;
    const py = HEIGHT - y;
    const broad = valueNoise(x / 46, py / 46) * 0.65 + valueNoise(x / 15 + 7.3, py / 15 + 2.1) * 0.35;
    return fromTop * 0.5 + broad * 0.2 + hash(Math.floor(x * 1.7), Math.floor(py * 1.7)) * 0.035;
}

const CrumbleEffect = GObject.registerClass(
class CrumbleEffect extends Shell.GLSLEffect {
    _init() {
        super._init();
        this._locations = ['elapsed', 'size_x', 'size_y'].map(name => this.get_uniform_location(name));
    }

    vfunc_build_pipeline() {
        this.add_glsl_snippet(Shell.SnippetHook.FRAGMENT, NOISE, FADE, false);
    }

    set(elapsed, width, height) {
        [elapsed, width, height].forEach((value, i) => this.set_uniform_float(this._locations[i], 1, [value]));
        this.queue_repaint();
    }
});

/// The card on screen until it has crumbled away. `handlers` has `scatter(pieces)` for the pieces of the card,
/// in stage pixels, `finished()`, and `skipped()`, called when the card can't crumble and just goes.
export class Welcome {
    constructor(app, handlers) {
        this._handlers = handlers;
        this._icon = null;
        try {
            this._icon = Cairo.ImageSurface.createFromPNG(`${app.path}/icons/snowhush.png`);
        } catch (error) {
            console.log(`Snowhush: welcome icon unavailable: ${error.message}`);
        }
        const interfaceSettings = new Gio.Settings({schema_id: 'org.gnome.desktop.interface'});
        this._family = Pango.FontDescription.from_string(interfaceSettings.get_string('font-name')).get_family() ?? 'Sans';
        this._pressed = false;
        this._holding = false;
        this._hovering = false;
        this._dragFrom = null;
        this._grab = null;
        this._timeline = null;
        this._button = [0, 0, 0, 0];

        this.actor = new St.DrawingArea({
            reactive: true,
            width: WIDTH + 2 * MARGIN,
            height: HEIGHT + 2 * MARGIN,
            accessible_name: 'Welcome to Snowhush',
        });
        this.actor.connect('repaint', area => {
            const cr = area.get_context();
            try {
                this._button = this._draw(cr, this._pressed);
            } finally {
                cr.$dispose();
            }
        });
        this.actor.connect('button-press-event', (actor, event) => this._press(event));
        this.actor.connect('motion-event', (actor, event) => this._motion(event));
        this.actor.connect('button-release-event', (actor, event) => this._release(event));
        this.actor.connect('leave-event', () => this._hover(false));

        // Centred on the display under the pointer.
        const monitor = global.display.get_current_monitor();
        const area = Main.layoutManager.getWorkAreaForMonitor(monitor);
        Main.layoutManager.addTopChrome(this.actor);
        this.actor.set_position(
            Math.round(area.x + (area.width - this.actor.width) / 2),
            Math.round(area.y + (area.height - this.actor.height) / 2));
    }

    destroy() {
        this._timeline?.stop();
        this._timeline = null;
        this._endGrab();
        if (this._hovering)
            global.display.set_cursor(Meta.Cursor.DEFAULT);
        if (this.actor) {
            Main.layoutManager.removeChrome(this.actor);
            this.actor.destroy();
            this.actor = null;
        }
    }

    /// Draws the card and returns where its button is, in DIPs from the top left.
    _draw(cr, pressed) {
        const card = [MARGIN, MARGIN, WIDTH, HEIGHT];
        cr.setOperator(Cairo.Operator.CLEAR);
        cr.paint();
        cr.setOperator(Cairo.Operator.OVER);

        // A soft shadow from stacked translucent outlines, lighter as they spread.
        cr.setSourceRGBA(0, 0, 0, 0.022);
        for (let step = 0; step < 16; step++) {
            const spread = step * 1.6;
            roundedRect(cr, card[0] - spread, card[1] - spread + 10, card[2] + 2 * spread, card[3] + 2 * spread, 18 + spread);
            cr.fill();
        }
        roundedRect(cr, card[0] + 0.5, card[1] + 0.5, card[2] - 1, card[3] - 1, 18);
        cr.setSourceRGBA(...BACKGROUND, 1);
        cr.fillPreserve();
        cr.setSourceRGBA(1, 1, 1, 0.08);
        cr.setLineWidth(1);
        cr.stroke();

        const textWidth = WIDTH - 64;
        const bodyWidth = Math.min(textWidth, 330);
        const title = this._layout(cr, TITLE, Pango.Weight.LIGHT, Pango.Stretch.CONDENSED, 34, textWidth, 34 * 1.13, 0.6);
        const body = this._layout(cr, BODY, Pango.Weight.NORMAL, Pango.Stretch.NORMAL, 13.5, bodyWidth, 23, 0);
        const label = this._layout(cr, BUTTON_LABEL, Pango.Weight.SEMIBOLD, Pango.Stretch.NORMAL, 12.5, BUTTON[0], 0, 1.8);
        const titleHeight = title.get_pixel_extents()[1].height;
        const bodyHeight = body.get_pixel_extents()[1].height;
        const labelHeight = label.get_pixel_extents()[1].height;

        const total = ICON_SIZE + 10 + titleHeight + 18 + bodyHeight + 28 + BUTTON[1];
        let y = card[1] + (HEIGHT - total) / 2;
        if (this._icon) {
            cr.save();
            cr.translate(card[0] + (WIDTH - ICON_SIZE) / 2, y);
            const scale = ICON_SIZE / this._icon.getWidth();
            cr.scale(scale, scale);
            cr.setSourceSurface(this._icon, 0, 0);
            cr.getSource().setFilter(Cairo.Filter.GOOD);
            cr.paint();
            cr.restore();
        }
        y += ICON_SIZE + 10;
        cr.setSourceRGBA(...INK, 1);
        cr.moveTo(card[0] + 32, y);
        PangoCairo.show_layout(cr, title);
        y += titleHeight + 18;
        cr.setSourceRGBA(...MUTED, 1);
        cr.moveTo(card[0] + (WIDTH - bodyWidth) / 2, y);
        PangoCairo.show_layout(cr, body);
        y += bodyHeight + 28;

        const left = card[0] + (WIDTH - BUTTON[0]) / 2;
        roundedRect(cr, left, y, BUTTON[0], BUTTON[1], 2);
        cr.setSourceRGBA(...INK.map(c => pressed ? c * 0.88 : c), 1);
        cr.fill();
        cr.setSourceRGBA(...LABEL, 1);
        cr.moveTo(left, y + (BUTTON[1] - labelHeight) / 2);
        PangoCairo.show_layout(cr, label);
        return [left, y, left + BUTTON[0], y + BUTTON[1]];
    }

    _layout(cr, text, weight, stretch, size, width, line, tracking) {
        const layout = PangoCairo.create_layout(cr);
        const font = Pango.FontDescription.from_string(this._family);
        font.set_weight(weight);
        font.set_stretch(stretch);
        font.set_absolute_size(size * Pango.SCALE);
        layout.set_font_description(font);
        layout.set_width(width * Pango.SCALE);
        layout.set_alignment(Pango.Alignment.CENTER);
        layout.set_text(text, -1);
        const attributes = new Pango.AttrList();
        if (tracking > 0)
            attributes.insert(Pango.attr_letter_spacing_new(tracking * Pango.SCALE));
        if (line > 0 && Pango.attr_line_height_new_absolute)
            attributes.insert(Pango.attr_line_height_new_absolute(line * Pango.SCALE));
        layout.set_attributes(attributes);
        return layout;
    }

    /// A point of an event in DIPs from the card's top left, and whether it is on the button.
    _point(event) {
        const [x, y] = event.get_coords();
        const [ok, localX, localY] = this.actor.transform_stage_point(x, y);
        const point = ok ? [localX, localY] : [-1, -1];
        const b = this._button;
        return [point, point[0] >= b[0] && point[0] < b[2] && point[1] >= b[1] && point[1] < b[3]];
    }

    _press(event) {
        if (this._timeline || event.get_button() !== Clutter.BUTTON_PRIMARY)
            return Clutter.EVENT_PROPAGATE;
        const [, over] = this._point(event);
        this._grab = global.stage.grab(this.actor);
        if (over) {
            this._holding = true;
            this._setPressed(true);
        } else {
            // The card drags anywhere but on the button.
            const [x, y] = event.get_coords();
            this._dragFrom = [x - this.actor.x, y - this.actor.y];
        }
        return Clutter.EVENT_STOP;
    }

    _motion(event) {
        const [, over] = this._point(event);
        if (this._dragFrom) {
            const [x, y] = event.get_coords();
            this.actor.set_position(Math.round(x - this._dragFrom[0]), Math.round(y - this._dragFrom[1]));
        } else if (this._holding) {
            this._setPressed(over);
        }
        this._hover(over && !this._dragFrom && !this._timeline);
        return Clutter.EVENT_STOP;
    }

    _release(event) {
        const [, over] = this._point(event);
        const clicked = this._holding && over;
        this._holding = false;
        this._dragFrom = null;
        this._endGrab();
        this._setPressed(false);
        if (clicked)
            this.getStarted();
        return Clutter.EVENT_STOP;
    }

    _hover(over) {
        if (over === this._hovering)
            return;
        this._hovering = over;
        global.display.set_cursor(over ? Meta.Cursor.POINTING_HAND : Meta.Cursor.DEFAULT);
    }

    _setPressed(pressed) {
        if (pressed === this._pressed || this._timeline)
            return;
        this._pressed = pressed;
        this.actor.queue_repaint();
    }

    _endGrab() {
        this._grab?.dismiss();
        this._grab = null;
    }

    getStarted() {
        if (this._timeline)
            return;
        this._hover(false);
        let cells;
        try {
            cells = this._cells();
        } catch (error) {
            console.log(`Snowhush: welcome can't crumble: ${error.message}`);
            this._finish(true);
            return;
        }
        let duration = 0;
        for (let y = 0; y <= HEIGHT; y += 2) {
            for (let x = 0; x <= WIDTH; x += 2)
                duration = Math.max(duration, arrival(x, y));
        }
        duration += FEATHER;

        const effect = new CrumbleEffect();
        this.actor.add_effect(effect);
        effect.set(0, this.actor.width, this.actor.height);
        let next = 0;
        this._timeline = new Clutter.Timeline({actor: this.actor, duration: Math.ceil(duration * 1000)});
        this._timeline.connect('new-frame', timeline => {
            const elapsed = timeline.get_elapsed_time() / 1000;
            effect.set(elapsed, this.actor.width, this.actor.height);
            const pieces = [];
            while (next < cells.length && cells[next].delay <= elapsed) {
                const cell = cells[next++];
                const outward = (cell.x - WIDTH / 2) / WIDTH;
                pieces.push({
                    x: this.actor.x + MARGIN + cell.x,
                    y: this.actor.y + MARGIN + cell.y,
                    vx: outward * 140 + Math.random() * 140 - 70,
                    vy: 30 + Math.random() * 120,
                    color: cell.color,
                });
            }
            if (pieces.length > 0)
                this._handlers.scatter(pieces);
        });
        this._timeline.connect('completed', () => this._finish(false));
        this._timeline.start();
    }

    /// The card's colours every few DIPs, where the card is, in the order the front reaches them.
    _cells() {
        const width = WIDTH + 2 * MARGIN;
        const height = HEIGHT + 2 * MARGIN;
        const surface = new Cairo.ImageSurface(Cairo.Format.ARGB32, width, height);
        const cr = new Cairo.Context(surface);
        this._draw(cr, false);
        cr.$dispose();
        // Cairo's pixels can't be read from JavaScript, so they go through a PNG.
        const [file, stream] = Gio.File.new_tmp('snowhush-welcome-XXXXXX.png');
        stream.close(null);
        let pixbuf;
        try {
            surface.writeToPNG(file.get_path());
            pixbuf = GdkPixbuf.Pixbuf.new_from_file(file.get_path());
        } finally {
            file.delete(null);
        }
        const pixels = pixbuf.get_pixels();
        const stride = pixbuf.get_rowstride();
        const channels = pixbuf.get_n_channels();
        const cells = [];
        for (let y = CELL / 2; y < HEIGHT; y += CELL) {
            for (let x = CELL / 2; x < WIDTH; x += CELL) {
                const i = Math.floor(MARGIN + y) * stride + Math.floor(MARGIN + x) * channels;
                if (channels === 4 && pixels[i + 3] <= 25)
                    continue;
                cells.push({x, y, color: [pixels[i] / 255, pixels[i + 1] / 255, pixels[i + 2] / 255], delay: arrival(x, y)});
            }
        }
        cells.sort((a, b) => a.delay - b.delay);
        return cells;
    }

    _finish(skipped) {
        const handlers = this._handlers;
        this._handlers = null;
        // Tearing down from inside the timeline's own signal is left to the next idle.
        GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
            this.destroy();
            return GLib.SOURCE_REMOVE;
        });
        if (!handlers)
            return;
        if (skipped)
            handlers.skipped();
        handlers.finished();
    }
}

function roundedRect(cr, x, y, width, height, radius) {
    const r = Math.min(radius, width / 2, height / 2);
    cr.newSubPath();
    cr.arc(x + width - r, y + r, r, -Math.PI / 2, 0);
    cr.arc(x + width - r, y + height - r, r, 0, Math.PI / 2);
    cr.arc(x + r, y + height - r, r, Math.PI / 2, Math.PI);
    cr.arc(x + r, y + r, r, Math.PI, 1.5 * Math.PI);
    cr.closePath();
}
