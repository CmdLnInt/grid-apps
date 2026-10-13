import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

// Execute the actual Topo/Probe/Trace code without loading the browser-only
// geometry dependency graph. These doubles only supply polygon storage,
// rectangular point-in-polygon tests, and slice/box containers.
const source = fs.readFileSync(new URL('../src/kiri/mode/cam/work/topo3.js', import.meta.url), 'utf8');
const box = (minX, minY, maxX, maxY) => ({
    min: { x: minX, y: minY }, max: { x: maxX, y: maxY },
    clone() { return box(this.min.x, this.min.y, this.max.x, this.max.y); },
    expandByVector(v) { this.min.x -= v.x; this.min.y -= v.y; this.max.x += v.x; this.max.y += v.y; return this; }
});
const context = vm.createContext({
    THREE: { Vector3: class { constructor(x, y, z) { Object.assign(this, { x, y, z }); } } },
    self: { kiri_worker: { minions: { running: true, broadcast() { throw Error('prototype must not dispatch minions'); } } } },
    newPoint: (x, y, z = 0) => ({ x, y, z, isInPolygon(p) {
        return x >= p.min.x && x <= p.max.x && y >= p.min.y && y <= p.max.y;
    } }),
    newPolygon: () => ({ points: [], setOpen() { this.open = true; return this; },
        push(p) { this.points.push(p); }, get length() { return this.points.length; } }),
    newSlice: z => ({ z, output() {
        return { setLayer() { return this; }, addPolys() { return this; } };
    } }), console
});
vm.runInContext(source.replace(/^import .*;\s*$/gm, '').replace(/\bexport /g, '') + '\nglobalThis.classes = { Probe, Trace, Topo };', context);
const { Probe, Trace, Topo } = context.classes;

function setup(overrides = {}, cross = {}, traceOptions = {}) {
    // Non-square, non-integral bounds: bounds/steps differs from pixel size.
    const params = { minX: 10, minY: -4, boundsX: 7.3, boundsY: 4.3,
        stepsX: 8, stepsY: 5, resolution: 1, zMin: 0,
        data: new Float32Array(40).fill(3), profile: [0, 0, 0], ...overrides };
    const probe = new Probe(params);
    const trace = new Trace(probe, { flatness: 0.01, ...traceOptions });
    trace.init({ box: box(10, -4, 17, 0), resolution: 1, density: 1,
        leave: 0, concurrent: false, ...cross });
    return { probe, trace };
}
const points = segments => segments.flatMap(s => s.points);

test('retains flat-Z XY curvature, endpoints, and short input vertices', () => {
    const { trace } = setup({}, {}, { curvesOnly: true, maxangle: 0 });
    const path = [{ x: 10, y: -4 }, { x: 12, y: -2 }, { x: 12.2, y: -1.9 }, { x: 16, y: -4 }];
    const segments = trace.followPath_sync(path);
    assert.equal(segments.length, 1);
    assert.ok(segments[0].open);
    assert.ok(segments[0].length > path.length);
    for (const p of path) assert.ok(points(segments).some(q => q.x === p.x && q.y === p.y));
    assert.ok(points(segments).every(p => p.z === 3));
    for (let i = 1; i < segments[0].length; i++) {
        const a = segments[0].points[i - 1], b = segments[0].points[i];
        assert.ok(Math.hypot(b.x - a.x, b.y - a.y) <= 1 + 1e-10);
    }
});

test('maps physical coordinates using actual pixel spacing and compensates the cutter', () => {
    const data = new Float32Array(40).fill(3);
    data[4 * 5 + 2] = 11;
    const { trace, probe } = setup({ data, profile: [0, 0, 0, 1, 0, -2] }, { leave: 0.5 });
    const calls = [];
    const sample = probe.toolAtZ;
    probe.toolAtZ = (x, y) => { calls.push([x, y]); return sample(x, y); };
    const out = trace.followPath_sync([{ x: 13, y: -2 }, { x: 13, y: -1.75 }]);
    assert.deepEqual(calls, [[3, 2], [3, 2]]);
    assert.ok(points(out).every(p => p.z === 9.5)); // raised neighbor 11 - cutter height 2 + leave
});

test('splits at clipping exits and re-entry without connecting excluded samples', () => {
    const clips = [box(10, -4, 12, 0), box(15, -4, 17, 0)];
    const { trace } = setup({}, { clipTo: clips });
    const out = trace.followPath_sync([{ x: 10, y: -2 }, { x: 17, y: -2 }]);
    assert.equal(out.length, 2);
    assert.ok(out[0].points.every(p => p.x <= 12));
    assert.ok(out[1].points.every(p => p.x >= 15));
});

test('checks both physical bounds and integer raster bounds and splits on re-entry', () => {
    const { trace, probe } = setup({}, { box: box(0, -10, 30, 10) });
    const sample = probe.toolAtZ;
    probe.toolAtZ = (x, y) => {
        assert.ok(Number.isInteger(x) && x >= 0 && x < 8);
        assert.ok(Number.isInteger(y) && y >= 0 && y < 5);
        return sample(x, y);
    };
    const out = trace.followPath_sync([
        { x: 10, y: -2 }, { x: 12, y: -2 }, { x: 12, y: 2 },
        { x: 14, y: -2 }, { x: 20, y: -2 }, { x: 16, y: -2 }
    ]);
    assert.ok(out.length >= 3);
    assert.ok(points(out).every(p => p.x >= 10 && p.x <= 17 && p.y >= -4 && p.y <= 0));
});

test('uses matching tab height, including overlapping tabs, before leave', () => {
    const tabs = [Object.assign(box(10, -4, 14, 0), { z: 7 }), Object.assign(box(13, -4, 15, 0), { z: 9 }),
        Object.assign(box(16, -4, 17, 0), { z: 12 })];
    const { trace } = setup({}, { clipTab: tabs, clipTabZ: [7, 9, 12], tabHeight: 12, leave: 0.5 });
    const out = trace.followPath_sync([{ x: 12, y: -2 }, { x: 14, y: -2 }]);
    assert.equal(out[0].points[0].z, 7.5);
    assert.equal(out[0].points.at(-1).z, 9.5);
});

test('prototype produces camLines with neither axis enabled and no minion dispatch', async () => {
    const { trace } = setup();
    const topo = new Topo();
    topo.trace = trace;
    const newslices = [];
    await topo.contour({ minX: 10, maxX: 17, minY: -4, maxY: 0, boundsX: 7, boundsY: 4,
        box: box(10, -4, 17, 0), partOff: 0, resolution: 1, density: 1,
        contourX: false, contourY: false, curvedPathPrototype: true, newslices, leave: 0 }, () => {});
    assert.equal(newslices.length, 1);
    assert.ok(newslices[0].camLines[0].length >= 65);
    assert.match(source, /if \(webGPU && !contour\.nogpu && !curvedPathPrototype\)/);
    const disabled = [];
    await topo.contour({ contourX: false, contourY: false, newslices: disabled }, () => {});
    assert.equal(disabled.length, 0);
});

// Gouging diagnostics: an asymmetric surface with a narrow, steep nose at
// longitudinal coordinate 17.5 and a nearly flat tail. Units below are mm.
const { Tool } = await import('../src/kiri/mode/cam/core/tool.js');
const noseSurface = (x, y) => {
    const longitudinal = x + 10;
    return 5 + 0.02 * longitudinal + 8 * Math.exp(-(((longitudinal - 17.5) / 1.3) ** 2)) + 0.1 * y ** 2;
};
function noseSetup(resolution = 1, profileResolution = resolution, cross = {}) {
    const tool = new Tool({ controller: { units: 'mm' }, tools: [{ id: 1, type: 'bullnose', metric: true,
        flute_diam: 4, flute_len: 10, shaft_diam: 2, shaft_len: 10,
        taper_tip: 0, corner_radius: 0.6, bottom_radius: 20 }] }, 1);
    tool.generateProfile(profileResolution);
    const stepsX = Math.ceil(20.4 / resolution), stepsY = Math.ceil(6.4 / resolution);
    const data = new Float32Array(stepsX * stepsY);
    for (let x = 0; x < stepsX; x++) for (let y = 0; y < stepsY; y++) {
        data[x * stepsY + y] = noseSurface(-10 + x * resolution, -3 + y * resolution);
    }
    const { probe, trace } = setup({ minX: -10, minY: -3, boundsX: 20.4, boundsY: 6.4,
        stepsX, stepsY, resolution, data, profile: tool.profile }, {
        box: box(-10, -3, -10 + (stepsX - 1) * resolution, -3 + (stepsY - 1) * resolution),
        resolution, density: 1, ...cross
    });
    return { probe, trace, tool };
}
function curvedZ(trace, x, y) {
    return trace.followPath_sync([{ x, y }, { x: x + 1e-4, y }])[0].points[0].z;
}
function straightZ(trace, axis, x, y, gridx, gridy) {
    // Capture the actual sampler's push_point arguments before its separate
    // Z-only simplifier. One sample is sufficient to compare identical XY.
    const captured = [];
    trace.push_point = (px, py, z) => captured.push({ x: px, y: py, z });
    if (axis === 'x') trace.crossX_sync({ from: x, to: x + 1e-4, y, gridx, gridy }, () => {});
    else trace.crossY_sync({ from: y, to: y + 1e-4, x, gridx, gridy }, () => {});
    assert.equal(captured.length, 1);
    assert.equal(captured[0].x, x);
    assert.equal(captured[0].y, y);
    return captured[0].z;
}
function continuousZ(tool, x, y) {
    let z = -Infinity;
    // Dense analytic footprint reference, independent of raster indexing.
    for (let dx = -2; dx <= 2; dx += 0.05) for (let dy = -2; dy <= 2; dy += 0.05) {
        const radius = Math.hypot(dx, dy);
        if (radius <= 2) z = Math.max(z, noseSurface(x + dx, y + dy) - tool.bullNoseHeight(radius));
    }
    return z;
}

test('diagnostic: both scanline samplers and curved sampler agree at matched raster indices', () => {
    const { trace, probe } = noseSetup(1, 1, { leave: 0.25 });
    for (const x of [-7, 5, 6, 7]) {
        const y = 0, gx = x + 10, gy = y + 3;
        const curved = curvedZ(trace, x, y);
        assert.equal(curved, probe.toolAtZ(gx, gy) + 0.25);
        assert.equal(curved, straightZ(trace, 'x', x, y, gx, gy));
        assert.equal(curved, straightZ(trace, 'y', x, y, gx, gy));
    }
});

test('diagnostic: bounds/steps fixed-axis mapping can raise old scanline Z near the nose', t => {
    const { trace, probe } = noseSetup();
    const rows = [];
    for (const x of [-7.6, 5.4]) {
        const curved = curvedZ(trace, x, 0);
        const gx = Math.round((x + 10) / 20.4 * probe.params.stepsX);
        const legacy = straightZ(trace, 'y', x, 0, gx, 3);
        rows.push({ x, curvedIndex: Math.round(x + 10), legacyIndex: gx, curved, legacy, difference: legacy - curved });
    }
    assert.equal(rows[0].difference, 0);
    assert.ok(rows[1].difference > 0.1);
    t.diagnostic(JSON.stringify(rows));
    // CrossX uses the same bounds/steps inflation on its fixed Y axis.
    const y = -0.6;
    const gx = 16, gy = Math.round((y + 3) / 6.4 * probe.params.stepsY);
    const curved = curvedZ(trace, 6, y);
    const legacy = straightZ(trace, 'x', 6, y, gx, gy);
    assert.notEqual(legacy, curved);
    t.diagnostic(JSON.stringify({ crossX: { x: 6, y, curvedIndexY: 2, legacyIndexY: gy, curved, legacy } }));
});

test('diagnostic: nearest-cell compensation underestimates the continuous nose more than the tail', t => {
    const { trace, tool } = noseSetup();
    const rows = [-7.6, 6.4].map(x => {
        const sampled = curvedZ(trace, x, 0), reference = continuousZ(tool, x, 0);
        return { x, sampled, reference, deficit: reference - sampled };
    });
    assert.ok(rows[1].deficit > 0.1);
    assert.ok(rows[1].deficit > Math.abs(rows[0].deficit) * 5);
    const fine = noseSetup(0.25);
    const fineDeficit = continuousZ(fine.tool, 6.4, 0) - curvedZ(fine.trace, 6.4, 0);
    assert.ok(Math.abs(fineDeficit) < rows[1].deficit);
    t.diagnostic(JSON.stringify({ coarse: rows, fineNoseDeficit: fineDeficit }));
});

test('diagnostic: increasing density can miss a compensated peak between emitted points', t => {
    const dense = noseSetup(0.25, 0.25, { density: 1 });
    const sparse = noseSetup(0.25, 0.25, { density: 16 });
    const path = [{ x: 2, y: 0 }, { x: 10, y: 0 }];
    const fine = points(dense.trace.followPath_sync(path));
    const coarse = points(sparse.trace.followPath_sync(path));
    let maxDeficit = 0;
    for (const p of fine) {
        const i = coarse.findIndex(q => q.x >= p.x);
        if (i <= 0) continue;
        const a = coarse[i - 1], b = coarse[i];
        const z = a.z + (b.z - a.z) * (p.x - a.x) / (b.x - a.x);
        maxDeficit = Math.max(maxDeficit, p.z - z);
    }
    assert.ok(maxDeficit > 0.1);
    t.diagnostic(JSON.stringify({ finePoints: fine.length, sparsePoints: coarse.length, maxChordDeficit: maxDeficit }));
});

test('diagnostic: cached raster/profile resolution mismatch can lower compensated nose Z', t => {
    const matched = noseSetup(1, 1);
    const mismatched = noseSetup(1, 2);
    const correct = curvedZ(matched.trace, 6, 0), wrong = curvedZ(mismatched.trace, 6, 0);
    assert.ok(correct > wrong);
    t.diagnostic(JSON.stringify({ correct, wrong, deficit: correct - wrong }));
});

test('diagnostic: valid center does not ensure complete footprint coverage at raster edges', t => {
    const { probe } = noseSetup();
    const before = probe.toolAtZ(19, 3);
    // dx=2 lands outside stepsX=21 and is silently replaced by zMin.
    assert.ok(19 < probe.params.stepsX);
    assert.ok(19 + 2 >= probe.params.stepsX);
    const extended = new Float32Array(22 * 7);
    extended.set(probe.params.data);
    extended[21 * 7 + 3] = 30;
    const full = new Probe({ ...probe.params, stepsX: 22, data: extended });
    const after = full.toolAtZ(19, 3);
    assert.ok(after > before);
    t.diagnostic(JSON.stringify({ truncated: before, withMissingHighSurface: after }));
});

test('diagnostic: fractional partOff shifts legacy moving-axis raster phase at identical XY', t => {
    const { trace } = noseSetup();
    const samples = [];
    trace.push_point = (x, y, z) => samples.push({ x, y, z });
    const partOff = 0.6;
    trace.crossX_sync({ from: -10 - partOff, to: 10, y: 0,
        gridx: -Math.floor(partOff), gridy: 3 }, () => {});
    const p = samples.find(p => Math.abs(p.x - 5.4) < 1e-9);
    assert.ok(p);
    const curved = curvedZ(trace, p.x, p.y);
    assert.ok(p.z > curved + 0.1);
    t.diagnostic(JSON.stringify({ x: p.x, y: p.y, partOff, legacy: p.z, curved, difference: p.z - curved }));
});

// Cache regressions exercise Topo.generate(), with only mesh rasterization
// replaced by a deterministic analytic surface. Tool profiles use the real Tool.
context.Tool = Tool;
context.THREE.Box2 = class { constructor() { return box(0, 0, 0, 0); } };
vm.runInContext('Number.prototype.round = function(n) { return Math.round(this * 10 ** n) / 10 ** n; };', context);

function cacheState() {
    const bounds = { min: { x: -10, y: -3, z: 0 }, max: { x: 10.4, y: 3.4, z: 20 },
        clone() { return { min: { ...this.min }, max: { ...this.max } }; } };
    const widget = { id: 'cache-regression', bounds, getBoundingBox() { return this.bounds; } };
    const settings = { controller: { units: 'mm', animesh: 1, webGPU: false },
        process: { camTabsHeight: 0 }, tools: [{ id: 1, type: 'bullnose', metric: true,
            flute_diam: 4, flute_len: 10, shaft_diam: 2, shaft_len: 10,
            corner_radius: 0.6, bottom_radius: 20, taper_tip: 0 }] };
    return { widget, settings, shadow: { base: [box(-10, -3, 10.4, 3.4)] }, workarea: { bottom_z: 0 } };
}
class CacheDiagnosticTopo extends Topo {
    builds = [];
    async raster(widget, params) {
        const { min, max } = widget.bounds;
        const nx = Math.ceil((max.x - min.x) / params.resolution);
        for (let x = 0; x < nx; x++) for (let y = 0; y < params.stepsY; y++) {
            params.data[x * params.stepsY + y] = noseSurface(min.x + x * params.resolution, min.y + y * params.resolution);
        }
        Object.assign(params.box, box(min.x, min.y, max.x, max.y));
        this.builds.push(params);
    }
    async contour(params) {
        this.contourParams = params;
        // Keep cache tests focused on generate's raster/profile integration;
        // the prototype path branch is covered separately above.
    }
}
async function generateCached(state, contourOverrides = {}) {
    const topo = new CacheDiagnosticTopo();
    await topo.generate({ state, contour: { axis: 'X', tool: 1, tolerance: 0,
        flatness: 0, step: 0.2, reduction: 0, inside: true,
        curvedPathPrototype: true, ...contourOverrides }, onupdate() {}, ondone() {} });
    return topo;
}
function legacyRaster(state) {
    const { min, max } = state.widget.bounds;
    return { tolerance: 0, diameter: 4, resolution: 1, stepsX: 21, stepsY: 7,
        bounds: state.widget.getBoundingBox().clone(), data: new Float32Array(147).fill(50),
        raster: false, box: box(min.x, min.y, max.x, max.y), profile: new Float32Array([0, 0, 0]) };
}
function assertMatchedProfile(topo, state) {
    const resolution = topo.probe.params.resolution;
    assert.equal(topo.builds[0].resolution, resolution);
    assert.equal(topo.contourParams.resolution, resolution);
    assert.equal(topo.probe.params.data.length, topo.probe.params.stepsX * topo.probe.params.stepsY);
    const expected = new Tool(state.settings, 1).generateProfile(resolution).profile;
    assert.deepEqual(Array.from(topo.probe.params.profile), Array.from(expected));
}

test('cache regression: automatic resolution changes rebuild prototype raster and profile together', async () => {
    const state = cacheState();
    const legacy = state.widget.topo = legacyRaster(state);
    const originalData = Array.from(legacy.data);
    const coarse = await generateCached(state);
    state.settings.controller.animesh = 4;
    const fine = await generateCached(state);
    assert.notEqual(coarse.probe.params.resolution, fine.probe.params.resolution);
    assert.notEqual(coarse.probe.params.data, fine.probe.params.data);
    assertMatchedProfile(coarse, state);
    assertMatchedProfile(fine, state);
    assert.equal(state.widget.topo, legacy);
    assert.deepEqual(Array.from(legacy.data), originalData);
    const fresh = await generateCached(cacheState(), { tolerance: fine.probe.params.resolution });
    const gx = Math.round((6.4 + 10) / fine.probe.params.resolution);
    const gy = Math.round(3 / fine.probe.params.resolution);
    assert.equal(fine.probe.toolAtZ(gx, gy), fresh.probe.toolAtZ(gx, gy));
});

test('cache regression: explicit resolution changes between successive prototype operations', async () => {
    const state = cacheState();
    for (const tolerance of [1, 0.25, 2, 0.5, 1]) {
        const topo = await generateCached(state, { tolerance });
        assert.equal(topo.probe.params.resolution, tolerance);
        assert.equal(topo.builds.length, 1);
        assertMatchedProfile(topo, state);
        assert.equal(state.widget.topo, undefined);
    }
});

test('cache regression: prototype isolation preserves legacy X/Y cache reuse', async () => {
    const state = cacheState();
    const legacy = state.widget.topo = legacyRaster(state);
    await generateCached(state);
    for (const axis of ['X', 'Y']) {
        const normal = await generateCached(state, { curvedPathPrototype: false, axis });
        assert.equal(normal.builds.length, 0);
        assert.equal(state.widget.topo, legacy);
        assert.equal(normal.probe.params.data, legacy.data);
    }
});

test('cache regression: current tool geometry and workarea are honored on each prototype operation', async () => {
    const state = cacheState();
    const first = await generateCached(state, { tolerance: 1 });
    state.settings.tools[0].corner_radius = 1.2;
    state.workarea.bottom_z = 2;
    state.widget.bounds.min.x -= 1;
    state.widget.bounds.max.x -= 1;
    const second = await generateCached(state, { tolerance: 1 });
    assertMatchedProfile(second, state);
    assert.notDeepEqual(Array.from(first.probe.params.profile), Array.from(second.probe.params.profile));
    assert.equal(second.probe.params.minX, -11);
    assert.equal(second.probe.params.zMin, 2.0001);
    assert.equal(second.builds[0].zMin, 2.0001);
});
