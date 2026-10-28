// A port of windows/src/layer.rs. Positions are split into x and y fields, so the hot loops allocate nothing.

/// A height field of snow columns lying on a bed: the screen bottom, or the top edge of a window
/// whose rounded corners curve the bed down at both ends.
export class SnowLayer {
    constructor(originX, originY, columns, columnWidth, depth, opensAtEdges, phases) {
        this.columnWidth = columnWidth;
        this.opensAtEdges = opensAtEdges;
        this.originX = originX;
        this.originY = originY;
        this.heights = new Float64Array(columns);
        /// How much of each column's snow a wall has packed down already, so it isn't packed again.
        this.packed = new Float64Array(columns);
        /// The bed under each column relative to `originY`; zero along a flat edge, negative where a corner rounds off.
        this.bed = new Float64Array(columns);
        this.visible = new Uint8Array(columns).fill(1);
        this.top = 0;
        this.bedDepth = 0;
        /// Rectangles in front of the layer, as [left, bottom, right, top].
        this.occluders = [];
        this.movedAt = -1;
        this.spillLeft = 0;
        this.spillRight = 0;
        // Smoothed path of the supporting edge; the snow reacts to its accelerations, not to raw jittery samples.
        this.trackX = originX;
        this.trackY = originY;
        this.trackVX = 0;
        this.trackVY = 0;
        // The snow body's displacement from its support: x slides along it, y lifts off it.
        this.offsetX = 0;
        this.offsetY = 0;
        this.offsetVX = 0;
        this.offsetVY = 0;
        this.previousBaseY = originY;
        this.agitation = 0;
        this.swingX = 0;
        this.swingY = 0;
        this.swingPeak = 0;
        this.previousSwingPeak = 0;

        this._capacity = new Float64Array(0);
        this._depth = depth;
        this._phases = phases;
        this._corner = [0, 2];
        this._supported = new Uint8Array(columns);
        this._supportedLow = -1;
        this._supportedHigh = -1;
        this._parity = false;
        this._updateCapacity();
    }

    count() {
        return this.heights.length;
    }

    width() {
        return this.heights.length * this.columnWidth;
    }

    baseX() {
        return this.originX + this.offsetX;
    }

    baseY() {
        return this.originY + this.offsetY;
    }

    /// The column under `x`, or -1 past either end.
    index(x) {
        const i = Math.floor((x - this.baseX()) / this.columnWidth);
        return i >= 0 && i < this.heights.length ? i : -1;
    }

    clampedIndex(x) {
        const i = Math.floor((x - this.baseX()) / this.columnWidth);
        return Math.min(Math.max(i, 0), this.heights.length - 1);
    }

    centerX(i) {
        return this.baseX() + (i + 0.5) * this.columnWidth;
    }

    /// Height of the snow's underside (the bed) at column `i`, in overlay coordinates.
    floorAt(i) {
        return this.baseY() + this.bed[i];
    }

    surface(i) {
        return this.baseY() + this.bed[i] + this.heights[i];
    }

    /// Rounds the bed's ends like the window's corners: a superellipse quadrant of the given radius.
    shapeCorners(radius, exponent) {
        if (radius === this._corner[0] && exponent === this._corner[1])
            return;
        this._corner = [radius, exponent];
        this._updateBed();
    }

    /// Moves the snow one column along its support and returns the column that slid off the end, as [height, x, y].
    slideColumn(direction) {
        this.releaseSupport();
        const h = this.heights;
        const p = this.packed;
        const last = h.length - 1;
        if (direction > 0) {
            const x = this.centerX(last);
            const y = this.floorAt(last);
            const dropped = h[last];
            h.copyWithin(1, 0, last);
            h[0] = 0;
            p.copyWithin(1, 0, last);
            p[0] = 0;
            return [dropped, x, y];
        }
        const x = this.centerX(0);
        const y = this.floorAt(0);
        const dropped = h[0];
        h.copyWithin(0, 1);
        h[last] = 0;
        p.copyWithin(0, 1);
        p[last] = 0;
        return [dropped, x, y];
    }

    fill(i) {
        return Math.max(1 - this.heights[i] / this._capacity[i], 0);
    }

    set(i, height) {
        this.heights[i] = Math.max(height, 0);
        this.packed[i] = Math.min(this.packed[i], this.heights[i]);
    }

    replace(fresh) {
        const count = fresh.length;
        this.heights = fresh;
        this.packed = new Float64Array(count);
        this.visible = new Uint8Array(count).fill(1);
        this._supported = new Uint8Array(count);
        this._supportedLow = -1;
        this._supportedHigh = -1;
        this._updateCapacity();
        this._updateBed();
    }

    resize(columns) {
        if (columns === this.heights.length)
            return;
        const fresh = new Float64Array(columns);
        fresh.set(this.heights.subarray(0, Math.min(columns, this.heights.length)));
        this.replace(fresh);
    }

    /// `blockers` are [left, bottom, right, top] rectangles in front of the layer.
    updateVisibility(screenWidth, blockers) {
        for (let i = 0; i < this.heights.length; i++) {
            const x = this.centerX(i);
            const y = this.originY + this.bed[i] + 1;
            let visible = x >= 0 && x <= screenWidth;
            for (let k = 0; visible && k < blockers.length; k++) {
                const b = blockers[k];
                if (x >= b[0] && x < b[2] && y >= b[1] && y < b[3])
                    visible = false;
            }
            this.visible[i] = visible ? 1 : 0;
        }
    }

    refreshTop() {
        let top = 0;
        for (let i = 0; i < this.heights.length; i++)
            top = Math.max(top, this.heights[i]);
        this.top = top;
    }

    /// Adds snow centred on `x` and returns the area that fell outside the layer.
    deposit(area, x, wide) {
        if (area <= 0)
            return 0;
        const center = Math.floor((x - this.baseX()) / this.columnWidth);
        const amount = area / this.columnWidth;
        const kernel = wide ? WIDE_KERNEL : NARROW_KERNEL;
        let missed = 0;
        for (let k = 0; k < kernel.length; k += 2) {
            const i = center + kernel[k];
            const weight = kernel[k + 1];
            if (i >= 0 && i < this.heights.length)
                this.heights[i] += amount * weight;
            else
                missed += area * weight;
        }
        return missed;
    }

    /// Piles snow against a wall just past column `edge`, as a plough heaps it: a wedge falling away from the wall
    /// at `slope` per column, the way `inward` points.
    heap(area, edge, inward, slope) {
        const amount = area / this.columnWidth;
        if (amount <= 0)
            return;
        let low = this.bed[edge] + this.heights[edge];
        let high = low + amount;
        for (let k = 0; k < 20; k++) {
            const middle = (low + high) / 2;
            if (this._wedge(middle, edge, inward, slope, 0) < amount)
                low = middle;
            else
                high = middle;
        }
        const total = this._wedge(high, edge, inward, slope, 0);
        this._wedge(high, edge, inward, slope, amount / total);
    }

    /// The snow it takes to raise the surface to a line falling away from `level` at `edge`; adds `scale` of it.
    _wedge(level, edge, inward, slope, scale) {
        const reach = inward > 0 ? this.heights.length - edge : edge + 1;
        let total = 0;
        for (let k = 0; k < reach; k++) {
            const line = level - slope * k;
            if (line <= -this.bedDepth)
                break;
            const i = inward > 0 ? edge + k : edge - k;
            const gap = line - (this.bed[i] + this.heights[i]);
            if (gap <= 0)
                continue;
            total += gap;
            this.heights[i] += gap * scale;
            this.packed[i] += gap * scale;
        }
        return total;
    }

    /// Columns touching the cursor are held up by it, so their walls don't slump into the hole until it leaves.
    hold(i) {
        this._supported[i] = 1;
        if (this._supportedLow < 0) {
            this._supportedLow = i;
            this._supportedHigh = i;
        } else {
            this._supportedLow = Math.min(this._supportedLow, i);
            this._supportedHigh = Math.max(this._supportedHigh, i);
        }
    }

    releaseSupport() {
        if (this._supportedLow < 0)
            return;
        this._supported.fill(0, this._supportedLow, this._supportedHigh + 1);
        this._supportedLow = -1;
        this._supportedHigh = -1;
    }

    /// Slumps slopes steeper than the angle of repose and rounds crests, measured on the snow surface over the bed,
    /// so snow slides off rounded corners. Open layers shed what slides past their ends into `spill`.
    relax(repose, rounding) {
        const count = this.heights.length;
        if (count <= 1 || this.top <= 0)
            return false;
        const limit = repose * this.columnWidth;
        const forwardFirst = this._parity;
        this._parity = !this._parity;
        let moved = false;
        let spilledLeft = 0;
        let spilledRight = 0;
        const open = this.opensAtEdges;
        const h = this.heights;
        const p = this.packed;
        const b = this.bed;
        const held = this._supported;

        for (let pass = 0; pass < 6; pass++) {
            const forward = (pass % 2 === 0) === forwardFirst;
            for (let k = 0; k < count - 1; k++) {
                const i = forward ? k : count - 2 - k;
                if (held[i] || held[i + 1])
                    continue;
                const difference = (b[i] + h[i]) - (b[i + 1] + h[i + 1]);
                if (difference > limit + 0.01) {
                    const transfer = Math.min((difference - limit) * 0.5, h[i]);
                    shift(h, p, transfer, i, i + 1);
                    if (transfer > 0)
                        moved = true;
                } else if (difference < -limit - 0.01) {
                    const transfer = Math.min((-difference - limit) * 0.5, h[i + 1]);
                    shift(h, p, transfer, i + 1, i);
                    if (transfer > 0)
                        moved = true;
                }
            }
            if (open) {
                if (!held[0] && h[0] > limit + 0.01) {
                    const transfer = (h[0] - limit) * 0.5;
                    h[0] -= transfer;
                    p[0] = Math.min(p[0], h[0]);
                    spilledLeft += transfer;
                    moved = true;
                }
                const last = count - 1;
                if (!held[last] && h[last] > limit + 0.01) {
                    const transfer = (h[last] - limit) * 0.5;
                    h[last] -= transfer;
                    p[last] = Math.min(p[last], h[last]);
                    spilledRight += transfer;
                    moved = true;
                }
            }
        }
        // Pulls each slope toward its neighbours' average: rounds crests and notches, leaves even slopes alone.
        const end = Math.max(count - 2, 1);
        for (let i = 1; i < end; i++) {
            if (held[i - 1] || held[i] || held[i + 1] || held[i + 2])
                continue;
            const s0 = b[i - 1] + h[i - 1];
            const s1 = b[i] + h[i];
            const s2 = b[i + 1] + h[i + 1];
            const s3 = b[i + 2] + h[i + 2];
            const kink = (s1 - s2) - 0.5 * ((s0 - s1) + (s2 - s3));
            if (Math.abs(kink) <= 0.02)
                continue;
            const transfer = kink > 0 ? Math.min(kink * rounding, h[i]) : Math.max(kink * rounding, -h[i + 1]);
            if (transfer > 0)
                shift(h, p, transfer, i, i + 1);
            else
                shift(h, p, -transfer, i + 1, i);
            if (Math.abs(transfer) > 0.003)
                moved = true;
        }
        this.spillLeft += spilledLeft * this.columnWidth;
        this.spillRight += spilledRight * this.columnWidth;
        return moved;
    }

    /// Snow down to `floor` melts slowly; anything heaped above it settles back down over `settle` seconds.
    thaw(dt, floor, rate, settle) {
        if (this.top <= 0)
            return false;
        let fastest = 0;
        const h = this.heights;
        const p = this.packed;
        for (let i = 0; i < h.length; i++) {
            if (h[i] <= 0)
                continue;
            const loss = Math.min(h[i], (rate + Math.max(h[i] - floor, 0) / settle) * dt);
            h[i] -= loss;
            p[i] = Math.min(p[i], h[i]);
            fastest = Math.max(fastest, loss);
        }
        // Sub-pixel melting is picked up by the idle glint refresh instead of forcing full-rate frames.
        return fastest > 0.01;
    }

    /// Writes the smoothed snow surface for each column from `offset`, then the bed under it.
    writeSmoothed(buffer, offset) {
        const h = this.heights;
        const count = h.length;
        for (let i = 0; i < count; i++) {
            const left = h[Math.max(i - 1, 0)];
            const right = h[Math.min(i + 1, count - 1)];
            buffer[offset + i] = this.bed[i] + 0.25 * left + 0.5 * h[i] + 0.25 * right;
            buffer[offset + count + i] = this.bed[i];
        }
    }

    _updateBed() {
        const [radius, exponent] = this._corner;
        const span = this.width();
        const count = this.heights.length;
        const bed = new Float64Array(count);
        let deepest = 0;
        for (let i = 0; i < count && radius > 0; i++) {
            const x = (i + 0.5) * this.columnWidth;
            const inset = Math.min(x, span - x);
            if (inset >= radius)
                continue;
            const u = 1 - inset / radius;
            bed[i] = -radius * (1 - Math.max(1 - u ** exponent, 0) ** (1 / exponent));
            deepest = Math.min(deepest, bed[i]);
        }
        this.bed = bed;
        this.bedDepth = -deepest;
    }

    _updateCapacity() {
        const [phase0, phase1] = this._phases;
        const count = this.heights.length;
        this._capacity = new Float64Array(count);
        for (let i = 0; i < count; i++) {
            const x = i * this.columnWidth;
            const drift = 0.12 * Math.sin(x * 0.0105 + phase0) + 0.07 * Math.sin(x * 0.037 + phase1);
            this._capacity[i] = this._depth * (0.95 + drift);
        }
    }
}

const WIDE_KERNEL = [-2, 0.0625, -1, 0.25, 0, 0.375, 1, 0.25, 2, 0.0625];
const NARROW_KERNEL = [-1, 0.25, 0, 0.5, 1, 0.25];

/// Moves snow between columns, packed snow in proportion.
function shift(h, p, amount, from, to) {
    const share = h[from] > 0 ? Math.min(p[from], amount * p[from] / h[from]) : 0;
    h[from] -= amount;
    h[to] += amount;
    p[from] -= share;
    p[to] += share;
}
