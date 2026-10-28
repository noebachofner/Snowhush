// The windows on screen for the snow to settle on, from Mutter: the GNOME counterpart of windows/src/tracker.rs.

import GLib from 'gi://GLib';
import Meta from 'gi://Meta';

/// Menus, tooltips, notifications and the like hide snow behind them but don't collect any.
const COVER_ONLY = new Set([
    Meta.WindowType.DROPDOWN_MENU,
    Meta.WindowType.POPUP_MENU,
    Meta.WindowType.TOOLTIP,
    Meta.WindowType.NOTIFICATION,
    Meta.WindowType.COMBO,
    Meta.WindowType.DND,
    Meta.WindowType.MENU,
    Meta.WindowType.OVERRIDE_OTHER,
]);

/// The desktop and docks are never surfaces, nor anything in front of the snow.
const IGNORED = new Set([Meta.WindowType.DESKTOP, Meta.WindowType.DOCK]);

/// GTK and libadwaita round a window's top corners to about this many pixels; maximized and tiled windows stay square.
const CORNER_RADIUS = 12;

/// Whether a window is one of the shell's popups, menus or tooltips, which stay in front of the snow.
export function isPopup(window) {
    return COVER_ONLY.has(window.get_window_type()) || window.is_override_redirect();
}

/// The windows on screen, front to back, re-read when Mutter reports a window moving, showing, hiding, minimizing
/// or changing workspaces, and twice a second in case a report went missing.
export class Tracker {
    constructor() {
        this.generation = 0;
        this.listings = 0;
        this.cost = 0;
        this._windows = [];
        this._changed = true;
        this._moving = false;
        this._startedMoving = false;
        this._listedAt = 0;
        this._watched = new Map();
        this._signals = [];
        this._track(global.display, 'window-created', (display, window) => {
            this._watch(window);
            this._changed = true;
        });
        this._track(global.display, 'restacked', () => (this._changed = true));
        this._track(global.display, 'grab-op-begin', (display, window, op) => {
            // Every grab that moves or resizes a window has the window bit; others only hold the pointer.
            if (op & Meta.GrabOp.WINDOW_BASE) {
                this._moving = true;
                this._startedMoving = true;
            }
            this._changed = true;
        });
        this._track(global.display, 'grab-op-end', () => {
            this._moving = false;
            this._changed = true;
        });
        this._track(global.workspace_manager, 'active-workspace-changed', () => (this._changed = true));
        for (const actor of global.get_window_actors())
            this._watch(actor.meta_window);
    }

    destroy() {
        for (const [object, id] of this._signals)
            object.disconnect(id);
        this._signals = [];
        for (const [window, ids] of this._watched) {
            for (const id of ids)
                window.disconnect(id);
        }
        this._watched.clear();
    }

    /// Re-reads the window list if anything may have changed; returns whether it did.
    refresh(now) {
        if (!this._changed && now - this._listedAt < 500000)
            return false;
        this._changed = false;
        const began = GLib.get_monotonic_time();
        this._windows = this._list();
        this.cost += GLib.get_monotonic_time() - began;
        this.listings++;
        this._listedAt = now;
        this.generation++;
        return true;
    }

    /// Whether a window is being dragged or resized right now.
    moving() {
        return this._moving;
    }

    /// Whether a drag or resize started since the last call.
    takeStartedMoving() {
        const started = this._startedMoving;
        this._startedMoving = false;
        return started;
    }

    /// The windows on one display that snow can settle on, in its overlay coordinates.
    /// `area` is the display's work area in stage pixels, `unit` the stage pixels per overlay DIP.
    surfaces(area, unit) {
        const width = area.width / unit;
        const height = area.height / unit;
        const blockers = [];
        const surfaces = [];
        for (const window of this._windows) {
            const r = window.rect;
            if (r.x + r.width <= area.x || r.x >= area.x + area.width || r.y + r.height <= area.y || r.y >= area.y + area.height)
                continue;
            const frame = {
                x: (r.x - area.x) / unit,
                y: (area.y + area.height - (r.y + r.height)) / unit,
                width: r.width / unit,
                height: r.height / unit,
            };
            const roomAbove = (r.y - area.y) / unit >= 6 && frame.y + frame.height < height;
            const onScreen = frame.x + frame.width > 0 && frame.x < width && frame.y + frame.height > 0;
            const fillsScreen = frame.width * frame.height >= width * height * 0.9;
            if (roomAbove && onScreen && !fillsScreen && !window.coverOnly && frame.width >= 80 && frame.height >= 40) {
                const radius = Math.min(window.radius, frame.width / 2, frame.height / 2);
                const region = {x: frame.x, y: frame.y + frame.height - radius, width: frame.width, height: 40 + radius};
                surfaces.push({
                    id: window.id,
                    frame,
                    blockers: blockers.filter(b => intersects(b, region)),
                    cornerRadius: radius,
                    cornerExponent: 2,
                });
            }
            blockers.push(frame);
        }
        return surfaces;
    }

    /// Whether a window that left the list moved to another workspace, rather than closing, hiding or minimizing.
    elsewhere(id) {
        const window = this._find(id);
        // Mutter hides windows on other workspaces, so being hidden says nothing here; being minimized does.
        if (!window || window.minimized || !window.showing_on_its_workspace())
            return false;
        const active = global.workspace_manager.get_active_workspace();
        return !window.located_on_workspace(active);
    }

    /// Whether a window covers most of this work area, in stage pixels, as when maximized or full screen.
    fills(id, area) {
        const window = this._find(id);
        if (!window || window.minimized)
            return false;
        const r = window.get_frame_rect();
        const width = Math.max(Math.min(r.x + r.width, area.x + area.width) - Math.max(r.x, area.x), 0);
        const height = Math.max(Math.min(r.y + r.height, area.y + area.height) - Math.max(r.y, area.y), 0);
        return width * height * 10 >= area.width * area.height * 9;
    }

    _find(id) {
        for (const window of this._watched.keys()) {
            if (window.get_id() === id)
                return window;
        }
        return null;
    }

    _list() {
        const active = global.workspace_manager.get_active_workspace();
        const windows = global.display.sort_windows_by_stacking(global.display.list_all_windows());
        const result = [];
        for (let i = windows.length - 1; i >= 0; i--) {
            const window = windows[i];
            const type = window.get_window_type();
            if (IGNORED.has(type) || window.minimized || window.is_hidden() || !window.showing_on_its_workspace())
                continue;
            if (!window.located_on_workspace(active) && !window.is_override_redirect())
                continue;
            // Desktop icons draw into an ordinary window the size of the desktop, kept under everything else.
            if (isDesktopIcons(window))
                continue;
            const actor = window.get_compositor_private();
            if (!actor || !actor.visible || actor.opacity === 0)
                continue;
            const rect = window.get_frame_rect();
            if (rect.width < 2 || rect.height < 2)
                continue;
            const square = window.get_maximized() !== 0 || window.is_fullscreen();
            result.push({
                id: window.get_id(),
                rect: {x: rect.x, y: rect.y, width: rect.width, height: rect.height},
                radius: square ? 0 : CORNER_RADIUS,
                coverOnly: isPopup(window),
            });
        }
        return result;
    }

    _watch(window) {
        if (this._watched.has(window))
            return;
        const changed = () => (this._changed = true);
        const ids = [
            window.connect('position-changed', changed),
            window.connect('size-changed', changed),
            window.connect('notify::minimized', changed),
            window.connect('workspace-changed', changed),
            window.connect('notify::fullscreen', changed),
            window.connect('shown', changed),
            window.connect('unmanaged', () => {
                const watched = this._watched.get(window);
                this._watched.delete(window);
                for (const id of watched ?? [])
                    window.disconnect(id);
                this._changed = true;
            }),
        ];
        this._watched.set(window, ids);
    }

    _track(object, signal, handler) {
        this._signals.push([object, object.connect(signal, handler)]);
    }
}

/// The desktop icons extensions (Desktop Icons NG and Zorin's own) mark their windows with a title starting "@!".
function isDesktopIcons(window) {
    return (window.get_title() ?? '').startsWith('@!') && window.is_skip_taskbar();
}

function intersects(a, b) {
    return a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
}
