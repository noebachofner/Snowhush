// A port of windows/src/simulation.rs, kept close to it so the two can be compared side by side.
// Coordinates are DIPs in the overlay: x to the right, y up from the bottom of the display's work area.
// Positions and velocities are split into x and y fields, so stepping the snow allocates next to nothing.

import {SnowLayer} from './layer.js';

export const COLUMN_WIDTH = 2;
const GROUND_DEPTH = 40;
const LEDGE_DEPTH = 14;
const THAW_DEPTH = 8;
const LEDGE_THAW_DEPTH = 4;
const THAW_RATE = 0.02;
const THAW_TIME = 30;
const THAW_BALANCE = 184;
const THAW_EXPONENT = 0.74;
const DEPOSITION = 1.1;
const REPOSE = 0.8;
const ROUNDING = 0.15;
const CURSOR_RADIUS = 10;
const CURSOR_OFFSET_X = 4;
const CURSOR_OFFSET_Y = -8;
const GRAVITY = 2500;
const GRAIN_DRAG = 0.8;
const MAX_GRAINS = 12000;
const PHASE_WRAP = 20 * Math.PI;
const TAU = 2 * Math.PI;
const LEDGE_INSET = 0;
const GRIP = 3;
const SLIP = 2;
const BREAK_LIFT = 10;
/// Snow sticks to a window: it only lets go when pulled away harder than this, on top of its weight.
const ADHESION = 3500;
const SHAKING = 4;
const JUMP_SPEED = 6000;
const TRACK_TIME = 0.06;
const MAX_MOTES = 1500;
const GUST_SWEEP = 0.6;
const GUST_LENGTH = 2.2;
const GUST_WIND = 1000;
/// The snowfall is caught this long after the drifts, so it trails behind their powder.
const GUST_LAG = 0.3;
/// Snow a wall scrapes up packs down to this share of its fresh bulk.
const PACKING = 0.6;

/// Floats per sprite vertex: position, velocity, size, alpha, soft, lump, tint (rgb), tint amount and the corner.
export const SPRITE_FLOATS = 13;

export const Snowfall = Object.freeze({
    OFF: 'off',
    LIGHT: 'light',
    STEADY: 'steady',
    HEAVY: 'heavy',
    VARIABLE: 'variable',
});

export const SNOWFALLS = [Snowfall.OFF, Snowfall.LIGHT, Snowfall.STEADY, Snowfall.HEAVY, Snowfall.VARIABLE];

export function snowfallTitle(snowfall) {
    return {off: 'Off', light: 'Light', steady: 'Steady', heavy: 'Heavy', variable: 'Variable'}[snowfall] ?? 'Steady';
}

function flakesPerMegapoint(snowfall) {
    switch (snowfall) {
    case Snowfall.LIGHT: return 150;
    case Snowfall.STEADY: return 380;
    case Snowfall.HEAVY: return 800;
    case Snowfall.VARIABLE: return 380;
    default: return 0;
    }
}

/// How briskly the scene changes, which sets how often it is drawn.
export const Pace = Object.freeze({
    /// Only snowfall and slow drifts: a low frame rate is indistinguishable.
    CALM: 'calm',
    /// Loose snow in flight.
    LIVELY: 'lively',
    /// The cursor or a window is pushing snow around: drawn as often as the display allows.
    INTERACTIVE: 'interactive',
});

const clamp = (x, low, high) => Math.min(Math.max(x, low), high);

export function smoothstep(edge0, edge1, x) {
    const t = clamp((x - edge0) / (edge1 - edge0), 0, 1);
    return t * t * (3 - 2 * t);
}

const random = () => Math.random();
const range = (lower, upper) => lower + (upper - lower) * Math.random();

/// The whole-number part of a coordinate, toward minus infinity, as the Rust port's `floor() as i64`.
const ifloor = Math.floor;

/// A window's frame in overlay coordinates: `x` and `y` are its bottom left corner.
/// `blockers` are the frames of windows in front of it.
/// { id, frame: {x, y, width, height}, blockers: [{x, y, width, height}], cornerRadius, cornerExponent }

/// Everything but the layers, so a layer can be handed to it alongside.
class Air {
    constructor() {
        this.flakes = [];
        this.grains = [];
        this.motes = [];
        this.clock = 0;
        this.strength = 1;
        this.cursor = null;
        this.cursorVX = 0;
        this.cursorVY = 0;
        this.heldLayers = [];
        this.heightsChanged = false;
        this.windowsChanged = false;
        this.lastWindowMotion = -10;
        this.lastCursorPush = -10;
        /// Snow released while the air is full, laid straight onto the ground at the end of the step, as [area, x] pairs.
        this.overflow = [];
        this.gust = null;
    }

    /// Carries snow along with a window that the whole desktop is sliding past: nothing pushes the snow, so it doesn't react.
    pan(ledge, left, top) {
        const dx = left - ledge.originX;
        const dy = top - ledge.originY;
        if (dx === 0 && dy === 0)
            return;
        ledge.originX += dx;
        ledge.originY += dy;
        ledge.trackX += dx;
        ledge.trackY += dy;
        ledge.previousBaseY = ledge.baseY();
        if (ledge.top > 0.05) {
            this.lastWindowMotion = this.clock;
            this.windowsChanged = true;
        }
    }

    moveLedge(ledge, left, top, columns, interval) {
        const oldLeft = ledge.originX;
        const newRight = left + columns * COLUMN_WIDTH;
        const oldRight = oldLeft + ledge.width();
        // A resize keeps the edge that didn't move fixed; a plain move shifts both edges alike.
        const shift = Math.abs(left - oldLeft) <= Math.abs(newRight - oldRight) ? left - oldLeft : newRight - oldRight;
        const displacementX = shift;
        const displacementY = top - ledge.originY;
        const resized = columns !== ledge.count() || Math.abs(left - oldLeft - shift) > 0.5;
        if (displacementX === 0 && displacementY === 0 && !resized)
            return;

        const elapsed = Math.max(interval, 1 / 120);
        // Only a motion that began unobserved, between slow polls, has to be picked up mid-flight.
        const wasResting = this.clock - ledge.movedAt > 0.3 && interval > 0.05;
        ledge.movedAt = this.clock;
        if (ledge.top > 0.05) {
            this.lastWindowMotion = this.clock;
            this.windowsChanged = true;
        }

        const jumped = Math.hypot(displacementX, displacementY) / elapsed > JUMP_SPEED;
        if (jumped) {
            // The window vanished from under the snow and reappeared elsewhere: nothing carried the snow along.
            this.shed(ledge, 1, 0, 0);
            ledge.offsetX = 0;
            ledge.offsetY = 0;
            ledge.offsetVX = 0;
            ledge.offsetVY = 0;
            ledge.trackVX = 0;
            ledge.trackVY = 0;
        }

        if (resized) {
            const fresh = new Float64Array(columns);
            for (let i = 0; i < ledge.count(); i++) {
                const h = ledge.heights[i];
                if (h <= 0)
                    continue;
                const j = Math.floor((ledge.centerX(i) + shift - left - ledge.offsetX) / COLUMN_WIDTH);
                if (j >= 0 && j < columns) {
                    fresh[j] += h;
                } else {
                    this.release(h * COLUMN_WIDTH, ledge.centerX(i), ledge.floorAt(i), ledge.trackVX, ledge.trackVY,
                        COLUMN_WIDTH / 2, h, 0);
                }
            }
            ledge.replace(fresh);
        }
        ledge.originX = left;
        ledge.originY = top;
        if (jumped) {
            ledge.trackX = ledge.originX;
            ledge.trackY = ledge.originY;
        } else if (wasResting) {
            // Join the motion at its current pace, with the lag a steady follow would have, instead of as a jolt.
            ledge.trackVX = displacementX / elapsed;
            ledge.trackVY = displacementY / elapsed;
            ledge.trackX = ledge.originX - ledge.trackVX * TRACK_TIME;
            ledge.trackY = ledge.originY - ledge.trackVY * TRACK_TIME;
        }
    }

    /// Moves a ledge's snow as a body riding on its window: it feels gravity plus the inertia of the
    /// window's acceleration, sticks by friction, slides when that's exceeded, and flies free when the
    /// window drops away faster than gravity or stops short after rising.
    carry(ledge, dt) {
        const previousVX = ledge.trackVX;
        const previousVY = ledge.trackVY;
        smoothDamp(ledge, ledge.originX, ledge.originY, TRACK_TIME, dt);
        const accelerationX = (ledge.trackVX - previousVX) / dt;
        const accelerationY = (ledge.trackVY - previousVY) / dt;
        // Agitation is vibration: two consecutive back-and-forth swings, not a single start or stop.
        ledge.agitation *= Math.exp(-dt / 0.3);
        const magnitude = Math.hypot(accelerationX, accelerationY);
        if (magnitude > 1 && accelerationX * ledge.swingX + accelerationY * ledge.swingY < 0) {
            ledge.agitation = Math.max(ledge.agitation, Math.min(ledge.previousSwingPeak, ledge.swingPeak) / GRAVITY);
            ledge.previousSwingPeak = ledge.swingPeak;
            ledge.swingPeak = magnitude;
            ledge.swingX = accelerationX / magnitude;
            ledge.swingY = accelerationY / magnitude;
        } else {
            ledge.swingPeak = Math.max(ledge.swingPeak, magnitude);
            if (magnitude > 1 && ledge.swingX === 0 && ledge.swingY === 0) {
                ledge.swingX = accelerationX / magnitude;
                ledge.swingY = accelerationY / magnitude;
            }
        }

        if (ledge.top <= 0.05) {
            ledge.offsetX = 0;
            ledge.offsetY = 0;
            ledge.offsetVX = 0;
            ledge.offsetVY = 0;
            return;
        }

        let lift = ledge.offsetY;
        let liftVelocity = ledge.offsetVY;
        const fall = -GRAVITY - accelerationY;
        if (lift > 0 || fall > ADHESION) {
            liftVelocity += fall * dt;
            lift += liftVelocity * dt;
            if (lift <= 0) {
                lift = 0;
                liftVelocity = 0;
            }
        }

        const pressure = lift > 0 ? 0 : Math.max(GRAVITY + ADHESION + accelerationY, 0);
        const drive = -accelerationX;
        let slideVelocity = ledge.offsetVX;
        if (!(slideVelocity === 0 && Math.abs(drive) <= GRIP * pressure)) {
            let direction;
            if (slideVelocity !== 0)
                direction = Math.sign(slideVelocity);
            else
                direction = drive > 0 ? 1 : -1;
            const next = slideVelocity + (drive - direction * SLIP * pressure) * dt;
            slideVelocity = pressure > 0 && next * direction <= 0 ? 0 : next;
        }

        let slide = ledge.offsetX + slideVelocity * dt;
        const carriedX = ledge.trackVX + slideVelocity;
        const carriedY = ledge.trackVY + liftVelocity;
        while (Math.abs(slide) >= COLUMN_WIDTH) {
            const direction = slide > 0 ? 1 : -1;
            const [height, x, y] = ledge.slideColumn(direction);
            slide -= direction * COLUMN_WIDTH;
            if (height > 0.01)
                this.release(height * COLUMN_WIDTH, x + direction * COLUMN_WIDTH, y, carriedX, carriedY, COLUMN_WIDTH / 2, height, 0);
        }

        const moved = lift !== ledge.offsetY || slide !== ledge.offsetX;
        ledge.offsetX = slide;
        ledge.offsetY = lift;
        ledge.offsetVX = slideVelocity;
        ledge.offsetVY = liftVelocity;
        if (moved)
            this.heightsChanged = true;

        if (lift > BREAK_LIFT) {
            this.shed(ledge, 1, carriedX, carriedY);
            ledge.offsetX = 0;
            ledge.offsetY = 0;
            ledge.offsetVX = 0;
            ledge.offsetVY = 0;
        } else if (ledge.agitation > SHAKING) {
            // A granular bed shaken well past gravity throws grains off its surface.
            const rate = Math.min(0.06 * (ledge.agitation - SHAKING), 0.8);
            const picks = Math.trunc(ledge.count() * rate * dt * 2 + random());
            for (let k = 0; k < picks; k++) {
                const column = Math.min(Math.trunc(random() * ledge.count()), ledge.count() - 1);
                const h = ledge.heights[column];
                if (h <= 0.2)
                    continue;
                ledge.set(column, h * 0.5);
                const vx = carriedX + range(-80, 80);
                const vy = carriedY + range(50, 200);
                this.release(h * 0.5 * COLUMN_WIDTH, ledge.centerX(column), ledge.floorAt(column) + h * 0.5, vx, vy,
                    COLUMN_WIDTH / 2, h * 0.5, 0.25);
            }
            if (picks > 0)
                this.heightsChanged = true;
        }
    }

    /// The part of a window slid past a wall carries no snow: the wall scrapes it off, and it heaps up against the
    /// wall, which holds up the heap's face as the cursor holds up the snow it touches.
    confine(ledge, li, width, walls) {
        const count = ledge.count();
        const base = ledge.baseX();
        const first = walls[0] ? clamp(Math.ceil(-base / COLUMN_WIDTH - 0.5), 0, count) : 0;
        const last = walls[1] ? clamp(Math.floor((width - base) / COLUMN_WIDTH - 0.5), -1, count - 1) : count - 1;
        if (first === 0 && last === count - 1)
            return;
        if (first > last) {
            // Nothing of the window is left this side of the wall: its snow falls down the wall.
            const x = first > 0 ? 1 : width - 1;
            for (let i = 0; i < count; i++) {
                const h = ledge.heights[i];
                if (h <= 0.05)
                    continue;
                ledge.set(i, 0);
                this.release(h * COLUMN_WIDTH, x, ledge.floorAt(i), 0, 0, 1, h, 0);
            }
            this.heightsChanged = true;
            return;
        }
        if (!this.heldLayers.includes(li))
            this.heldLayers.push(li);
        this.scrape(ledge, 0, first, first, 1);
        this.scrape(ledge, last + 1, count, last, -1);
    }

    /// Heaps the snow on columns `from` to `to`, past a wall, onto column `edge` just inside it, packing down what wasn't
    /// packed already. Scraped off fast, some of it crumbles off the heap and tumbles back over the window.
    scrape(ledge, from, to, edge, inward) {
        let area = 0;
        for (let i = from; i < to; i++) {
            const packed = Math.min(ledge.packed[i], ledge.heights[i]);
            area += (packed + (ledge.heights[i] - packed) * PACKING) * COLUMN_WIDTH;
            ledge.set(i, 0);
            ledge.hold(i);
        }
        if (area <= 0.01)
            return;
        this.heightsChanged = true;
        const direction = inward;
        const speed = Math.max(-direction * (ledge.trackVX + ledge.offsetVX), 0);
        const crumbled = area * 0.4 * smoothstep(200, 1200, speed);
        if (crumbled > 0.5) {
            this.release(crumbled, ledge.centerX(edge), ledge.surface(edge), direction * speed * 0.25, 60 + speed * 0.12,
                COLUMN_WIDTH, 2, 0.6);
        }
        ledge.heap(area - crumbled, edge, inward, REPOSE * COLUMN_WIDTH);
    }

    /// Turns part of a ledge's snow into falling snow where it lies: a few columns at a time hold together
    /// as a lump, the rest pours off as powder.
    shed(ledge, share, vx, vy) {
        let start = 0;
        while (start < ledge.count()) {
            const end = Math.min(ledge.count(), start + Math.trunc(range(2, 7)));
            let area = 0;
            let lowest = Infinity;
            let highest = -Infinity;
            for (let i = start; i < end; i++) {
                const h = ledge.heights[i];
                if (h <= 0.05)
                    continue;
                area += h * share * COLUMN_WIDTH;
                lowest = Math.min(lowest, ledge.floorAt(i) + h * (1 - share));
                highest = Math.max(highest, ledge.floorAt(i) + h);
            }
            const cohesion = area > 14 ? range(0.4, 0.7) : 0;
            for (let i = start; i < end; i++) {
                const h = ledge.heights[i];
                if (h <= 0.05)
                    continue;
                const amount = h * share;
                ledge.set(i, h - amount);
                this.release(amount * COLUMN_WIDTH * (1 - cohesion), ledge.centerX(i), ledge.floorAt(i) + h - amount, vx, vy,
                    COLUMN_WIDTH / 2, amount, 0.25);
            }
            if (cohesion > 0) {
                const left = ledge.centerX(start);
                const right = ledge.centerX(end - 1);
                this.throwLump(area * cohesion, (left + right) / 2, (lowest + highest) / 2, vx, vy);
            }
            start = end;
        }
        this.heightsChanged = true;
    }

    throwLump(area, x, y, vx, vy) {
        const pieces = Math.trunc(area / 90) + 1;
        const share = area / pieces;
        for (let k = 0; k < pieces; k++) {
            if (this.grains.length >= MAX_GRAINS)
                break;
            // Lumps break away a moment before the powder around them, so a falling sheet comes apart.
            const spread = 1 + range(-0.2, 0.2);
            this.grains.push({
                x: x + range(-2, 2),
                y: y + range(-1, 1),
                vx: vx * spread + range(-25, 25),
                vy: vy * spread + range(-80, 0),
                area: share,
                size: Math.min(Math.sqrt(share) * 1.05, 11),
                lump: range(0.05, 1),
                blown: false,
            });
        }
    }

    /// A lump hitting the snow: most of it packs in where it lands, a few crumbs hop off and a puff of powder rises.
    burst(lump, layer) {
        const impact = Math.max(-lump.vy, 0);
        const force = clamp(impact / 900, 0.35, 1.3);
        const crumbs = lump.area * 0.18;
        for (const spot of [-0.3, 0, 0.3]) {
            const x = lump.x + spot * lump.size;
            const missed = layer.deposit((lump.area - crumbs) / 3, x, true);
            this.dropPast(layer, missed, x, lump.vx * 0.3);
        }
        const index = layer.index(lump.x);
        const surface = index < 0 ? lump.y : layer.surface(index);
        this.release(crumbs, lump.x, surface + 1, lump.vx * 0.3, impact * range(0.08, 0.16), lump.size * 0.4, 1, 0.6);

        const count = Math.min(Math.max(MAX_MOTES - this.motes.length, 0), Math.trunc(2 + lump.size * 0.6 * force));
        for (let k = 0; k < count; k++) {
            const angle = range(0.15, Math.PI - 0.15);
            const speed = range(25, 110) * force;
            this.motes.push({
                x: lump.x + range(-0.5, 0.5) * lump.size,
                y: surface + range(0, lump.size * 0.4),
                vx: Math.cos(angle) * speed * 1.4 + lump.vx * 0.2,
                vy: Math.sin(angle) * speed * 0.6,
                size: range(0.3, 0.6) * lump.size + 1,
                alpha: range(0.1, 0.22),
                age: 0,
                life: range(0.45, 0.9),
            });
        }
    }

    /// `scatter` varies each clump's speed by that fraction, so a thrown sheet of snow breaks up instead of flying as one band.
    release(area, x, y, vx, vy, spreadX, spreadY, scatter) {
        if (area <= 0.02)
            return;
        const room = Math.max(MAX_GRAINS - this.grains.length, 0);
        if (room === 0) {
            this.overflow.push(area, x);
            return;
        }
        const count = Math.min(room, clamp(Math.trunc(area / 3), 1, 6));
        const share = area / count;
        for (let k = 0; k < count; k++) {
            const jitterX = range(-12, 12) - 40 * scatter * range(-1, 1);
            const jitterY = range(-10, 8);
            const speed = 1 + range(-scatter, scatter);
            this.grains.push({
                x: x + range(-spreadX, spreadX),
                y: y + range(0, spreadY),
                vx: vx * speed + jitterX,
                vy: vy * speed + jitterY,
                area: share,
                size: clamp(Math.sqrt(share) * 1.05, 1.1, 5),
                lump: 0,
                blown: false,
            });
        }
    }

    /// Snow that lands past the end of a ledge drops off that end instead.
    dropPast(layer, area, x, velocity) {
        if (!layer.opensAtEdges || area <= 0.05)
            return;
        const leftSide = x < layer.baseX() + layer.width() / 2;
        const [ex, ey] = edgePoint(layer, leftSide);
        this.release(area, ex, ey, velocity, -10, 0.25, 1, 0);
    }

    carve(layer, li, centerX, centerY, vx, vy, travel, last) {
        const radius = CURSOR_RADIUS;
        const baseX = layer.baseX();
        const baseY = layer.baseY();
        const lower = Math.max(ifloor((centerX - radius - baseX) / COLUMN_WIDTH), 0);
        const upper = Math.min(ifloor((centerX + radius - baseX) / COLUMN_WIDTH), layer.count() - 1);
        if (lower > upper)
            return;

        const local = centerY - baseY;
        const spraySpeed = Math.hypot(vx, vy);
        const sprayShare = smoothstep(60, 420, spraySpeed);
        let pushedLeft = 0;
        let pushedRight = 0;

        for (let i = lower; i <= upper; i++) {
            if (!layer.visible[i])
                continue;
            const x = layer.centerX(i);
            const dx = x - centerX;
            const reach = radius * radius - dx * dx;
            if (reach <= 0)
                continue;
            const half = Math.sqrt(reach);
            // Heights here are measured up from the bed under this column.
            const bedLevel = layer.bed[i];
            const bottom = Math.max(local - half - bedLevel, 0);
            const top = local + half - bedLevel;
            if (top <= bottom)
                continue;
            const h = layer.heights[i];
            const buried = h > top;
            if (last && !buried && h >= bottom - 1) {
                if (!this.heldLayers.includes(li))
                    this.heldLayers.push(li);
                layer.hold(i);
            }
            if (h <= bottom + 0.01)
                continue;

            // A buried cursor only displaces the snow it sweeps through; the rest rests on top of it.
            const removed = buried ? (top - bottom) * Math.min(travel / (2 * radius), 1) : h - bottom;
            if (removed <= 0.001)
                continue;
            layer.set(i, h - removed);
            this.lastCursorPush = this.clock;
            this.heightsChanged = true;

            const area = removed * COLUMN_WIDTH;
            const surface = layer.floorAt(i) + (buried ? h - removed : h);
            const sprayed = sprayShare > 0 ? this.emit(area * sprayShare, x, surface, centerX, centerY, vx, vy, spraySpeed) : 0;
            const side = Math.abs(vx) > 40 ? vx : dx;
            if (side < 0)
                pushedLeft += area - sprayed;
            else
                pushedRight += area - sprayed;
        }

        if (pushedLeft > 0) {
            const x = centerX - radius - COLUMN_WIDTH * 3;
            this.dropPast(layer, layer.deposit(pushedLeft, x, true), x, vx * 0.5);
        }
        if (pushedRight > 0) {
            const x = centerX + radius + COLUMN_WIDTH * 3;
            this.dropPast(layer, layer.deposit(pushedRight, x, true), x, vx * 0.5);
        }
    }

    emit(area, originX, originY, centerX, centerY, vx, vy, speed) {
        if (area <= 0.6 || this.grains.length >= MAX_GRAINS)
            return 0;
        const count = Math.min(Math.trunc(area / 1.6) + 1, 4);
        const share = area / count;
        const offsetX = originX - centerX;
        const offsetY = originY - centerY;
        const length = Math.hypot(offsetX, offsetY);
        const outwardX = length > 0.001 ? offsetX / length : 0;
        const outwardY = length > 0.001 ? offsetY / length : 1;

        for (let k = 0; k < count; k++) {
            const scale = range(0.55, 1.25);
            const push = speed * range(0.05, 0.25);
            const gvx = vx * scale + outwardX * push + range(-30, 30);
            const gvy = vy * scale + outwardY * push + speed * range(0.02, 0.2) + range(-20, 40);
            this.grains.push({
                x: originX + range(-1, 1),
                y: originY + range(0, 2),
                vx: gvx,
                vy: gvy,
                area: share,
                size: clamp(Math.sqrt(share) * 1.05, 1.1, 4.2),
                lump: 0,
                blown: false,
            });
        }
        return area;
    }

    advanceMotes(dt) {
        if (this.motes.length === 0)
            return;
        const damping = Math.exp(-3.2 * dt);
        const drift = this.windSpeed() * 0.4;
        const motes = this.motes;
        for (let i = motes.length - 1; i >= 0; i--) {
            const mote = motes[i];
            mote.age += dt;
            if (mote.age >= mote.life) {
                swapRemove(motes, i);
            } else {
                mote.vy -= 35 * dt;
                mote.vx *= damping;
                mote.vy *= damping;
                mote.x += (mote.vx + drift) * dt;
                mote.y += mote.vy * dt;
            }
        }
    }

    /// Fills `flake` (or a new one) as a fresh flake starting at height `y`.
    makeFlake(width, y, flake = {}) {
        const wind = this.windSpeed();
        const near = random() < 0.02;
        const depth = near ? 1 : random() ** 1.6;
        const fallSpeed = near ? range(75, 100) : 16 + depth * 50 + range(0, 10);
        flake.x = range(-30, width + 30);
        flake.y = y;
        flake.vx = wind * (0.35 + 0.65 * depth);
        flake.vy = -fallSpeed;
        flake.fallSpeed = fallSpeed;
        flake.size = near ? range(8, 13) : 1.4 + depth * 4.4 + range(0, 1);
        flake.depth = depth;
        flake.alpha = near ? 0.28 : 0.4 + depth * 0.5;
        flake.soft = near ? 0.95 : 0.75 - depth * 0.45;
        flake.phase = range(0, PHASE_WRAP);
        flake.swayRate = range(0.5, 1.4);
        flake.swayAmount = near ? range(10, 20) : range(4, 9) + depth * 10;
        flake.settles = !near;
        flake.mass = 1;
        flake.tintR = 1;
        flake.tintG = 1;
        flake.tintB = 1;
        flake.tintAmount = 0;
        flake.blown = 0;
        return flake;
    }

    windSpeed() {
        return this.breeze() + this.gustSpeed();
    }

    breeze() {
        const t = this.clock;
        const breeze = 10 * Math.sin(t * 0.07) + 6 * Math.sin(t * 0.19 + 1.7) + 3 * Math.sin(t * 0.43 + 4.1);
        return breeze * (0.6 + 0.4 * this.strength);
    }

    gustSpeed() {
        const gust = this.gust;
        if (!gust || gust.calm)
            return 0;
        const age = this.clock - gust.start;
        return gust.direction * GUST_WIND * smoothstep(0, 0.12, age) * (1 - smoothstep(0.9, GUST_LENGTH, age));
    }

    blowing() {
        return this.gust !== null && !this.gust.calm;
    }

    /// A pinch of snow torn off by the gust: a grain of powder, now and then with a faint puff around it.
    lift(x, y, direction) {
        if (this.grains.length >= MAX_GRAINS)
            return;
        this.grains.push({
            x: x + range(-1, 1),
            y: y + range(-3, 0),
            vx: direction * range(800, 1800),
            vy: range(60, 420),
            area: 0,
            size: range(1.1, 2.6),
            lump: 0,
            blown: true,
        });
        if (random() >= 0.35 || this.motes.length >= MAX_MOTES)
            return;
        this.motes.push({
            x,
            y,
            vx: direction * range(200, 600),
            vy: range(20, 120),
            size: range(6, 14),
            alpha: range(0.06, 0.14),
            age: 0,
            life: range(0.6, 1.3),
        });
    }
}

export class SnowSimulation {
    constructor(width, height, snowfall) {
        const ground = new SnowLayer(0, 0, columnCount(width), COLUMN_WIDTH, GROUND_DEPTH, false, [range(0, TAU), range(0, TAU)]);
        this._width = width;
        this._height = height;
        this._pace = Pace.CALM;
        this._snowfall = snowfall;
        this._density = 1;
        this.thaws = false;
        this.accumulates = true;
        /// Side edges, left and right, with no display past them: a window slid past one leaves its snow heaped against the edge.
        this.walls = [false, false];
        /// Keeps the snowfall from starting until a scattered window's snow first reaches the bottom of the screen.
        this._snowfallHeld = false;
        /// Set when the held snowfall starts by itself, so the other displays can start theirs.
        this._snowfallReleased = false;
        this._scatteredUntil = -10;
        /// The ground first, then one ledge per window, with `ids` alongside.
        this.layers = [ground];
        this._ids = [0];
        /// Snow on windows that left the screen for another workspace, kept until the window shows up again.
        this._dormant = new Map();
        /// Windows that went off screen without a word yet on why; a workspace switch keeps their snow, anything else drops it.
        this._parking = [];
        this._spaceChangedAt = -10;
        this._targetFlakes = 0;
        this._strengthTarget = 1;
        this._nextShift = 0;
        this.air = new Air();
        this._updateTarget();
    }

    width() {
        return this._width;
    }

    height() {
        return this._height;
    }

    pace() {
        return this._pace;
    }

    setSnowfall(snowfall) {
        if (snowfall === Snowfall.VARIABLE && this._snowfall !== Snowfall.VARIABLE)
            this._nextShift = this.air.clock;
        if (snowfall !== Snowfall.VARIABLE) {
            this.air.strength = 1;
            this._strengthTarget = 1;
        }
        this._snowfall = snowfall;
        this._updateTarget();
    }

    setSnowfallHeld(held) {
        this._snowfallHeld = held;
        this._updateTarget();
    }

    /// Whether the held snowfall started by itself since the last call.
    takeSnowfallReleased() {
        const released = this._snowfallReleased;
        this._snowfallReleased = false;
        return released;
    }

    /// Scales the snowfall; flakes come and go through the usual cycle, so a change shows gradually.
    setDensity(density) {
        this._density = density;
        this._updateTarget();
    }

    hasSnow() {
        return this.layers.some(layer => layer.top > 0.5);
    }

    /// Whether snow is meant to be falling, so flakes are on their way even if none are in the air yet.
    falling() {
        return this._targetFlakes > 0 || this.air.gust !== null;
    }

    spriteCount() {
        return this.air.flakes.length + this.air.grains.length + this.air.motes.length;
    }

    /// Floats the renderer needs per frame: each layer's surface and bed.
    columnCount() {
        let count = 0;
        for (const layer of this.layers)
            count += 2 * layer.count();
        return count;
    }

    resize(width, height) {
        if (width === this._width && height === this._height)
            return;
        this.layers[0].resize(columnCount(width));
        this._width = width;
        this._height = height;
        this._updateTarget();
    }

    /// Returns whether anything visible changed.
    step(dt, cursorX, cursorY) {
        const air = this.air;
        air.clock += dt;
        const wasMoving = this.spriteCount() > 0;
        air.heightsChanged = false;

        this._vary(dt);
        this._expireParking();
        for (let li = 1; li < this.layers.length; li++)
            air.carry(this.layers[li], dt);
        this._trackCursor(cursorX, cursorY, dt);
        for (let li = 1; li < this.layers.length; li++)
            air.confine(this.layers[li], li, this._width, this.walls);
        this._blow(dt);
        this._advanceFlakes(dt);
        this._advanceGrains(dt);
        air.advanceMotes(dt);
        this._settle(dt);
        this._spawnFlakes();
        for (let k = 0; k < air.overflow.length; k += 2)
            this.layers[0].deposit(air.overflow[k], air.overflow[k + 1], true);
        air.overflow.length = 0;

        for (const layer of this.layers) {
            layer.refreshTop();
            layer.previousBaseY = layer.baseY();
        }
        // Only a cursor that actually displaces snow needs the full rate; one passing near it or resting in it changes nothing.
        const pushed = air.clock - air.lastWindowMotion < 0.6 || air.clock - air.lastCursorPush < 0.3 || air.gust !== null;
        // The steady trickle off window corners is a few tiny grains at a time; they read fine at the calm rate.
        const flying = air.grains.length > 24 || air.clock < this._scatteredUntil;
        if (pushed)
            this._pace = Pace.INTERACTIVE;
        else if (flying)
            this._pace = Pace.LIVELY;
        else
            this._pace = Pace.CALM;
        const changed = wasMoving || this.spriteCount() > 0 || air.heightsChanged || air.windowsChanged;
        air.windowsChanged = false;
        return changed;
    }

    /// Writes each sprite `copies` times in a row, SPRITE_FLOATS floats a copy, the last of them the copy's index,
    /// so a renderer can spread one sprite over the corners of a quad. Returns how many sprites it wrote.
    writeSprites(buffer, copies = 1) {
        const air = this.air;
        const capacity = Math.floor(buffer.length / (SPRITE_FLOATS * copies));
        let count = 0;
        let o = 0;
        const put = (x, y, vx, vy, size, alpha, soft, lump, r, g, b, tint) => {
            for (let c = 0; c < copies; c++) {
                buffer[o] = x;
                buffer[o + 1] = y;
                buffer[o + 2] = vx;
                buffer[o + 3] = vy;
                buffer[o + 4] = size;
                buffer[o + 5] = alpha;
                buffer[o + 6] = soft;
                buffer[o + 7] = lump;
                buffer[o + 8] = r;
                buffer[o + 9] = g;
                buffer[o + 10] = b;
                buffer[o + 11] = tint;
                buffer[o + 12] = c;
                o += SPRITE_FLOATS;
            }
            count++;
        };
        for (let i = 0; i < air.flakes.length && count < capacity; i++) {
            const f = air.flakes[i];
            put(f.x, f.y, f.vx, f.vy, f.size, f.alpha, f.soft, 0, f.tintR, f.tintG, f.tintB, f.tintAmount);
        }
        for (let i = 0; i < air.grains.length && count < capacity; i++) {
            const g = air.grains[i];
            let alpha = 0.95;
            if (g.lump > 0)
                alpha = 0.97;
            else if (g.blown)
                alpha = 0.8;
            put(g.x, g.y, g.vx, g.vy, g.size, alpha, g.lump > 0 ? 0.2 : 0.3, g.lump, 1, 1, 1, 0);
        }
        for (let i = 0; i < air.motes.length && count < capacity; i++) {
            const m = air.motes[i];
            const t = m.age / m.life;
            const fade = Math.min(m.age / 0.06, 1) * (1 - t) ** 1.5;
            put(m.x, m.y, 0, 0, m.size * (1 + t), m.alpha * fade, 1, 0, 1, 1, 1, 0);
        }
        return count;
    }

    /// Writes each layer with snow on it into `buffer`, its smoothed surface then its bed, and describes where.
    writeLayers(buffer) {
        const result = [];
        let offset = 0;
        for (const layer of this.layers) {
            const span = 2 * layer.count();
            if (layer.top <= 0.05 || offset + span > buffer.length)
                continue;
            layer.writeSmoothed(buffer, offset);
            result.push({
                offset,
                count: layer.count(),
                originX: layer.baseX(),
                originY: layer.baseY(),
                top: layer.top,
                bottom: -layer.bedDepth,
                occluders: layer.occluders,
            });
            offset += span;
        }
        return result;
    }

    /// Turns the pieces into snowflakes that drift down and fade to white; together they leave a small drift.
    /// Each piece is {x, y, vx, vy, color: [r, g, b]}.
    scatter(pieces) {
        this._scatteredUntil = this.air.clock + 8;
        for (const piece of pieces) {
            const depth = random() ** 0.7;
            this.air.flakes.push({
                x: piece.x,
                y: piece.y,
                vx: piece.vx,
                vy: piece.vy,
                fallSpeed: 70 + depth * 170 + range(0, 40),
                size: 1.8 + depth * 2.6,
                depth,
                alpha: 0.5 + depth * 0.45,
                soft: 0.7 - depth * 0.4,
                phase: range(0, PHASE_WRAP),
                swayRate: range(0.6, 1.8),
                swayAmount: range(8, 24),
                settles: true,
                mass: 0.06,
                tintR: piece.color[0],
                tintG: piece.color[1],
                tintB: piece.color[2],
                tintAmount: 1,
                blown: 0,
            });
        }
    }

    // Windows

    spaceChanged() {
        this._spaceChangedAt = this.air.clock;
        for (const [id, ledge] of this._parking)
            this._dormant.set(id, ledge);
        this._parking = [];
    }

    /// `parked` and `elsewhere` are sets of window ids.
    updateWindows(surfaces, interval, parked, elsewhere, sliding) {
        for (const li of this.air.heldLayers)
            this.layers[li]?.releaseSupport();
        this.air.heldLayers.length = 0;
        const known = new Map();
        for (let li = 1; li < this._ids.length; li++)
            known.set(this._ids[li], li);
        const seen = new Set();
        for (const surface of surfaces) {
            const left = surface.frame.x + LEDGE_INSET;
            const top = surface.frame.y + surface.frame.height;
            const columns = Math.trunc((surface.frame.width - 2 * LEDGE_INSET) / COLUMN_WIDTH);
            if (columns < 8)
                continue;
            seen.add(surface.id);

            let li = known.get(surface.id);
            if (li !== undefined) {
                const ledge = this.layers[li];
                if (sliding && columns === ledge.count())
                    this.air.pan(ledge, left, top);
                else
                    this.air.moveLedge(ledge, left, top, columns, interval);
            } else {
                let ledge = this._dormant.get(surface.id);
                this._dormant.delete(surface.id);
                ledge ??= this._unpark(surface.id);
                if (ledge) {
                    restore(ledge, left, top, columns);
                } else {
                    const phases = [range(0, TAU), range(0, TAU)];
                    ledge = new SnowLayer(left, top, columns, COLUMN_WIDTH, LEDGE_DEPTH, true, phases);
                }
                this.layers.push(ledge);
                this._ids.push(surface.id);
                li = this.layers.length - 1;
            }
            const ledge = this.layers[li];
            ledge.shapeCorners(surface.cornerRadius, surface.cornerExponent);
            const blockers = surface.blockers.map(b => [b.x, b.y, b.x + b.width, b.y + b.height]);
            ledge.occluders = blockers.slice(0, 16);
            ledge.updateVisibility(this._width, blockers);
        }

        const layers = this.layers;
        const ids = this._ids;
        this.layers = [];
        this._ids = [];
        for (let li = 0; li < layers.length; li++) {
            const ledge = layers[li];
            const id = ids[li];
            if (li === 0 || seen.has(id)) {
                this.layers.push(ledge);
                this._ids.push(id);
            } else if (elsewhere.has(id)) {
                this._dormant.set(id, ledge);
            } else if (!parked.has(id)) {
                this.air.shed(ledge, 1, ledge.trackVX + ledge.offsetVX, ledge.trackVY + ledge.offsetVY);
            } else if (this.air.clock - this._spaceChangedAt < 0.6) {
                this._dormant.set(id, ledge);
            } else {
                this._parking.push([id, ledge, this.air.clock]);
            }
        }
        if (this._dormant.size > 200)
            this._dormant.delete(this._dormant.keys().next().value);
    }

    /// Ids of windows whose snow waits off screen.
    dormantIds() {
        return [...this._dormant.keys()];
    }

    _unpark(id) {
        const index = this._parking.findIndex(entry => entry[0] === id);
        if (index < 0)
            return null;
        return this._parking.splice(index, 1)[0][1];
    }

    /// Off-screen windows that no workspace switch accounts for were minimized or hidden: their snow falls.
    _expireParking() {
        while (this._parking.length > 0 && this.air.clock - this._parking[0][2] > 0.25) {
            const [, ledge] = this._parking.shift();
            this.air.shed(ledge, 1, 0, 0);
        }
    }

    // Cursor

    _trackCursor(pointX, pointY, dt) {
        const air = this.air;
        for (const li of air.heldLayers)
            this.layers[li].releaseSupport();
        air.heldLayers.length = 0;

        const centerX = pointX + CURSOR_OFFSET_X;
        const centerY = pointY + CURSOR_OFFSET_Y;
        const previous = air.cursor;
        air.cursor = [centerX, centerY];
        if (!previous)
            return;

        const deltaX = centerX - previous[0];
        const deltaY = centerY - previous[1];
        const elapsed = Math.max(dt, 1 / 240);
        let vx = deltaX / elapsed;
        let vy = deltaY / elapsed;
        const speed = Math.hypot(vx, vy);
        if (speed > 3000) {
            vx *= 3000 / speed;
            vy *= 3000 / speed;
        }
        air.cursorVX += (vx - air.cursorVX) * 0.5;
        air.cursorVY += (vy - air.cursorVY) * 0.5;

        const low = Math.min(centerY, previous[1]) - CURSOR_RADIUS;
        const high = Math.max(centerY, previous[1]) + CURSOR_RADIUS;
        const left = Math.min(centerX, previous[0]) - CURSOR_RADIUS;
        const right = Math.max(centerX, previous[0]) + CURSOR_RADIUS;
        const touched = [];
        for (let li = 0; li < this.layers.length; li++) {
            const layer = this.layers[li];
            const baseX = layer.baseX();
            const baseY = layer.baseY();
            if (low <= baseY + layer.top + 1 && high >= baseY - layer.bedDepth && right >= baseX &&
                left <= baseX + layer.width() && (li === 0 || layer.top > 0.01))
                touched.push(li);
        }
        if (touched.length === 0)
            return;

        const distance = Math.hypot(deltaX, deltaY);
        if (distance > 400) {
            for (const li of touched)
                air.carve(this.layers[li], li, centerX, centerY, 0, 0, 0, true);
            return;
        }
        const steps = Math.trunc(distance / (CURSOR_RADIUS * 0.5)) + 1;
        for (let step = 1; step <= steps; step++) {
            const x = previous[0] + deltaX * (step / steps);
            const y = previous[1] + deltaY * (step / steps);
            for (const li of touched)
                air.carve(this.layers[li], li, x, y, vx, vy, distance / steps, step === steps);
        }
    }

    // Particles

    _advanceFlakes(dt) {
        const air = this.air;
        const wind = air.breeze();
        const follow = Math.min(dt * 1.2, 1);
        const settle = Math.min(dt * 1.6, 1);
        const wakeRadius = 80;
        let wakeVX = air.cursorVX;
        let wakeVY = air.cursorVY;
        const wakeSpeed = Math.hypot(wakeVX, wakeVY);
        if (wakeSpeed > 500) {
            wakeVX *= 500 / wakeSpeed;
            wakeVY *= 500 / wakeSpeed;
        }
        const wakeX = air.cursor ? air.cursor[0] : -10000;
        const wakeY = air.cursor ? air.cursor[1] : -10000;
        const wakeActive = wakeSpeed > 20;
        const flakes = air.flakes;
        const width = this._width;

        for (let i = flakes.length - 1; i >= 0; i--) {
            const flake = flakes[i];
            if (flake.blown !== 0) {
                // The nearer the flake, the faster the gust seems to carry it.
                flake.vx += (flake.blown * GUST_WIND * (1.3 + 1.3 * flake.depth) - flake.vx) * Math.min(dt * 2.5, 1);
            } else {
                flake.vx += (wind * (0.35 + 0.65 * flake.depth) - flake.vx) * follow;
            }
            flake.vy += (-flake.fallSpeed - flake.vy) * settle;

            if (wakeActive) {
                const dx = flake.x - wakeX;
                const dy = flake.y - wakeY;
                const distanceSquared = dx * dx + dy * dy;
                if (distanceSquared < wakeRadius * wakeRadius) {
                    const falloff = 1 - Math.sqrt(distanceSquared) / wakeRadius;
                    const pull = Math.min(falloff * falloff * 4 * dt, 1);
                    flake.vx += (wakeVX - flake.vx) * pull;
                    flake.vy += (wakeVY - flake.vy) * pull;
                }
            }

            // Harmonic ratios 2.3 and 1.3 stay continuous across the 20π wrap.
            flake.phase += flake.swayRate * dt;
            if (flake.phase > PHASE_WRAP)
                flake.phase -= PHASE_WRAP;
            const sway = (Math.cos(flake.phase) + 0.3 * Math.cos(flake.phase * 2.3)) * flake.swayAmount;
            const flutter = 1 + 0.12 * Math.sin(flake.phase * 1.3);
            if (flake.tintAmount > 0)
                flake.tintAmount = Math.max(flake.tintAmount - dt * 1.3, 0);
            const previousY = flake.y;
            flake.x += (flake.vx + sway) * dt;
            flake.y += flake.vy * flutter * dt;

            if (flake.blown !== 0 && (flake.x < -30 || flake.x > width + 30)) {
                swapRemove(flakes, i);
                continue;
            }
            if (flake.x < -30)
                flake.x += width + 60;
            else if (flake.x > width + 30)
                flake.x -= width + 60;

            if (flake.settles && this.accumulates && flake.blown === 0) {
                const hit = landing(this.layers, flake.x, previousY, flake.y);
                if (hit >= 0) {
                    const li = hit >>> 16;
                    const column = hit & 0xffff;
                    if (this._snowfallHeld && flake.mass < 1 && li === 0) {
                        this._snowfallHeld = false;
                        this._snowfallReleased = true;
                        this._updateTarget();
                    }
                    const layer = this.layers[li];
                    const amount = flake.size * flake.size * DEPOSITION * flake.mass * layer.fill(column);
                    layer.deposit(amount, flake.x, true);
                    air.heightsChanged = true;
                    this._recycle(i);
                    continue;
                }
            } else if (flake.y < -flake.size * 2) {
                this._recycle(i);
                continue;
            }
        }
    }

    _advanceGrains(dt) {
        const air = this.air;
        const grains = air.grains;
        if (grains.length === 0)
            return;
        const damping = Math.exp(-GRAIN_DRAG * dt);
        const width = this._width;
        for (let i = grains.length - 1; i >= 0; i--) {
            const grain = grains[i];
            const previousY = grain.y;
            if (grain.blown) {
                // Light powder: the wind keeps it moving toward the edge it was blown to, and it barely sinks.
                const speed = grain.vx < 0 ? -GUST_WIND * 1.6 : GUST_WIND * 1.6;
                grain.vx += (speed - grain.vx) * Math.min(dt * 2, 1);
                grain.vy -= GRAVITY * 0.08 * dt;
            } else {
                grain.vy -= GRAVITY * dt;
                grain.vx *= damping;
                grain.vy *= damping;
            }
            grain.x += grain.vx * dt;
            grain.y += grain.vy * dt;

            if (grain.x < -10 || grain.x > width + 10 || grain.y < -10) {
                swapRemove(grains, i);
                continue;
            }
            if (grain.blown || grain.vy > 0)
                continue;
            const hit = landing(this.layers, grain.x, previousY, grain.y);
            if (hit < 0)
                continue;
            const layer = this.layers[hit >>> 16];
            if (grain.lump > 0) {
                air.burst(grain, layer);
            } else {
                const missed = layer.deposit(grain.area, grain.x, true);
                air.dropPast(layer, missed, grain.x, grain.vx * 0.5);
            }
            air.heightsChanged = true;
            swapRemove(grains, i);
        }
    }

    _recycle(i) {
        const air = this.air;
        if (air.flakes.length <= this._targetFlakes && !air.blowing()) {
            const y = this._height + range(4, 40);
            air.makeFlake(this._width, y, air.flakes[i]);
        } else {
            swapRemove(air.flakes, i);
        }
    }

    /// No new snow falls until the gust has carried off the last flake, then the snowfall starts again from the top.
    _spawnFlakes() {
        const air = this.air;
        if (air.blowing())
            return;
        while (air.flakes.length < this._targetFlakes) {
            const y = this._height + range(0, this._height * 0.8);
            air.flakes.push(air.makeFlake(this._width, y));
        }
    }

    /// Wanders between light lulls, steady snow and heavy flurries.
    _vary(dt) {
        const air = this.air;
        // In case none of the scattered snow makes it to the bottom, say because it all came to rest on windows.
        if (this._snowfallHeld && this._scatteredUntil > 0 && air.clock > this._scatteredUntil) {
            this._snowfallHeld = false;
            this._snowfallReleased = true;
            this._updateTarget();
        }
        if (this._snowfall !== Snowfall.VARIABLE) {
            this._strengthTarget = 1;
        } else if (air.clock >= this._nextShift) {
            const roll = random();
            if (roll < 0.25)
                this._strengthTarget = range(0.25, 0.5);
            else if (roll < 0.75)
                this._strengthTarget = range(0.7, 1.3);
            else
                this._strengthTarget = range(1.5, 2.1);
            this._nextShift = air.clock + range(60, 240);
        }
        if (Math.abs(this._strengthTarget - air.strength) <= 0.001)
            return;
        air.strength += (this._strengthTarget - air.strength) * (1 - Math.exp(-dt / 25));
        this._updateTarget();
    }

    // Gust

    /// The way the breeze blows now: 1 to the right, -1 to the left.
    breezeDirection() {
        return this.air.breeze() < 0 ? -1 : 1;
    }

    /// Clears all the snow: a gust in `direction` lifts it off the ground and the windows and blows it off the screen,
    /// or, `calm`, it melts away where it lies.
    blowAway(direction, calm) {
        direction = direction < 0 ? -1 : 1;
        this.air.gust = {start: this.air.clock, direction, calm};
        // Snow kept for windows on other workspaces goes too, out of sight.
        this._dormant.clear();
        for (const [, ledge] of this._parking) {
            for (let i = 0; i < ledge.count(); i++)
                ledge.set(i, 0);
        }
    }

    _blow(dt) {
        const air = this.air;
        const gust = air.gust;
        if (!gust)
            return;
        const age = air.clock - gust.start;
        if (age >= GUST_LENGTH && !air.flakes.some(flake => flake.blown !== 0)) {
            air.gust = null;
            return;
        }
        const margin = 40;
        const front = gustFront(this._width, age, gust.direction, margin);
        // Whatever the front has long passed is gone by now, however deep it was.
        const finish = age > GUST_SWEEP + (gust.calm ? 0.6 : 0.8);
        if (!gust.calm) {
            const trailing = gustFront(this._width, age - GUST_LAG, gust.direction, margin);
            for (const flake of air.flakes) {
                if (flake.blown !== 0)
                    continue;
                // Each flake is caught a little further behind, so the snowfall doesn't go as one straight line.
                const stagger = flake.phase / PHASE_WRAP * 240;
                if (finish || (trailing - flake.x) * gust.direction > stagger)
                    flake.blown = gust.direction;
            }
        }
        for (const layer of this.layers) {
            let dust = 0;
            for (let i = 0; i < layer.count(); i++) {
                const height = layer.heights[i];
                if (height <= 0)
                    continue;
                const x = layer.centerX(i);
                if (!gust.calm && (front - x) * gust.direction <= 0)
                    continue;
                const surface = layer.surface(i);
                const rate = gust.calm ? height * 2.5 + 6 : height * 8 + 50;
                const loss = finish ? height : Math.min(height, rate * dt);
                layer.set(i, height - loss);
                air.heightsChanged = true;
                if (gust.calm || !layer.visible[i])
                    continue;
                dust += loss * layer.columnWidth;
                while (dust >= 3.5) {
                    air.lift(x, surface, gust.direction);
                    dust -= 3.5;
                }
            }
        }
    }

    // Piles

    _settle(dt) {
        const air = this.air;
        // Melting nearly keeps pace with the snowfall, so heavier snowfall builds drifts only a little higher.
        const falling = flakesPerMegapoint(this._snowfall) * air.strength * this._density;
        const meltPace = falling > 0 ? (falling / THAW_BALANCE) ** THAW_EXPONENT : 1;
        for (let li = 0; li < this.layers.length; li++) {
            const layer = this.layers[li];
            if (!this.accumulates || this.thaws) {
                let floor = 0;
                if (this.accumulates)
                    floor = li === 0 ? THAW_DEPTH : LEDGE_THAW_DEPTH;
                if (layer.thaw(dt * meltPace, floor, THAW_RATE, THAW_TIME))
                    air.heightsChanged = true;
            }
            // Shaken harder than gravity, a granular pile fluidizes and slumps to a flatter slope.
            const repose = layer.agitation > SHAKING ? REPOSE * 0.35 : REPOSE;
            if (layer.relax(repose, ROUNDING))
                air.heightsChanged = true;
            if (layer.spillLeft > 1.5) {
                const [x, y] = edgePoint(layer, true);
                air.release(layer.spillLeft, x, y, layer.trackVX - 6, layer.trackVY - 15, 0.25, 1, 0);
                layer.spillLeft = 0;
            }
            if (layer.spillRight > 1.5) {
                const [x, y] = edgePoint(layer, false);
                air.release(layer.spillRight, x, y, layer.trackVX + 6, layer.trackVY - 15, 0.25, 1, 0);
                layer.spillRight = 0;
            }
        }
    }

    _updateTarget() {
        const perMegapoint = this._snowfallHeld ? 0 : flakesPerMegapoint(this._snowfall);
        this._targetFlakes = Math.trunc(perMegapoint * this.air.strength * this._density * this._width * this._height / 1000000);
    }
}

/// Where the gust's front is `age` seconds in, coming in from `margin` past the windward edge of a display `width` wide.
/// It hits at full speed and eases off as it crosses.
function gustFront(width, age, direction, margin) {
    const t = clamp(age / GUST_SWEEP, 0, 1);
    const travel = (width + 2 * margin) * (1 - (1 - t) * (1 - t));
    return direction > 0 ? -margin + travel : width + margin - travel;
}

/// Puts snow that waited off screen back on its window, wherever the window is now, without treating the jump as motion.
function restore(ledge, left, top, columns) {
    ledge.resize(columns);
    ledge.originX = left;
    ledge.originY = top;
    ledge.trackX = left;
    ledge.trackY = top;
    ledge.trackVX = 0;
    ledge.trackVY = 0;
    ledge.offsetX = 0;
    ledge.offsetY = 0;
    ledge.offsetVX = 0;
    ledge.offsetVY = 0;
    ledge.previousBaseY = top;
    ledge.movedAt = -1;
}

/// The highest visible snow surface crossed while falling from `from` to `to` at `x`, allowing for the surface moving
/// meanwhile, packed as layer << 16 | column, the ground being layer 0; -1 for none.
function landing(layers, x, from, to) {
    let hit = -1;
    let highest = -Infinity;
    for (let li = 1; li < layers.length; li++) {
        const ledge = layers[li];
        const i = ledge.index(x);
        if (i < 0 || !ledge.visible[i])
            continue;
        const surface = ledge.surface(i);
        // Entering the snow from above the window's edge counts, even if the surface rose this frame.
        if (from >= ledge.previousBaseY + ledge.bed[i] && to <= surface && surface > highest) {
            hit = li << 16 | i;
            highest = surface;
        }
    }
    if (hit >= 0)
        return hit;
    const ground = layers[0];
    const i = ground.clampedIndex(x);
    return to <= ground.surface(i) ? i : -1;
}

/// Where snow leaves an open layer: just past its end, at the height the snow reaches on the end column,
/// which on a rounded corner lies well down the curve.
function edgePoint(layer, left) {
    const end = left ? 0 : layer.count() - 1;
    const x = left ? layer.baseX() - 0.75 : layer.baseX() + layer.width() + 0.75;
    return [x, layer.surface(end)];
}

/// Critically damped follow of a target (the SmoothDamp approximation) by a layer's track, stable at any time step.
function smoothDamp(ledge, targetX, targetY, time, dt) {
    const omega = 2 / time;
    const x = omega * dt;
    const decay = 1 / (1 + x + 0.48 * x * x + 0.235 * x * x * x);
    const changeX = ledge.trackX - targetX;
    const changeY = ledge.trackY - targetY;
    const tempX = (ledge.trackVX + changeX * omega) * dt;
    const tempY = (ledge.trackVY + changeY * omega) * dt;
    ledge.trackVX = (ledge.trackVX - tempX * omega) * decay;
    ledge.trackVY = (ledge.trackVY - tempY * omega) * decay;
    ledge.trackX = targetX + (changeX + tempX) * decay;
    ledge.trackY = targetY + (changeY + tempY) * decay;
}

function columnCount(width) {
    return Math.ceil(width / COLUMN_WIDTH) + 1;
}

function swapRemove(array, i) {
    const last = array.pop();
    if (i < array.length)
        array[i] = last;
}
