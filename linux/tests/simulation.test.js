// A port of windows/src/tests.rs. Run with: gjs -m linux/tests/simulation.test.js [--bench]

import {SnowSimulation, Snowfall, SPRITE_FLOATS} from '../extension/simulation.js';

const DT = 1 / 60;
const AWAY = [-10000, -10000];
const NONE = new Set();

function run(simulation, seconds, cursor = AWAY) {
    const steps = Math.trunc(seconds / DT);
    for (let i = 0; i < steps; i++)
        simulation.step(DT, cursor[0], cursor[1]);
}

function surface(id, x, top, width) {
    return {id, frame: {x, y: top - 300, width, height: 300}, blockers: [], cornerRadius: 8, cornerExponent: 2.5};
}

/// Snow area per layer, from the smoothed surfaces the renderer gets, as [originX, originY, area].
function piles(simulation) {
    const buffer = new Float32Array(simulation.columnCount());
    return simulation.writeLayers(buffer).map(pile => {
        let area = 0;
        for (let i = 0; i < pile.count; i++)
            area += buffer[pile.offset + i] - buffer[pile.offset + pile.count + i];
        return [pile.originX, pile.originY, area * 2];
    });
}

function ledge(simulation) {
    return piles(simulation).find(pile => pile[1] > 500)?.[2] ?? 0;
}

function sprites(simulation) {
    const buffer = new Float32Array((simulation.spriteCount() + 1) * SPRITE_FLOATS);
    const count = simulation.writeSprites(buffer);
    return {buffer, count};
}

function assert(condition, message) {
    if (!condition)
        throw new Error(message ?? 'assertion failed');
}

function assertFinite(simulation) {
    const {buffer, count} = sprites(simulation);
    for (let i = 0; i < count * SPRITE_FLOATS; i++)
        assert(Number.isFinite(buffer[i]), `sprite value ${i} is ${buffer[i]}`);
    const layers = new Float32Array(simulation.columnCount());
    simulation.writeLayers(layers);
    assert(layers.every(Number.isFinite), 'a layer height is not finite');
}

function shake(simulation, id) {
    let t = 0;
    for (let i = 0; i < 120; i++) {
        t += DT;
        const x = 300 + 150 * Math.sin(2 * Math.PI * 4 * t);
        simulation.updateWindows([surface(id, x, 600, 500)], DT, NONE, NONE, false);
        simulation.step(DT, AWAY[0], AWAY[1]);
    }
}

const tests = {
    snow_falls_and_settles_on_the_ground() {
        const simulation = new SnowSimulation(1280, 800, Snowfall.HEAVY);
        run(simulation, 1);
        assert(simulation.spriteCount() > 500, `flakes: ${simulation.spriteCount()}`);
        run(simulation, 60);
        assert(simulation.hasSnow());
        const layers = piles(simulation);
        assert(layers.length === 1);
        assert(layers[0][2] > 1000, `ground area ${layers[0][2]}`);
        assertFinite(simulation);
    },

    off_stops_the_snowfall() {
        const simulation = new SnowSimulation(1280, 800, Snowfall.OFF);
        run(simulation, 30);
        assert(simulation.spriteCount() === 0);
        assert(!simulation.hasSnow());
    },

    cursor_sweeps_the_drift_aside() {
        const simulation = new SnowSimulation(1280, 800, Snowfall.HEAVY);
        simulation.thaws = false;
        run(simulation, 120);
        simulation.setSnowfall(Snowfall.OFF);
        run(simulation, 15);
        const before = piles(simulation)[0][2];

        let sprayed = 0;
        for (let i = 0; i < 120; i++) {
            simulation.step(DT, 200 + i * 8, 10);
            sprayed = Math.max(sprayed, simulation.spriteCount());
        }
        assert(sprayed > 20, `no snow thrown up: ${sprayed}`);
        run(simulation, 10);
        const after = piles(simulation)[0][2];
        // Swept snow lands again; it moves rather than vanishes.
        assert(Math.abs(after - before) / before < 0.1, `before ${before}, after ${after}`);
        assertFinite(simulation);
    },

    a_gust_blows_all_the_snow_away() {
        const simulation = new SnowSimulation(1280, 800, Snowfall.HEAVY);
        simulation.updateWindows([surface(7, 300, 600, 500)], 0.2, NONE, NONE, false);
        run(simulation, 90);
        assert(piles(simulation).length === 2);

        simulation.blowAway(1, false);
        run(simulation, 1.5);
        assert(!simulation.hasSnow(), `drifts left: ${JSON.stringify(piles(simulation))}`);
        run(simulation, 3);
        // The new snowfall starts above the screen and hasn't reached the ground yet.
        assert(!simulation.hasSnow());
        const {buffer, count} = sprites(simulation);
        for (let i = 0; i < count; i++)
            assert(buffer[i * SPRITE_FLOATS + 1] > 400, 'snow left in the lower half');
        run(simulation, 60);
        assert(simulation.hasSnow(), "the snowfall didn't come back");
        assertFinite(simulation);
    },

    a_calm_gust_melts_the_drifts_where_they_lie() {
        const simulation = new SnowSimulation(1280, 800, Snowfall.HEAVY);
        run(simulation, 90);
        simulation.setSnowfall(Snowfall.OFF);
        const before = piles(simulation)[0][2];
        const falling = simulation.spriteCount();
        simulation.blowAway(-1, true);
        simulation.step(DT, AWAY[0], AWAY[1]);
        assert(simulation.spriteCount() <= falling, "a calm gust shouldn't throw anything up");
        run(simulation, 2);
        // Only the last of the snowfall, still landing, is left.
        const after = piles(simulation)[0]?.[2] ?? 0;
        assert(after < before * 0.05, `before ${before}, after ${after}`);
    },

    snow_settles_on_a_window_and_drops_when_it_closes() {
        const simulation = new SnowSimulation(1280, 800, Snowfall.HEAVY);
        simulation.updateWindows([surface(7, 300, 600, 500)], 0.2, NONE, NONE, false);
        run(simulation, 90);
        const layers = piles(simulation);
        assert(layers.length === 2, 'no snow on the window');
        const found = layers.find(pile => pile[1] > 500);
        assert(found && found[2] > 200, `ledge area ${found?.[2]}`);

        simulation.setSnowfall(Snowfall.OFF);
        simulation.updateWindows([], 0.2, NONE, NONE, false);
        simulation.step(DT, AWAY[0], AWAY[1]);
        assert(simulation.spriteCount() > 20, "the window's snow didn't fall");
        run(simulation, 5);
        assert(piles(simulation).length === 1);
        assertFinite(simulation);
    },

    dragged_window_sheds_its_snow() {
        const simulation = new SnowSimulation(1280, 800, Snowfall.HEAVY);
        simulation.thaws = false;
        simulation.updateWindows([surface(3, 300, 600, 500)], 0.2, NONE, NONE, false);
        run(simulation, 90);
        simulation.setSnowfall(Snowfall.OFF);
        run(simulation, 10);
        const resting = ledge(simulation);

        // Shaken hard from side to side, as when a window is dragged back and forth.
        shake(simulation, 3);
        run(simulation, 3);
        const shaken = ledge(simulation);
        assert(shaken < resting * 0.7, `resting ${resting}, after shaking ${shaken}`);
        assertFinite(simulation);
    },

    scattered_window_starts_the_held_snowfall() {
        const simulation = new SnowSimulation(1280, 800, Snowfall.STEADY);
        simulation.setSnowfallHeld(true);
        run(simulation, 2);
        assert(simulation.spriteCount() === 0, 'snowfall should wait for the welcome window');

        const pieces = [];
        for (let i = 0; i < 2000; i++)
            pieces.push({x: 420 + (i % 70) * 6, y: 300 + Math.trunc(i / 70) * 6, vx: 0, vy: 60, color: [0.1, 0.09, 0.07]});
        simulation.scatter(pieces);
        let released = false;
        for (let i = 0; i < Math.trunc(10 / DT); i++) {
            simulation.step(DT, AWAY[0], AWAY[1]);
            released ||= simulation.takeSnowfallReleased();
        }
        assert(released, 'the scattered snow never reached the ground');
        run(simulation, 10);
        assert(simulation.spriteCount() > 200, `snowfall didn't start: ${simulation.spriteCount()}`);
        assertFinite(simulation);
    },

    a_window_slid_past_the_screen_edge_leaves_its_snow_heaped_against_it() {
        for (const [out, wall] of [[-300, 0], [1080, 1280]]) {
            const simulation = new SnowSimulation(1280, 800, Snowfall.HEAVY);
            simulation.thaws = false;
            simulation.walls = [true, true];
            simulation.updateWindows([surface(5, 400, 600, 500)], 0.2, NONE, NONE, false);
            run(simulation, 90);
            simulation.setSnowfall(Snowfall.OFF);
            run(simulation, 10);
            const resting = ledge(simulation);

            for (let step = 1; step <= 180; step++) {
                const x = 400 + (out - 400) * step / 180;
                simulation.updateWindows([surface(5, x, 600, 500)], DT, NONE, NONE, false);
                simulation.step(DT, AWAY[0], AWAY[1]);
            }
            run(simulation, 5);
            const heaped = ledge(simulation);
            // Three fifths of the window went past the wall, and their snow packs down once, to 0.6 of its bulk.
            assert(Math.abs(heaped / resting - 0.76) < 0.08, `resting ${resting}, against the wall ${heaped}`);

            const buffer = new Float32Array(simulation.columnCount());
            const pile = simulation.writeLayers(buffer).find(layer => layer.originY > 500);
            assert(pile, 'ledge');
            const depth = i => buffer[pile.offset + i] - buffer[pile.offset + pile.count + i];
            const x = i => pile.originX + (i + 0.5) * 2;
            let past = 0;
            let deepest = 0;
            for (let i = 0; i < pile.count; i++) {
                if (Math.abs(x(i) - wall) > 4 && (x(i) < 0 || x(i) > 1280))
                    past = Math.max(past, depth(i));
                if (depth(i) > depth(deepest))
                    deepest = i;
            }
            assert(past < 0.01, `snow left past the edge at ${wall}: ${past}`);
            assert(Math.abs(x(deepest) - wall) < 30, `deepest snow at ${x(deepest)}, the wall at ${wall}`);
            assertFinite(simulation);
        }
    },

    snow_waits_for_a_window_on_another_workspace() {
        const simulation = new SnowSimulation(1280, 800, Snowfall.HEAVY);
        simulation.thaws = false;
        simulation.updateWindows([surface(9, 300, 600, 500)], 0.2, NONE, NONE, false);
        run(simulation, 90);
        simulation.setSnowfall(Snowfall.OFF);
        run(simulation, 10);
        const resting = ledge(simulation);
        assert(resting > 200, `ledge area ${resting}`);

        const falling = simulation.spriteCount();
        simulation.spaceChanged();
        simulation.updateWindows([], 0.2, NONE, new Set([9]), false);
        simulation.step(DT, AWAY[0], AWAY[1]);
        assert(simulation.spriteCount() <= falling, `the waiting snow fell: ${simulation.spriteCount()} from ${falling}`);
        run(simulation, 2);
        simulation.updateWindows([surface(9, 500, 650, 500)], 0.2, NONE, NONE, false);
        run(simulation, DT);
        const back = ledge(simulation);
        assert(Math.abs(back - resting) / resting < 0.1, `resting ${resting}, back ${back}`);
    },

    survives_a_long_chaotic_session() {
        const simulation = new SnowSimulation(1920, 1080, Snowfall.VARIABLE);
        let seed = 12345;
        const next = () => {
            seed ^= seed << 13;
            seed ^= seed >>> 17;
            seed ^= seed << 5;
            return (seed >>> 8) / (1 << 24);
        };
        const windows = [];
        let cursor = [500, 100];
        for (let frame = 0; frame < 40000; frame++) {
            if (frame % 30 === 0) {
                const roll = next();
                if (roll < 0.2 && windows.length < 6)
                    windows.push([frame + 1, next() * 1600 - 100, 200 + next() * 850, 60 + next() * 900]);
                else if (roll < 0.3 && windows.length > 0)
                    windows.splice(Math.trunc(next() * windows.length) % windows.length, 1);
            }
            for (const window of windows) {
                if (next() < 0.05) {
                    window[1] += (next() - 0.5) * 400;
                    window[2] += (next() - 0.5) * 200;
                }
                if (next() < 0.01)
                    window[3] = 20 + next() * 1200;
            }
            simulation.updateWindows(windows.map(([id, x, top, width]) => surface(id, x, top, width)), DT, NONE, NONE, false);
            if (next() < 0.3)
                cursor = [cursor[0] + (next() - 0.5) * 300, cursor[1] + (next() - 0.5) * 200];
            if (frame % 5000 === 0) {
                simulation.thaws = !simulation.thaws;
                simulation.accumulates = frame % 15000 !== 0;
            }
            if (frame === 20000)
                simulation.resize(1280, 720);
            const dt = next() < 0.01 ? 0.05 : DT;
            simulation.step(dt, cursor[0], cursor[1]);
        }
        assertFinite(simulation);
    },
};

function bench() {
    const simulation = new SnowSimulation(1920, 1080, Snowfall.STEADY);
    simulation.thaws = true;
    const window = {id: 1, frame: {x: 200, y: 300, width: 900, height: 500}, blockers: [], cornerRadius: 8, cornerExponent: 2.5};
    simulation.updateWindows([window], 0.2, NONE, NONE, false);
    for (let i = 0; i < 60 * 30; i++)
        simulation.step(1 / 30, AWAY[0], AWAY[1]);
    const steps = 30 * 120;
    const buffer = new Float32Array(20000 * SPRITE_FLOATS * 4);
    const start = Date.now();
    for (let i = 0; i < steps; i++) {
        simulation.step(1 / 30, i % 1900, 20);
        simulation.writeSprites(buffer, 4);
    }
    const us = (Date.now() - start) * 1000 / steps;
    print(`js: ${us.toFixed(1)} µs per step and sprite write, ${simulation.spriteCount()} sprites`);
}

const args = typeof ARGV !== 'undefined' ? ARGV : process.argv.slice(2);
const log = typeof print !== 'undefined' ? print : console.log;
if (args.includes('--bench')) {
    globalThis.print ??= console.log;
    bench();
} else {
    let failed = 0;
    for (const [name, test] of Object.entries(tests)) {
        if (args.length > 0 && !args.includes(name))
            continue;
        const started = Date.now();
        try {
            test();
            log(`ok    ${name} (${((Date.now() - started) / 1000).toFixed(1)} s)`);
        } catch (error) {
            failed++;
            log(`FAIL  ${name}: ${error.message}`);
        }
    }
    log(failed ? `${failed} failed` : 'all passed');
    if (failed) {
        if (typeof imports !== 'undefined')
            imports.system.exit(1);
        else
            process.exit(1);
    }
}
