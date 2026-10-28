// Draws one display's snow on the GPU: the shaders of windows/src/shaders.hlsl in GLSL, through Cogl.
// Each frame is one vertex buffer for the drifts and one for the flakes, each drawn with a single call.

import Clutter from 'gi://Clutter';
import Cogl from 'gi://Cogl';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';

import {COLUMN_WIDTH, SPRITE_FLOATS} from './simulation.js';

/// Six vertices make a quad's two triangles; `CORNERS` are their corners, x then y up, as in the HLSL's vertex ids.
const CORNERS = [0, 1, 2, 2, 1, 3];

/// A sprite vertex: position, velocity and size as floats, then alpha, soft, lump and tint amount as bytes,
/// then the tint and the corner as bytes.
const SPRITE_STRIDE = 28;
/// A drift vertex: position, surface level, bed level and slope, all floats, in overlay coordinates.
const PILE_STRIDE = 20;

const SPRITE_VERTEX_DECLARATIONS = `
uniform float u_view_height;
uniform float u_scale;
uniform float u_unit;
uniform float u_time;
attribute vec2 a_velocity;
attribute float a_size;
attribute vec4 a_shape;
attribute vec4 a_tint;
varying vec2 v_coord;
varying float v_alpha;
varying float v_soft;
varying vec4 v_tint;
varying vec2 v_streak;
varying float v_radius;
varying float v_lump;
varying float v_spin;
`;

const SPRITE_VERTEX = `
    float pixels = a_size * u_scale;
    float lump = a_shape.z;
    // About a 1/55 s exposure, capped so even the fastest grain stays a short smear and never reads as rain.
    vec2 travel = a_velocity * 0.018;
    float smear = min(length(travel), a_size * (lump > 0.0 ? 1.2 : 2.2));
    vec2 streak = smear > 0.25 ? normalize(travel) * smear * u_scale : vec2(0.0);
    // A lump's ragged edge reaches past its nominal size.
    float reach = lump > 0.0 ? 1.3 : 1.0;
    float extent = max(pixels * reach + length(streak), 2.0);
    float index = floor(a_tint.w * 255.0 + 0.5);
    vec2 corner = vec2(mod(index, 2.0), floor(index / 2.0));
    // The overlay's y runs up from the bottom; the actor's runs down from the top.
    vec2 offset = (corner - 0.5) * extent / u_scale;
    vec2 local = vec2(cogl_position_in.x + offset.x, u_view_height - cogl_position_in.y - offset.y) * u_unit;
    cogl_position_out = cogl_modelview_projection_matrix * vec4(local, 0.0, 1.0);
    v_coord = vec2(corner.x, 1.0 - corner.y);
    v_streak = streak / extent;
    v_radius = pixels / extent * 0.5;
    // A streak spreads the same flake over more pixels, so each is fainter.
    v_alpha = a_shape.x * min(pixels / 2.0, 1.0) * pixels / max(pixels + length(streak) * 0.6, 0.001);
    v_soft = a_shape.y;
    v_tint = vec4(a_tint.rgb, a_shape.w);
    v_lump = lump;
    v_spin = lump > 0.0 ? u_time * (lump - 0.5) * 9.0 + lump * 40.0 : 0.0;
`;

const SPRITE_FRAGMENT_DECLARATIONS = `
uniform float u_light_r;
uniform float u_light_g;
uniform float u_light_b;
uniform float u_opacity;
varying vec2 v_coord;
varying float v_alpha;
varying float v_soft;
varying vec4 v_tint;
varying vec2 v_streak;
varying float v_radius;
varying float v_lump;
varying float v_spin;
`;

const SPRITE_FRAGMENT = `
    // Quad coordinates run down the screen; velocities run up.
    vec2 p = vec2(v_coord.x - 0.5, 0.5 - v_coord.y);
    vec2 half_streak = v_streak * 0.5;
    float span = dot(half_streak, half_streak);
    float t = span > 0.0 ? clamp(dot(p, half_streak) / span, -1.0, 1.0) : 0.0;
    vec2 d = p - half_streak * t;
    float r = length(d) / max(v_radius, 0.001);
    float shading = 0.0;
    if (v_lump > 0.0) {
        float angle = atan(d.y, d.x) + v_spin;
        r /= 1.0 + 0.14 * sin(3.0 * angle) + 0.08 * sin(5.0 * angle + v_lump * 21.0) + 0.05 * sin(2.0 * angle + v_lump * 9.0);
        shading = clamp(dot(d / max(v_radius, 0.001), vec2(0.45, -0.6)), 0.0, 1.0) * 0.4;
    }
    // Brighter at the head, where the flake is now, than at the tail, where it was.
    float head = span > 0.0 ? 0.15 + 0.85 * pow(t * 0.5 + 0.5, 1.5) : 1.0;
    float a = (1.0 - smoothstep(mix(0.6, 0.0, v_soft), 1.0, r)) * v_alpha * head * u_opacity;
    if (a < 0.002)
        discard;
    vec3 core = vec3(0.965, 0.975, 0.995);
    vec3 rim = vec3(0.62, 0.67, 0.77);
    vec3 color = mix(core, rim, clamp(smoothstep(0.35, 1.0, r) * 0.65 + shading, 0.0, 1.0));
    color = mix(color, v_tint.rgb, v_tint.a) * vec3(u_light_r, u_light_g, u_light_b);
    cogl_color_out = vec4(color * a, a);
`;

const PILE_VERTEX_DECLARATIONS = `
uniform float u_view_height;
uniform float u_unit;
attribute float a_level;
attribute float a_bed;
attribute float a_slope;
varying vec2 v_world;
varying float v_level;
varying float v_bed;
varying float v_slope;
`;

const PILE_VERTEX = `
    vec2 local = vec2(cogl_position_in.x, u_view_height - cogl_position_in.y) * u_unit;
    cogl_position_out = cogl_modelview_projection_matrix * vec4(local, 0.0, 1.0);
    v_world = cogl_position_in.xy;
    v_level = a_level;
    v_bed = a_bed;
    v_slope = a_slope;
`;

const PILE_FRAGMENT_DECLARATIONS = `
uniform float u_scale;
uniform float u_time;
uniform float u_light_r;
uniform float u_light_g;
uniform float u_light_b;
uniform float u_tint_r;
uniform float u_tint_g;
uniform float u_tint_b;
uniform float u_tint_a;
uniform float u_opacity;
varying vec2 v_world;
varying float v_level;
varying float v_bed;
varying float v_slope;

float snow_hash(vec2 p) {
    p = fract(p * vec2(123.34, 456.21));
    p += dot(p, p + 45.32);
    return fract(p.x * p.y);
}
`;

const PILE_FRAGMENT = `
    float depth = v_level - v_world.y;
    float coverage = clamp(depth * u_scale + 0.5, 0.0, 1.0)
        * clamp((v_world.y - v_bed) * u_scale + 0.5, 0.0, 1.0)
        * clamp((v_level - v_bed) / 0.75, 0.0, 1.0);
    if (coverage <= 0.0)
        discard;

    float lit = dot(normalize(vec2(-v_slope, 1.0)), normalize(vec2(-0.5, 1.0)));
    vec3 tint = vec3(u_tint_r, u_tint_g, u_tint_b);
    vec3 shadow = mix(vec3(0.72, 0.78, 0.88), tint, u_tint_a);
    vec3 surface = mix(vec3(0.925, 0.94, 0.965), min(tint * 1.18, vec3(1.0)), u_tint_a * 0.2);
    float shade = (1.0 - exp(-depth / 30.0)) * 0.32 + (1.0 - lit) * 0.6 * exp(-depth / 5.0);
    vec3 color = mix(surface, shadow, clamp(shade, 0.0, 1.0));
    color = mix(color, vec3(0.975, 0.982, 0.995), exp(-depth * 0.9) * 0.6);
    color += (snow_hash(floor(gl_FragCoord.xy)) - 0.5) * 0.02;

    float seed = snow_hash(floor(gl_FragCoord.xy * 0.5) + 31.7);
    if (seed > 0.992) {
        float twinkle = pow(clamp(sin(u_time * (0.6 + seed * 1.8) + seed * 90.0), 0.0, 1.0), 28.0);
        color = mix(color, vec3(1.0), twinkle * exp(-depth / 7.0));
    }

    color *= vec3(u_light_r, u_light_g, u_light_b);
    float a = coverage * u_opacity;
    cogl_color_out = vec4(color * a, a);
`;

/// The Cogl context the stage draws with.
export function coglContext() {
    const backend = global.stage.context?.get_backend?.() ?? Clutter.get_default_backend();
    return backend.get_cogl_context();
}

/// A pipeline running `vertex` and `fragment` in place of Cogl's own shaders.
function makePipeline(context, vertexDeclarations, vertex, fragmentDeclarations, fragment) {
    const pipeline = Cogl.Pipeline.new(context);
    const vertexSnippet = Cogl.Snippet.new(Cogl.SnippetHook.VERTEX, vertexDeclarations, null);
    vertexSnippet.set_replace(vertex);
    pipeline.add_snippet(vertexSnippet);
    const fragmentSnippet = Cogl.Snippet.new(Cogl.SnippetHook.FRAGMENT, fragmentDeclarations, null);
    fragmentSnippet.set_replace(fragment);
    pipeline.add_snippet(fragmentSnippet);
    // Colours come out premultiplied, as Cogl blends by default.
    pipeline.set_blend('RGBA = ADD (SRC_COLOR, DST_COLOR * (1 - SRC_COLOR[A]))');
    return pipeline;
}

/// A pipeline and the locations of its uniforms, set by name.
class Program {
    constructor(pipeline, names) {
        this.pipeline = pipeline;
        this._locations = new Map(names.map(name => [name, pipeline.get_uniform_location(name)]));
        this._values = new Map();
    }

    set(name, value) {
        if (this._values.get(name) === value)
            return;
        this._values.set(name, value);
        this.pipeline.set_uniform_1f(this._locations.get(name), value);
    }
}

/// A vertex buffer that grows as needed and is refilled every frame.
class Vertices {
    constructor(stride) {
        this.stride = stride;
        this.bytes = new Uint8Array(0);
        this.floats = new Float32Array(0);
        this._buffer = null;
        this._capacity = 0;
        this._primitive = null;
        this._attributes = [];
    }

    /// Room for `count` vertices in the arrays filled before `upload`.
    reserve(count) {
        if (count * this.stride <= this.bytes.length)
            return;
        const bytes = Math.max(4096, Math.ceil(count * 1.5)) * this.stride;
        this.bytes = new Uint8Array(bytes);
        this.floats = new Float32Array(this.bytes.buffer);
    }

    /// Sends the first `count` vertices to the GPU and returns the primitive that draws them, or null for none.
    upload(context, count, layout) {
        if (count === 0)
            return null;
        if (!this._buffer || this._capacity < this.bytes.length) {
            this._capacity = this.bytes.length;
            this._buffer = Cogl.AttributeBuffer.new_with_size(context, this._capacity);
            this._buffer.set_update_hint(Cogl.BufferUpdateHint.STREAM);
            this._attributes = layout.map(([name, offset, components, type, normalized]) => {
                const attribute = Cogl.Attribute.new(this._buffer, name, this.stride, offset, components, type);
                if (normalized)
                    attribute.set_normalized(true);
                return attribute;
            });
            this._primitive = Cogl.Primitive.new_with_attributes(Cogl.VerticesMode.TRIANGLES, count, this._attributes);
        }
        this._buffer.set_data(0, this.bytes.subarray(0, count * this.stride), count * this.stride);
        this._primitive.set_n_vertices(count);
        return this._primitive;
    }
}

const SPRITE_LAYOUT = [
    ['cogl_position_in', 0, 2, Cogl.AttributeType.FLOAT, false],
    ['a_velocity', 8, 2, Cogl.AttributeType.FLOAT, false],
    ['a_size', 16, 1, Cogl.AttributeType.FLOAT, false],
    ['a_shape', 20, 4, Cogl.AttributeType.UNSIGNED_BYTE, true],
    ['a_tint', 24, 4, Cogl.AttributeType.UNSIGNED_BYTE, true],
];

const PILE_LAYOUT = [
    ['cogl_position_in', 0, 2, Cogl.AttributeType.FLOAT, false],
    ['a_level', 8, 1, Cogl.AttributeType.FLOAT, false],
    ['a_bed', 12, 1, Cogl.AttributeType.FLOAT, false],
    ['a_slope', 16, 1, Cogl.AttributeType.FLOAT, false],
];

const toByte = value => Math.min(Math.max(Math.round(value * 255), 0), 255);

/// One display's snow, drawn over (or under) the windows on it. It never takes input.
export const SnowActor = GObject.registerClass(
class SnowActor extends Clutter.Actor {
    _init() {
        super._init({reactive: false, name: 'snowhush'});
        this._context = coglContext();
        this._sprites = new Program(
            makePipeline(this._context, SPRITE_VERTEX_DECLARATIONS, SPRITE_VERTEX, SPRITE_FRAGMENT_DECLARATIONS, SPRITE_FRAGMENT),
            ['u_view_height', 'u_scale', 'u_unit', 'u_time', 'u_light_r', 'u_light_g', 'u_light_b', 'u_opacity']);
        this._piles = new Program(
            makePipeline(this._context, PILE_VERTEX_DECLARATIONS, PILE_VERTEX, PILE_FRAGMENT_DECLARATIONS, PILE_FRAGMENT),
            ['u_view_height', 'u_unit', 'u_scale', 'u_time', 'u_light_r', 'u_light_g', 'u_light_b',
                'u_tint_r', 'u_tint_g', 'u_tint_b', 'u_tint_a', 'u_opacity']);
        this._spriteVertices = new Vertices(SPRITE_STRIDE);
        this._pileVertices = new Vertices(PILE_STRIDE);
        this._spriteData = new Float32Array(0);
        this._heights = new Float32Array(0);
        this._simulation = null;
        /// Stage pixels per overlay DIP: the overlay is laid out in DIPs, the stage in its own logical pixels.
        this._unit = 1;
        this._time = 0;
        this._light = [1, 1, 1];
        this._shadowTint = [0, 0, 0, 0];
        this._spriteCount = 0;
        this._pileCount = 0;
        /// Microseconds spent painting, for the stats.
        this.paintCost = 0;
    }

    /// Takes the simulation's current state for the next paint.
    update(simulation, {unit, time, light, shadowTint}) {
        this._simulation = simulation;
        this._unit = unit;
        this._time = time;
        this._light = light;
        this._shadowTint = shadowTint;
        this._fillSprites(simulation);
        this._fillPiles(simulation);
        this.queue_redraw();
    }

    clear() {
        this._spriteCount = 0;
        this._pileCount = 0;
        this.queue_redraw();
    }

    vfunc_get_paint_volume(volume) {
        return volume.set_from_allocation(this);
    }

    vfunc_paint(paintContext) {
        if (!this._simulation || (this._spriteCount === 0 && this._pileCount === 0))
            return;
        const began = GLib.get_monotonic_time();
        const framebuffer = paintContext.get_framebuffer();
        const scale = this._pixelScale(paintContext);
        const opacity = this.get_paint_opacity() / 255;
        const viewHeight = this._simulation.height();
        for (const program of [this._piles, this._sprites]) {
            program.set('u_view_height', viewHeight);
            program.set('u_unit', this._unit);
            program.set('u_scale', scale);
            program.set('u_time', this._time);
            program.set('u_light_r', this._light[0]);
            program.set('u_light_g', this._light[1]);
            program.set('u_light_b', this._light[2]);
            program.set('u_opacity', opacity);
        }
        this._piles.set('u_tint_r', this._shadowTint[0]);
        this._piles.set('u_tint_g', this._shadowTint[1]);
        this._piles.set('u_tint_b', this._shadowTint[2]);
        this._piles.set('u_tint_a', this._shadowTint[3]);

        const piles = this._pileVertices.upload(this._context, this._pileCount, PILE_LAYOUT);
        piles?.draw(framebuffer, this._piles.pipeline);
        const sprites = this._spriteVertices.upload(this._context, this._spriteCount, SPRITE_LAYOUT);
        sprites?.draw(framebuffer, this._sprites.pipeline);
        this.paintCost += GLib.get_monotonic_time() - began;
    }

    /// Framebuffer pixels per overlay DIP, for crisp edges and sizes measured in pixels.
    _pixelScale(paintContext) {
        const view = paintContext.get_stage_view?.();
        const viewScale = view?.get_scale?.() ?? this.get_resource_scale();
        return viewScale * this._unit;
    }

    _fillSprites(simulation) {
        const total = simulation.spriteCount();
        if (this._spriteData.length < total * SPRITE_FLOATS)
            this._spriteData = new Float32Array(Math.max(1024, Math.ceil(total * 1.5)) * SPRITE_FLOATS);
        const count = simulation.writeSprites(this._spriteData);
        const vertices = this._spriteVertices;
        vertices.reserve(count * 6);
        const data = this._spriteData;
        const floats = vertices.floats;
        const bytes = vertices.bytes;
        for (let s = 0; s < count; s++) {
            const i = s * SPRITE_FLOATS;
            const x = data[i], y = data[i + 1], vx = data[i + 2], vy = data[i + 3], size = data[i + 4];
            const alpha = toByte(data[i + 5]), soft = toByte(data[i + 6]), lump = toByte(data[i + 7]);
            const r = toByte(data[i + 8]), g = toByte(data[i + 9]), b = toByte(data[i + 10]), tint = toByte(data[i + 11]);
            for (let c = 0; c < 6; c++) {
                const v = (s * 6 + c) * SPRITE_STRIDE;
                const f = v >> 2;
                floats[f] = x;
                floats[f + 1] = y;
                floats[f + 2] = vx;
                floats[f + 3] = vy;
                floats[f + 4] = size;
                bytes[v + 20] = alpha;
                bytes[v + 21] = soft;
                // A lump between 0 and 1/255 would read as round, so it is kept at least that.
                bytes[v + 22] = data[i + 7] > 0 ? Math.max(lump, 1) : 0;
                bytes[v + 23] = tint;
                bytes[v + 24] = r;
                bytes[v + 25] = g;
                bytes[v + 26] = b;
                bytes[v + 27] = CORNERS[c];
            }
        }
        this._spriteCount = count * 6;
    }

    /// Each layer becomes a strip of quads, one between each pair of column centres, reaching from just under the bed
    /// to just over the snow; the levels between centres interpolate as the HLSL's `heightAt` does. Parts behind
    /// windows in front are left out.
    _fillPiles(simulation) {
        const needed = simulation.columnCount();
        if (this._heights.length < needed)
            this._heights = new Float32Array(Math.ceil(needed * 1.5));
        const heights = this._heights;
        const layers = simulation.writeLayers(heights);
        let quads = 0;
        for (const pile of layers)
            quads += (pile.count + 1) * (1 + pile.occluders.length);
        const vertices = this._pileVertices;
        vertices.reserve(quads * 6);
        this._floats = vertices.floats;
        this._vertex = 0;
        for (const pile of layers) {
            const {offset, count, originX, originY, occluders} = pile;
            const last = count - 1;
            const bedOffset = offset + count;
            // Spans run from centre to centre, with half columns at each end where the level holds steady.
            for (let i = -1; i < count; i++) {
                const left = i < 0 ? 0 : i;
                const right = i < last ? i + 1 : last;
                const levelLeft = originY + heights[offset + left];
                const levelRight = originY + heights[offset + right];
                const bedLeft = originY + heights[bedOffset + left];
                const bedRight = originY + heights[bedOffset + right];
                if (levelLeft - bedLeft < 0.05 && levelRight - bedRight < 0.05)
                    continue;
                // The slope over two columns either side, as the HLSL samples it.
                const slopeLeft = (heights[offset + (left < last ? left + 1 : last)] - heights[offset + (left > 0 ? left - 1 : 0)]) * 0.25;
                const slopeRight = (heights[offset + (right < last ? right + 1 : last)] - heights[offset + (right > 0 ? right - 1 : 0)]) * 0.25;
                const x0 = originX + (i < 0 ? 0 : (i + 0.5) * COLUMN_WIDTH);
                const x1 = originX + (i < last ? (i + 1.5) * COLUMN_WIDTH : count * COLUMN_WIDTH);
                let y0 = Math.min(bedLeft, bedRight) - 1;
                const y1 = Math.max(levelLeft, levelRight) + 2;
                // Windows in front hide the snow behind them: what shows of the span is cut around them.
                if (occluders.length > 0) {
                    const middle = (x0 + x1) / 2;
                    for (;;) {
                        let cut = null;
                        for (const o of occluders) {
                            if (middle >= o[0] && middle < o[2] && o[3] > y0 && o[1] < y1 && (!cut || o[1] < cut[1]))
                                cut = o;
                        }
                        if (!cut)
                            break;
                        if (cut[1] > y0)
                            this._pileQuad(x0, x1, y0, cut[1], levelLeft, levelRight, bedLeft, bedRight, slopeLeft, slopeRight);
                        y0 = cut[3];
                    }
                }
                if (y1 > y0)
                    this._pileQuad(x0, x1, y0, y1, levelLeft, levelRight, bedLeft, bedRight, slopeLeft, slopeRight);
            }
        }
        this._pileCount = this._vertex;
    }

    _pileQuad(x0, x1, y0, y1, levelLeft, levelRight, bedLeft, bedRight, slopeLeft, slopeRight) {
        const floats = this._floats;
        for (let c = 0; c < 6; c++) {
            const corner = CORNERS[c];
            const f = this._vertex * 5;
            if (corner & 1) {
                floats[f] = x1;
                floats[f + 2] = levelRight;
                floats[f + 3] = bedRight;
                floats[f + 4] = slopeRight;
            } else {
                floats[f] = x0;
                floats[f + 2] = levelLeft;
                floats[f + 3] = bedLeft;
                floats[f + 4] = slopeLeft;
            }
            floats[f + 1] = corner & 2 ? y1 : y0;
            this._vertex++;
        }
    }
});
