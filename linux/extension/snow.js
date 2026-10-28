// The snow on every display: the GNOME counterpart of windows/src/snow.rs and screen.rs.
// Each display has its own simulation and actor, stepped in time with that display's frames.

import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import Meta from 'gi://Meta';
import Shell from 'gi://Shell';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import {daylight, Wallpaper} from './light.js';
import {SnowActor} from './renderer.js';
import {Pace, SnowSimulation} from './simulation.js';
import {PowerBudget, SystemState} from './system.js';
import {Tracker} from './tracker.js';

const SECOND = 1000000;
const NONE = new Set();
/// The screenshot calls that paint the stage, which keep the snow out unless it is to be shown in screenshots.
const CAPTURES = ['screenshot', 'screenshot_area', 'screenshot_stage_to_content', 'pick_color'];

/// The snow on one display: its actor, its simulation and when it is next due.
class Screen {
    /// `makeSimulation` makes the simulation for a display of a given width and height in DIPs.
    constructor(snow, index, makeSimulation) {
        this.index = index;
        this.nextDue = 0;
        this.actor = new SnowActor();
        this.actor.clip_to_allocation = true;
        this._snow = snow;
        this._lastStep = 0;
        this._lastTick = 0;
        /// The display's frame interval, measured from the frame clock's ticks.
        this._period = SECOND / 60;
        this._idleFrames = 0;
        this._surfaces = [];
        this._windowsSeen = 0;
        this._windowsChangedAt = 0;
        this._covered = false;
        this._timeline = null;
        /// Nothing falls and nothing lies anywhere, so nothing needs drawing until something changes.
        this.idle = false;
        this.place();
        this.simulation = makeSimulation(...this.dipSize());
    }

    destroy() {
        this.stop();
        this.actor.destroy();
    }

    /// Fits the actor to the display's work area: the taskbar is the ground the snow settles on, so it is left out.
    place() {
        const index = this.index;
        this.monitor = Main.layoutManager.monitors[index];
        this.area = Main.layoutManager.getWorkAreaForMonitor(index);
        // On Wayland the stage is laid out in logical pixels already; on X11 it is in device pixels.
        this.unit = Meta.is_wayland_compositor() ? 1 : global.display.get_monitor_scale(index);
        this.actor.set_position(this.area.x, this.area.y);
        this.actor.set_size(this.area.width, this.area.height);
    }

    dipSize() {
        return [this.area.width / this.unit, this.area.height / this.unit];
    }

    start() {
        if (this._timeline || this._covered || this.idle)
            return;
        this.resume();
        this._timeline = new Clutter.Timeline({actor: this.actor, duration: 3600 * 1000, repeat_count: -1});
        this._timeline.connect('new-frame', () => this._tick());
        this._timeline.start();
    }

    stop() {
        this._timeline?.stop();
        this._timeline = null;
    }

    resume() {
        this._lastStep = 0;
        this._lastTick = 0;
        this.nextDue = 0;
    }

    wake(now) {
        this.nextDue = Math.min(this.nextDue, now);
        if (this.idle) {
            this.idle = false;
            this._snow.updateVisibility();
        }
    }

    get covered() {
        return this._covered;
    }

    /// Hides and stops the snow while a full-screen app covers the display.
    setCovered(covered) {
        if (covered === this._covered)
            return;
        this._covered = covered;
        if (covered)
            this.stop();
        this._snow.updateVisibility();
    }

    _tick() {
        const now = GLib.get_monotonic_time();
        if (this._lastTick) {
            const interval = now - this._lastTick;
            if (interval > SECOND / 400 && interval < SECOND / 20)
                this._period += (interval - this._period) * 0.1;
        }
        this._lastTick = now;
        if (now + this._period / 4 < this.nextDue)
            return;
        this._snow.frame(this, now);
    }

    /// Steps the snow and draws it if anything visible changed; returns whether it drew.
    /// `windows` is left out while snow on windows is off.
    frame(now, budget, scene, windows) {
        const dt = this._lastStep ? Math.min((now - this._lastStep) / SECOND, 0.05) : 1 / 60;
        this._lastStep = now;
        if (windows)
            this._follow(windows, now);
        const [x, y] = global.get_pointer();
        const changed = this.simulation.step(dt, (x - this.area.x) / this.unit, (this.area.y + this.area.height - y) / this.unit);

        const refresh = SECOND / this._period;
        const interactive = Math.min(Math.max(refresh, 60), 120);
        const fastest = budget === PowerBudget.FULL ? interactive : Math.min(interactive, 60);
        // 24 only where it divides the display's rate evenly; elsewhere it would judder.
        const calm = budget === PowerBudget.SAVER && Math.round(refresh) % 24 === 0 ? 24 : 30;
        let rate = calm;
        if (this.simulation.pace() === Pace.LIVELY)
            rate = Math.min(fastest, 60);
        else if (this.simulation.pace() === Pace.INTERACTIVE)
            rate = fastest;
        const frames = Math.max(Math.round(refresh / rate), 1);
        this.nextDue = now + frames * this._period - this._period / 2;
        this._idleFrames = changed ? 0 : this._idleFrames + 1;
        if (!changed && this.simulation.spriteCount() === 0 && !this.simulation.hasSnow() && this.simulation.pace() === Pace.CALM &&
            !this.simulation.falling()) {
            this.idle = true;
            this.actor.clear();
            this.stop();
            return false;
        }
        // A still pile only needs a slow refresh for its glints.
        if (!(changed || (this.simulation.hasSnow() && this._idleFrames % 2 === 0)))
            return false;
        this.actor.update(this.simulation, {unit: this.unit, ...scene});
        return true;
    }

    /// Hands the simulation the windows on this display when they changed.
    _follow(tracker, now) {
        if (tracker.generation === this._windowsSeen)
            return;
        this._windowsSeen = tracker.generation;
        const surfaces = tracker.surfaces(this.area, this.unit);
        if (sameSurfaces(surfaces, this._surfaces))
            return;
        const since = (now - this._windowsChangedAt) / SECOND;
        // A window that moves outside a drag, as when it is maximized or snapped, jumps there in one go:
        // its snow is left behind instead of being carried along.
        const interval = tracker.moving() || since < 0.1 ? Math.min(since, 0.25) : 1 / 60;
        // Snow waits for a window gone to another workspace, or maximized or full screen and so without room for it.
        const elsewhere = new Set(this._surfaces.map(surface => surface.id)
            .filter(id => !surfaces.some(surface => surface.id === id) && (tracker.elsewhere(id) || tracker.fills(id, this.area))));
        this.simulation.updateWindows(surfaces, interval, NONE, elsewhere, false);
        this._surfaces = surfaces;
        this._windowsChangedAt = now;
    }

    dropWindowSnow() {
        this.simulation.updateWindows([], 0.1, NONE, NONE, false);
        this._surfaces = [];
        this._windowsSeen = 0;
    }

    /// Whether a point in stage pixels is on this display.
    contains(x, y) {
        const m = this.monitor;
        return x >= m.x && x < m.x + m.width && y >= m.y && y < m.y + m.height;
    }

    /// A point in stage pixels in overlay coordinates: DIPs up from the bottom left of this display's work area.
    local(x, y) {
        return [(x - this.area.x) / this.unit, (this.area.y + this.area.height - y) / this.unit];
    }
}

/// The snow on all displays, set up from `settings` (the extension's GSettings) and kept in step with them.
export class Snow {
    constructor(settings) {
        this._settings = settings;
        this._screens = [];
        this._signals = [];
        this._started = GLib.get_monotonic_time();
        this._light = daylight();
        this._lightAt = 0;
        this._capturing = 0;
        this._snowfallHeld = !settings.get_boolean('welcomed');
        this.stats = new Stats(this._started);
        this._tracker = new Tracker();
        this._system = new SystemState(() => this._systemChanged());
        this._wallpaper = new Wallpaper(() => {
            for (const screen of this._screens)
                screen.wake(0);
        });
        this._budget = this._system.budget;
        this._read();

        this._track(Main.layoutManager, 'monitors-changed', () => this._syncScreens());
        this._track(global.display, 'workareas-changed', () => this._syncScreens());
        this._track(global.display, 'in-fullscreen-changed', () => this._updateCovered());
        this._track(global.workspace_manager, 'active-workspace-changed', () => {
            for (const screen of this._screens)
                screen.simulation.spaceChanged();
        });
        this._track(global.window_group, 'child-added', () => this._restack());
        this._track(Main.layoutManager._backgroundGroup, 'child-added', () => this._restack());
        this._track(this._settings, 'changed', (settings, key) => this._settingChanged(key));
        this._patchScreenshots();

        this._syncScreens();
        this._systemChanged();
    }

    destroy() {
        this._unpatchScreenshots();
        for (const [object, id] of this._signals)
            object.disconnect(id);
        this._signals = [];
        for (const screen of this._screens)
            screen.destroy();
        this._screens = [];
        this._tracker.destroy();
        this._system.destroy();
        this._wallpaper.destroy();
    }

    /// Whether there is any snow to clear, lying or in the air.
    hasSnow() {
        return this._screens.some(screen => screen.simulation.hasSnow() || screen.simulation.spriteCount() > 0);
    }

    /// Blows all the snow away; for less motion, melts it where it lies instead.
    clear() {
        const direction = this._screens[0]?.simulation.breezeDirection() ?? -1;
        const calm = this._system.calm;
        for (const screen of this._screens) {
            screen.simulation.blowAway(direction, calm);
            screen.wake(0);
        }
    }

    /// Lets the pieces of something crumbling, in stage pixels, fall as snow on the display they are over.
    scatter(pieces) {
        if (pieces.length === 0)
            return;
        const screen = this._screens.find(candidate => candidate.contains(pieces[0].x, pieces[0].y)) ?? this._screens[0];
        if (!screen)
            return;
        screen.simulation.scatter(pieces.map(piece => {
            const [x, y] = screen.local(piece.x, piece.y);
            return {x, y, vx: piece.vx, vy: piece.vy, color: piece.color};
        }));
        screen.wake(0);
    }

    /// Starts the snowfall held back for the welcome window.
    releaseSnowfall() {
        this._snowfallHeld = false;
        for (const screen of this._screens) {
            screen.simulation.setSnowfallHeld(false);
            screen.wake(0);
        }
    }

    /// Steps and draws one display; called by its frame clock when the display is due.
    frame(screen, now) {
        const began = GLib.get_monotonic_time();
        // A drag starting is drawn right away instead of at the next calm frame.
        if (this._tracker.takeStartedMoving() && this._snowOnWindows) {
            for (const other of this._screens)
                other.wake(now);
        }
        this._tracker.refresh(now);
        if (now >= this._lightAt) {
            this._lightAt = now + 60 * SECOND;
            this._light = daylight();
        }
        const windows = this._snowOnWindows && !this._behindWindows ? this._tracker : null;
        const scene = {
            time: (now - this._started) / SECOND % 1000,
            light: this._light,
            shadowTint: this._wallpaper.tint,
        };
        const drew = screen.frame(now, this._budget, scene, windows);
        // The first display the welcome window's snow reaches starts the snowfall on all of them.
        if (screen.simulation.takeSnowfallReleased())
            this.releaseSnowfall();
        this.stats.frame(drew, GLib.get_monotonic_time() - began, screen.simulation.spriteCount(), this._tracker, this._screens);
    }

    /// Shows the snow where it may be seen, and runs it only there.
    updateVisibility() {
        const system = this._system;
        const active = !system.locked && !system.asleep && !system.overview && !(system.sharing && !this._showInScreenshots);
        for (const screen of this._screens) {
            const shown = active && !screen.covered && this._capturing === 0;
            screen.actor.visible = shown;
            if (active && !screen.covered)
                screen.start();
            else
                screen.stop();
        }
    }

    _read() {
        const settings = this._settings;
        this._snowfall = settings.get_string('snowfall');
        // Until a snowfall is picked, someone who prefers less motion gets a light one.
        if (settings.get_user_value('snowfall') === null && this._system.calm)
            this._snowfall = 'light';
        this._accumulate = settings.get_boolean('accumulate');
        this._melt = settings.get_boolean('melt-snow');
        this._snowOnWindows = settings.get_boolean('snow-on-windows');
        this._behindWindows = settings.get_boolean('behind-windows');
        this._showInScreenshots = settings.get_boolean('show-in-screenshots');
    }

    _settingChanged(key) {
        const wasOnWindows = this._snowOnWindows;
        const wasBehind = this._behindWindows;
        this._read();
        for (const screen of this._screens) {
            const simulation = screen.simulation;
            simulation.setSnowfall(this._snowfall);
            simulation.accumulates = this._accumulate;
            simulation.thaws = this._melt;
            if ((wasOnWindows && !this._snowOnWindows) || (!wasBehind && this._behindWindows))
                screen.dropWindowSnow();
            screen.wake(0);
        }
        if (key === 'behind-windows')
            this._restack();
        if (key === 'show-in-screenshots')
            this.updateVisibility();
    }

    _systemChanged() {
        const budget = this._system.budget;
        if (budget !== this._budget) {
            this._budget = budget;
            const density = budget === PowerBudget.SAVER ? 0.75 : 1;
            for (const screen of this._screens) {
                screen.simulation.setDensity(density);
                screen.wake(0);
            }
        }
        this.updateVisibility();
    }

    /// One simulation per display: new displays get snow, removed ones lose theirs, and a display that changed
    /// size keeps its snow.
    _syncScreens() {
        const monitors = Main.layoutManager.monitors;
        while (this._screens.length > monitors.length)
            this._screens.pop().destroy();
        for (let index = 0; index < monitors.length; index++) {
            let screen = this._screens[index];
            if (screen) {
                screen.place();
                const [width, height] = screen.dipSize();
                screen.simulation.resize(width, height);
            } else {
                screen = new Screen(this, index, (width, height) => this._newSimulation(width, height));
                this._screens.push(screen);
            }
        }
        for (const screen of this._screens)
            screen.simulation.walls = walls(screen, this._screens);
        this._restack();
        this._updateCovered();
        this.updateVisibility();
    }

    _newSimulation(width, height) {
        const simulation = new SnowSimulation(width, height, this._snowfall);
        simulation.thaws = this._melt;
        simulation.accumulates = this._accumulate;
        simulation.setSnowfallHeld(this._snowfallHeld);
        if (this._budget === PowerBudget.SAVER)
            simulation.setDensity(0.75);
        return simulation;
    }

    _updateCovered() {
        for (const screen of this._screens)
            screen.setCovered(global.display.get_monitor_in_fullscreen(screen.index));
    }

    /// Over windows, the snow is the top of the window layer: above every window, under the shell's panels and
    /// menus and the apps' popups, which Mutter keeps in a layer above. Behind windows, it is the top of the
    /// background layer, under every window and the desktop icons.
    _restack() {
        const background = Main.layoutManager._backgroundGroup;
        const parent = this._behindWindows ? background : global.window_group;
        let moved = false;
        for (const screen of this._screens) {
            const actor = screen.actor;
            if (actor.get_parent() !== parent) {
                // A frame clock can't follow an actor off the stage, so its timeline stops while it moves.
                screen.stop();
                actor.get_parent()?.remove_child(actor);
                parent.add_child(actor);
                moved = true;
            }
            if (parent.get_last_child() !== actor)
                parent.set_child_above_sibling(actor, null);
        }
        if (moved)
            this.updateVisibility();
    }

    /// Keeps the snow out of screenshots unless it is to be shown in them. On Wayland the stage is painted for the
    /// screenshot during the call itself; on X11 it is painted afterwards, so the snow stays hidden until it is taken.
    _patchScreenshots() {
        const proto = Shell.Screenshot.prototype;
        this._originals = {};
        for (const name of CAPTURES) {
            const original = proto[name];
            if (typeof original !== 'function')
                continue;
            this._originals[name] = original;
            const snow = this;
            proto[name] = function (...args) {
                return snow._capture(() => original.apply(this, args));
            };
        }
    }

    _unpatchScreenshots() {
        const proto = Shell.Screenshot.prototype;
        for (const [name, original] of Object.entries(this._originals ?? {}))
            proto[name] = original;
        this._originals = {};
    }

    _capture(call) {
        if (this._showInScreenshots || this._screens.length === 0)
            return call();
        this._capturing++;
        this.updateVisibility();
        let restored = false;
        const restore = () => {
            if (restored)
                return;
            restored = true;
            this._capturing--;
            this.updateVisibility();
        };
        let result;
        try {
            result = call();
        } catch (error) {
            restore();
            throw error;
        }
        if (Meta.is_wayland_compositor() || !(result instanceof Promise))
            restore();
        else
            result.then(restore, restore);
        return result;
    }

    _track(object, signal, handler) {
        this._signals.push([object, object.connect(signal, handler)]);
    }
}

/// Which side edges of a display's work area, left and right, have no display past them, so snow heaps up against them.
function walls(screen, screens) {
    const area = screen.area;
    const bounds = screen.monitor;
    const beside = x => screens.some(other => {
        const o = other.monitor;
        return other !== screen && o.y < bounds.y + bounds.height && o.y + o.height > bounds.y &&
            (o.x + o.width === x || o.x === x);
    });
    // A panel along a side stands between the snow and any display past it.
    return [
        area.x !== bounds.x || !beside(bounds.x),
        area.x + area.width !== bounds.x + bounds.width || !beside(bounds.x + bounds.width),
    ];
}

function sameSurfaces(a, b) {
    if (a.length !== b.length)
        return false;
    for (let i = 0; i < a.length; i++) {
        const x = a[i];
        const y = b[i];
        if (x.id !== y.id || x.cornerRadius !== y.cornerRadius || !sameRect(x.frame, y.frame) || x.blockers.length !== y.blockers.length)
            return false;
        for (let k = 0; k < x.blockers.length; k++) {
            if (!sameRect(x.blockers[k], y.blockers[k]))
                return false;
        }
    }
    return true;
}

function sameRect(a, b) {
    return a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height;
}

/// What a frame costs, for checking that the snow stays light.
class Stats {
    constructor(now) {
        this.reset(now);
        this.last = '';
    }

    reset(now) {
        this.since = now;
        this.steps = 0;
        this.draws = 0;
        this.busy = 0;
        this.sprites = 0;
    }

    frame(drew, busy, sprites, tracker, screens) {
        this.steps++;
        this.draws += drew ? 1 : 0;
        this.busy += busy;
        this.sprites = Math.max(this.sprites, sprites);
        const now = GLib.get_monotonic_time();
        const elapsed = (now - this.since) / SECOND;
        if (elapsed < 10)
            return;
        let paint = 0;
        for (const screen of screens) {
            paint += screen.actor.paintCost;
            screen.actor.paintCost = 0;
        }
        const busySeconds = (this.busy + tracker.cost + paint) / SECOND;
        this.last = `${(this.steps / elapsed).toFixed(1)} steps/s, ${(this.draws / elapsed).toFixed(1)} draws/s, ` +
            `${(this.busy / Math.max(this.steps, 1)).toFixed(0)} µs per step, ${(paint / Math.max(this.draws, 1)).toFixed(0)} µs per paint, ` +
            `${(busySeconds / elapsed * 100).toFixed(2)}% of a core, ` +
            `up to ${this.sprites} sprites; windows: ${(tracker.listings / elapsed).toFixed(1)} reads/s`;
        tracker.listings = 0;
        tracker.cost = 0;
        this.reset(now);
    }
}
