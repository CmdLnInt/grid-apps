import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

globalThis.self ??= globalThis;
const { generateBoardPaths, generateBoardOutline, splitOutlineForEndTabs } = await import('../src/kiri/mode/cam/core/curved-path.js');

const { refineScallopPaths, DEFAULT_SCALLOP_HEIGHT } = await import('../src/kiri/mode/cam/core/scallop-path.js');

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
    generateBoardPaths, generateBoardOutline, splitOutlineForEndTabs, refineScallopPaths, DEFAULT_SCALLOP_HEIGHT,
    setTimeout,
    THREE: { Vector3: class { constructor(x, y, z) { Object.assign(this, { x, y, z }); } } },
    self: { kiri_worker: { minions: { running: true, broadcast() { throw Error('prototype must not dispatch minions'); } } } },
    newPoint: (x, y, z = 0) => ({ x, y, z, isInPolygon(p) {
        if (p.points?.length) {
            let inside = false;
            for (let i = 0; i < p.points.length; i++) {
                const a = p.points[i], b = p.points[(i + 1) % p.points.length];
                const dx = b.x - a.x, dy = b.y - a.y;
                const t = Math.max(0, Math.min(1, ((x - a.x) * dx + (y - a.y) * dy) / (dx * dx + dy * dy || 1)));
                if (Math.hypot(x - a.x - dx * t, y - a.y - dy * t) < 1e-6) return true;
                if ((a.y > y) !== (b.y > y) && x < a.x + (b.x - a.x) * (y - a.y) / (b.y - a.y)) inside = !inside;
            }
            return inside;
        }
        return x >= p.min.x && x <= p.max.x && y >= p.min.y && y <= p.max.y;
    } }),
    newPolygon: (points = []) => ({ points: [...points], setOpen() { this.open = true; return this; },
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
        contourX: false, contourY: false, curvedPathPrototype: true, newslices, leave: 0,
        prototypeVertices: [10,-4,0,17,-4,0,17,0,0,10,-4,0,17,0,0,10,0,0],
        prototypeStepover: 1, prototypeSafetyMargin: 0.2 }, () => {});
    assert.equal(newslices.length, 9);
    assert.ok(newslices.every(slice => slice.camLines[0].length >= 2));
    assert.ok(newslices[0].camLines[0].points.every(p => p.x === 13.5));
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
    const bounds = { min: { x: -10, y: -3, z: 0 }, max: { x: 10.4, y: 40, z: 20 },
        clone() { return { min: { ...this.min }, max: { ...this.max } }; } };
    const widget = { id: 'cache-regression', bounds, getBoundingBox() { return this.bounds; },
        getGeoVertices() {
            const { min, max } = this.bounds;
            return [min.x,min.y,0,max.x,min.y,0,max.x,max.y,0,min.x,min.y,0,max.x,max.y,0,min.x,max.y,0];
        } };
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
    const stepsX = Math.ceil(max.x - min.x), stepsY = Math.ceil(max.y - min.y);
    return { tolerance: 0, diameter: 4, resolution: 1, stepsX, stepsY,
        bounds: state.widget.getBoundingBox().clone(), data: new Float32Array(stepsX * stepsY).fill(50),
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

test('stage 2 projects every ordered pass with Z/leave and splits at clipping exclusions', async () => {
    const {trace}=setup({minX:-40,minY:0,boundsX:80,boundsY:240,stepsX:41,stepsY:121,
        resolution:2,data:new Float32Array(41*121).fill(3)},
        {box:box(-40,0,40,240),resolution:2,density:1,leave:0.25});
    const topo=new Topo();topo.trace=trace;
    const outline=[{x:0,y:0},{x:40,y:120},{x:0,y:240},{x:-40,y:120}];
    const vertices=[];
    for(let i=1;i<outline.length-1;i++)for(const p of [outline[0],outline[i],outline[i+1]])vertices.push(p.x,p.y,1);
    const newslices=[];
    await topo.contour({minX:-40,maxX:40,minY:0,maxY:240,boundsX:80,boundsY:240,
        box:box(-40,0,40,240),partOff:0,resolution:2,density:1,leave:0.25,
        clipTo:[box(-40,0,40,90),box(-40,150,40,240)],
        contourX:false,contourY:false,curvedPathPrototype:true,prototypeVertices:vertices,
        prototypeStepover:10,prototypeSafetyMargin:10,newslices},()=>{});
    assert.equal(newslices.length,9);
    for(let i=0;i<newslices.length;i++) {
        const slice=newslices[i];assert.equal(slice.z,i);assert.equal(slice.camLines.length,2);
        for(const segment of slice.camLines) {
            assert.ok(segment.open);
            assert.ok(segment.points.every(p=>p.z===3.25));
            assert.ok(segment.points.every(p=>p.y<=90 || p.y>=150));
            assert.ok(segment.points[0].y<segment.points.at(-1).y === (i%2===0));
        }
        assert.equal(slice.camLines[0].points[0].y<slice.camLines[1].points[0].y,i%2===0);
    }
});

test('stage 2 extracts only the current widget mesh, excluding stock/tabs/unrelated widgets', async () => {
    const state=cacheState();let meshCalls=0;
    const getVertices=state.widget.getGeoVertices;
    state.widget.getGeoVertices=function(options){
        meshCalls++;assert.equal(options.unroll,true);assert.equal(options.translate,true);
        return getVertices.call(this);
    };
    state.widget.getTabVertices=()=>{throw Error('tabs must not be projected');};
    state.widgets=[{getGeoVertices(){throw Error('unrelated widget must not be projected');}}];
    state.settings.stock={getGeoVertices(){throw Error('stock must not be projected');}};
    const result=await generateCached(state);
    assert.equal(meshCalls,1);
    assert.equal(result.contourParams.prototypeVertices.length,18);
    await generateCached(state,{curvedPathPrototype:false});
    assert.equal(meshCalls,1);
});

test('prototype accepts OpenShaper X-long boards without rotating mesh; Y-long remains supported', async () => {
    const state=cacheState();state.widget.bounds.max.y=3.4;
    const xlong=await generateCached(state,{tolerance:1});
    assert.equal(xlong.contourParams.prototypeLengthAxis,'X');
    assert.equal(xlong.builds.length,1);
    const ylong=await generateCached(cacheState(),{tolerance:1});
    assert.equal(ylong.contourParams.prototypeLengthAxis,'Y');
    const normal=await generateCached(state,{curvedPathPrototype:false,tolerance:1});
    assert.equal(normal.builds.length,1);
});

test('prototype raster bypasses minion queue and yields between batches; normal raster keeps queue', async () => {
    const originalWorker=context.self.kiri_worker,originalSlicer=context.topo_slicer,
        originalBox=context.THREE.Box2,originalSlice=context.newSlice;
    const calls={queued:0,cached:0,cleared:0};
    context.self.kiri_worker={
        minions:{running:3,queue(work,done){calls.queued++;done({box:{min:{x:0,y:0},max:{x:1,y:1}}});}},
        dispatch:{putCache(data,send){calls.cached++;send.done({});},clearCache(data,send){calls.cleared++;send.done({});}}
    };
    context.topo_slicer=class {
        setFromArray(){return this;}
        slice(){return [{z:0,index:0,lines:[{p1:{x:0,y:0,z:3,swapped:true},p2:{x:0,y:1,z:4,swapped:true}}]}];}
    };
    context.THREE.Vector2=class {constructor(x,y){Object.assign(this,{x,y});}};
    context.THREE.Box2=class {constructor(min={x:0,y:0},max={x:0,y:0}){
        const b=box(min.x,min.y,max.x,max.y);
        b.expandByPoint=p=>{b.min.x=Math.min(b.min.x,p.x);b.min.y=Math.min(b.min.y,p.y);b.max.x=Math.max(b.max.x,p.x);b.max.y=Math.max(b.max.y,p.y);};
        b.union=()=>b;return b;
    }};
    context.newSlice=()=>({output(){throw Error('prototype must not allocate unused raster debug output');}});
    const widget={getGeoVertices:()=>({toShared:()=>Float32Array.from([0,0,1,1,0,1,0,1,1])})};
    const params=()=>({box:new context.THREE.Box2(),resolution:.25,stepsY:4,minY:0,maxY:1,zMin:0.0001,
        flatness:.001,data:new Float32Array(16),curvedPathPrototype:true});
    try {
        let yielded=false;setTimeout(()=>{yielded=true;},0);
        const prototype=params();let progress=0;
        await new Topo().raster(widget,prototype,()=>progress++);
        assert.equal(calls.queued,0);assert.equal(calls.cached,0);assert.equal(calls.cleared,0);
        assert.ok(progress>0);assert.ok(yielded);assert.equal(prototype.data[0],3);
        const normal=params();normal.curvedPathPrototype=false;
        await new Topo().raster(widget,normal,()=>{});
        assert.equal(calls.queued,1);assert.equal(calls.cached,1);assert.equal(calls.cleared,1);
    } finally {
        context.self.kiri_worker=originalWorker;context.topo_slicer=originalSlicer;
        context.THREE.Box2=originalBox;context.newSlice=originalSlice;
    }
});

test('rail-apex Z lower bounds interpolate during resampling without lowering compensation',()=>{
    const {trace}=setup({}, {leave:.5});
    const path=[{x:11,y:-2,minZ:5},{x:15,y:-2,minZ:9}];
    const out=trace.followPath_sync(path)[0].points;
    assert.equal(out[0].z,5.5);assert.equal(out.at(-1).z,9.5);
    const middle=out.find(p=>p.x===13);assert.equal(middle.z,7.5);
    const raised=setup({data:new Float32Array(40).fill(20)},{leave:.5}).trace.followPath_sync(path);
    assert.ok(raised[0].points.every(p=>p.z===20.5));
});

test('rail-apex contour permits exterior cutter centres in the padded raster while retaining Z floors',async()=>{
    const {trace}=setup({minX:-45,minY:-125,stepsX:91,stepsY:251,resolution:1,
        data:new Float32Array(91*251).fill(0)},
        {box:box(-45,-125,45,125),resolution:1,density:1});
    const vertices=[];
    // A rectangular projection with side apex height Z=10 and upper deck Z=20.
    for(const z of [10,20])vertices.push(-40,-120,z,40,-120,z,40,120,z,-40,-120,z,40,120,z,-40,120,z);
    const topo=new Topo();topo.trace=trace;const newslices=[];
    await topo.contour({minX:-45,maxX:45,minY:-125,maxY:125,boundsX:90,boundsY:250,
        box:box(-40,-120,40,120),partOff:0,resolution:1,density:1,leave:0,
        clipTo:[box(-40,-120,40,120)],curvedPathPrototype:true,
        prototypeVertices:vertices,prototypeStepover:10,prototypeSafetyMargin:10,
        prototypeRailApex:true,prototypeToolRadius:4,prototypeEdgeHeight:2,rasterPadding:5,newslices},()=>{});
    const pts=newslices.flatMap(s=>s.camLines.flatMap(p=>p.points));
    assert.ok(pts.some(p=>p.x>40));assert.ok(pts.some(p=>p.x<-40));
    assert.ok(pts.every(p=>p.z>=18)); // widest-point tie chooses deck-side apex
});

test('deck perimeter is appended after finishing and raises over matching tabs',async()=>{
    const {trace}=setup({minX:-45,minY:-125,stepsX:91,stepsY:251,resolution:1,
        data:new Float32Array(91*251).fill(0)},
        {box:box(-45,-125,45,125),resolution:1,density:1});
    const vertices=[];
    // A rectangular projection with side apex height Z=10 and upper deck Z=20.
    for(const z of [10,20])vertices.push(-40,-120,z,40,-120,z,40,120,z,-40,-120,z,40,120,z,-40,120,z);
    const topo=new Topo();topo.trace=trace;const newslices=[];
    await topo.contour({minX:-45,maxX:45,minY:-125,maxY:125,boundsX:90,boundsY:250,
        box:box(-40,-120,40,120),partOff:0,resolution:1,density:1,leave:0,
        clipTo:[box(-40,-120,40,120)],curvedPathPrototype:true,
        prototypeVertices:vertices,prototypeStepover:10,prototypeSafetyMargin:10,
        prototypeOutline:true,prototypeOutlineEndMargin:0,prototypeOutlineThrough:0.1,prototypeOutlineClockwise:true,
        clipTab:[Object.assign(box(43,-20,45,20),{z:12})],clipTabZ:[12],tabHeight:12,
        prototypeRailApex:true,prototypeToolRadius:4,prototypeEdgeHeight:2,rasterPadding:5,newslices},()=>{});
    const final = newslices.at(-1);
    assert.equal(final.prototypeOutline,true);
    assert.equal(final.z,topo.prototypePaths.paths.length);
    const pts = final.camLines[0].points;
    assert.deepEqual([pts[0].x,pts[0].y,pts[0].z],[pts.at(-1).x,pts.at(-1).y,pts.at(-1).z]);
    assert.ok(pts.some(p=>p.x>43 && Math.abs(p.y)<20 && p.z===12));
    assert.ok(pts.some(p=>p.z===7.9));
    assert.ok(newslices.slice(0,-1).every(s=>!s.prototypeOutline));
});

test('rail-apex raster planes use padded origin rather than the mesh origin',async()=>{
    const oldWorker=context.self.kiri_worker,oldSlicer=context.topo_slicer;
    const ranges=[];
    context.self.kiri_worker={minions:{running:0},dispatch:{}};
    context.topo_slicer=class {
        setFromArray(vertices,range){ranges.push(range);return this;}
        slice(){return [];}
    };
    const widget={getGeoVertices:()=>({toShared:()=>Float32Array.from([0,0,1,1,0,1,0,1,1])})};
    try {
        await new Topo().raster(widget,{box:box(-2,0,3,1),resolution:1,stepsY:2,
            minX:-2,maxX:3,minY:0,maxY:1,data:new Float32Array(10),
            curvedPathPrototype:true,curvedPathRailApex:true},()=>{});
        assert.equal(ranges[0].min,-2);assert.equal(ranges[0].max,3);assert.equal(ranges[0].index,0);
    } finally {context.self.kiri_worker=oldWorker;context.topo_slicer=oldSlicer;}
});

test('rail-apex physical footprint uses true XY offsets and leaves rounded sampling unchanged',()=>{
    const tool=new Tool({controller:{units:'mm'},tools:[{id:1,type:'bullnose',metric:true,
        flute_diam:4,flute_len:10,shaft_diam:1,shaft_len:5,corner_radius:.6,bottom_radius:20,taper_tip:0}]},1);
    const data=new Float32Array(40).fill(0);data[4*5+2]=11;
    const {probe,trace}=setup({data,profile:tool.generateProfile(1).profile});
    const x=12.4,y=-2;
    const expected=11-tool.bullNoseHeight(1.6);
    assert.ok(Math.abs(probe.toolAtPhysicalXY(x,y,tool)-expected)<1e-7);
    const normal=trace.followPath_sync([{x,y},{x:x+.01,y}])[0].points[0].z;
    assert.equal(normal,probe.toolAtZ(2,2));
    trace.physicalTool=tool;
    const physical=trace.followPath_sync([{x,y},{x:x+.01,y}])[0].points[0].z;
    assert.ok(Math.abs(physical-expected)<1e-7);
    assert.ok(physical>normal);
});

test('X-long centre pass samples Z, clipping and tabs in original raster coordinates', async () => {
    const {trace}=setup({}, {resolution:1,density:1});
    const topo=new Topo();topo.trace=trace;const newslices=[];
    await topo.contour({minX:10,maxX:17,minY:-4,maxY:0,boundsX:7,boundsY:4,
        box:box(10,-4,17,0),partOff:0,resolution:1,density:1,
        curvedPathPrototype:true,prototypeLengthAxis:'X',newslices,leave:.5,
        clipTo:[box(10,-4,12.5,0),box(14.5,-4,17,0)],
        clipTab:[Object.assign(box(15,-3,17,-1),{z:12})],clipTabZ:[12],tabHeight:12,
        prototypeVertices:[10,-4,0,17,-4,0,17,0,0,10,-4,0,17,0,0,10,0,0],
        prototypeStepover:1,prototypeSafetyMargin:.2},()=>{});
    const centre=newslices[0].camLines;
    assert.equal(centre.length,2);
    assert.ok(centre.every(p=>p.points.every(q=>Math.abs(q.y+2)<1e-6)));
    assert.ok(centre[0].points.every(q=>q.x<=12.5));
    assert.ok(centre[1].points.every(q=>q.x>=14.5));
    assert.ok(centre[1].points.some(q=>q.z===12.5));
});


test('bottom side defaults to no perimeter while deck and explicit settings retain behavior', async () => {
    const bottom=await generateCached(cacheState(),{curvedPathSide:'bottom'});
    assert.equal(bottom.contourParams.prototypeOutline,false);
    // Exercise the enabled rail-apex branch with the bullnose fixture.
    const state=cacheState();
    state.widget.bounds.clone = function() {
        const copy=box(this.min.x,this.min.y,this.max.x,this.max.y);
        copy.min.z=this.min.z;copy.max.z=this.max.z;return copy;
    };
    state.settings.tools[0].type='bullnose';
    state.settings.tools[0].corner_radius=.5;state.settings.tools[0].bottom_radius=20;
    const b=await generateCached(state,{curvedPathRailApex:true,curvedPathSide:'bottom'});
    assert.equal(b.contourParams.prototypeOutline,false);
    assert.equal(b.contourParams.prototypeSafetyMargin,0);
    assert.equal(b.contourParams.prototypeScallop,DEFAULT_SCALLOP_HEIGHT.bottom);
    const a=await generateCached(state,{curvedPathRailApex:true});
    assert.equal(a.contourParams.prototypeOutline,true);
    assert.equal(a.contourParams.prototypeSafetyMargin,0);
    assert.equal(a.contourParams.prototypeOutlineEndMargin,10);
    assert.equal(a.contourParams.prototypeScallop,DEFAULT_SCALLOP_HEIGHT.deck);
    const disabled=await generateCached(state,{curvedPathRailApex:true,curvedPathScallop:false});
    assert.equal(disabled.contourParams.prototypeScallop,undefined);
});

test('flipped asymmetric underside compensation uses bottom rocker rather than deck', () => {
    const data=new Float32Array(40);
    // After X flip, Z = boardTop - original underside Z. The nose and
    // tail have different curvature; Y indices reverse while X stays fixed.
    for(let x=0;x<8;x++)for(let y=0;y<5;y++) data[x*5+y]=30-(2+.05*x*x+(4-y)*.2);
    const {trace,probe}=setup({data});
    const path=[{x:10,y:-2},{x:17,y:-2}];
    const points=trace.followPath_sync(path)[0].points;
    for(const p of points) {
        const x=Math.round(p.x-10),y=Math.round(p.y+4);
        assert.equal(p.z,probe.toolAtZ(x,y));
    }
    assert.ok(points[0].z>points.at(-1).z);
});

test('production contour appends two open rails and preserves default outline end gaps',async()=>{
    const {trace}=setup({minX:-125,minY:-45,stepsX:251,stepsY:91,resolution:1,
        data:new Float32Array(251*91).fill(20)},
        {box:box(-125,-45,125,45),resolution:1,density:1});
    const vertices=[];
    for(const z of [10,20])vertices.push(-120,-40,z,120,-40,z,120,40,z,-120,-40,z,120,40,z,-120,40,z);
    const topo=new Topo();topo.trace=trace;const newslices=[];
    await topo.contour({box:box(-120,-40,120,40),partOff:0,resolution:1,density:1,leave:0,
        curvedPathPrototype:true,prototypeLengthAxis:'X',prototypeVertices:vertices,
        prototypeStepover:10,prototypeSafetyMargin:0,prototypeRailApex:true,
        prototypeOutline:true,prototypeToolRadius:4,prototypeEdgeHeight:2,rasterPadding:5,newslices},()=>{});
    const rails=newslices.at(-1).camLines;
    assert.equal(rails.length,2);
    for(const rail of rails) {
        assert.equal(rail.open,true);
        assert.ok(rail.points.every(p=>p.x>=-106-1e-6&&p.x<=106+1e-6));
        assert.ok(Math.abs(rail.points[0].x-rail.points.at(-1).x)>200);
    }
    const centre=newslices[0].camLines[0].points;
    assert.equal(centre[0].x,-120);
    assert.equal(centre.at(-1).x,120);
});

test('production contour applies scallop refinement and retains rail end tabs',async()=>{
    const {trace}=setup({minX:-45,minY:-125,stepsX:91,stepsY:251,resolution:1,
        data:new Float32Array(91*251).fill(20)},
        {box:box(-45,-125,45,125),resolution:1,density:1});
    trace.physicalTool=new Tool({controller:{units:'mm'},tools:[{id:1,type:'bullnose',metric:true,
        flute_diam:8,flute_len:20,shaft_diam:2,shaft_len:5,corner_radius:1,bottom_radius:20}]},1);
    const vertices=[];
    for(const z of [10,20])vertices.push(-40,-120,z,40,-120,z,40,120,z,-40,-120,z,40,120,z,-40,120,z);
    const topo=new Topo();topo.trace=trace;const newslices=[];
    await topo.contour({box:box(-40,-120,40,120),partOff:0,resolution:1,density:1,leave:0,
        curvedPathPrototype:true,prototypeLengthAxis:'Y',prototypeVertices:vertices,
        prototypeStepover:10,prototypeSafetyMargin:0,prototypeRailApex:true,
        prototypeScallop:.05,prototypeOutline:true,prototypeToolRadius:4,
        prototypeEdgeHeight:trace.physicalTool.getBullNoseParams().rise,rasterPadding:5,newslices},()=>{});
    assert.ok(topo.prototypePaths.paths.length>11);
    assert.ok(topo.prototypePaths.scallop.worstSampledAdditionalCusp<=.05);
    assert.equal(newslices.at(-1).camLines.length,2);
    assert.ok(newslices.every(s=>s.camLines.every(p=>p.points.every(q=>Number.isFinite(q.z)))));
});
