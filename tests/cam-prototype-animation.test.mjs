import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { Tool } from '../src/kiri/mode/cam/core/tool.js';

const source = fs.readFileSync(new URL('../src/kiri/mode/cam/work/anim-2d.js', import.meta.url), 'utf8');
function harness(output = []) {
    const context = vm.createContext({ Tool, console, setTimeout() { throw Error('unexpected delayed rendering'); } });
    vm.runInContext(source.replace(/^import .*;\s*$/gm, '').replace(/\bexport /g, '') + `
        Array.prototype.appendAll = function(items) { this.push(...items); };
        globalThis.testApi = {
            init,
            inspect: () => ({ grid, gridX, gridY, rez, center, path, curvedPathPrototype, tool }),
            cut(pos, flag, send) {
                curvedPathPrototype = flag;
                updateTool(new Tool(settings, 1), send);
                tool.pos = pos;
                deformMesh(pos, send);
            }
        };
    `, context);
    const settings = { controller: { units: 'mm', animesh: '1' },
        process: { camOriginCenter: true, camOriginTop: false },
        stock: { x: 40, y: 25, z: 20, center: { x: 3, y: -2, z: 10 } },
        tools: [{ id: 1, number: 1, metric: true, type: 'bullnose', flute_diam: 8.3,
            flute_len: 10, shaft_diam: 2, shaft_len: 5, taper_tip: 0,
            corner_radius: 1, bottom_radius: 30 }] };
    const worker = { dispatch: {}, current: { print: { output } } };
    const messages = [];
    const send = { data(message) { messages.push(message); }, done() {} };
    context.testApi.init(worker);
    worker.dispatch.animate_setup({ settings }, send);
    return { api: context.testApi, context, settings, worker, messages, send };
}

function assertLegacyFootprint(h, pos) {
    const { grid, gridX, gridY, rez, center, tool } = h.api.inspect();
    const { size, pix } = tool.profileDim;
    const heights = new Map();
    const rx = Math.floor((pos.x + h.settings.stock.x / 2 - size / 2 - center.x) / rez);
    const ry = Math.floor((pos.y + h.settings.stock.y / 2 - size / 2 - center.y) / rez);
    for (let i = 0; i < tool.profile.length; i += 3) {
        const x = rx + Math.floor(pix / 2) + tool.profile[i];
        const y = ry + Math.floor(pix / 2) + tool.profile[i + 1];
        if (x >= 0 && x < gridX && y >= 0 && y < gridY) heights.set(x * gridY + y, pos.z - tool.profile[i + 2]);
    }
    for (let x = 0; x < gridX; x++) for (let y = 0; y < gridY; y++) {
        const index = x * gridY + y;
        const original = x * y === 0 || x === gridX - 1 || y === gridY - 1 ? 0 : h.settings.stock.z;
        const expected = Math.fround(Math.min(original, heights.get(index) ?? original));
        assert.equal(grid[index * 3 + 2], expected);
    }
}

test('prototype stock footprint uses physical cutter distance at every grid vertex', () => {
    const h = harness(), pos = { x: 3.2, y: -2.3, z: 5 };
    h.api.cut(pos, true, h.send);
    const { grid, gridX, gridY, center, tool } = h.api.inspect();
    let affected = 0;
    for (let x = 0; x < gridX; x++) for (let y = 0; y < gridY; y++) {
        const i = (x * gridY + y) * 3;
        const original = x * y === 0 || x === gridX - 1 || y === gridY - 1 ? 0 : 20;
        const distance = Math.hypot(grid[i] + center.x - pos.x, grid[i + 1] + center.y - pos.y);
        const expected = distance <= tool.fluteDiameter() / 2
            ? Math.fround(Math.min(original, pos.z + tool.bullNoseHeight(distance))) : original;
        assert.equal(grid[i + 2], expected);
        if (grid[i + 2] < original) affected++;
    }
    assert.ok(affected > 20);
});

test('prototype displayed cutter tip is centered on commanded XY', () => {
    const h = harness();
    h.api.cut({ x: 0, y: 0, z: 5 }, true, h.send);
    const { tool } = h.api.inspect();
    const mesh = h.messages.filter(m => m.mesh_add?.id > 0).at(-1).mesh_add;
    const pos = new Float32Array(mesh.sab);
    const mid = Math.floor(tool.profileDim.pix / 2);
    const index = (mid * tool.profileDim.pix + mid) * 3;
    assert.ok(Math.abs(pos[index]) < 1e-6);
    assert.ok(Math.abs(pos[index + 1]) < 1e-6);
    assert.equal(pos[index + 2], 0);
});

test('disabled prototype retains legacy stock footprint and displayed mesh placement', () => {
    const h = harness(), pos = { x: 3.2, y: -2.3, z: 5 };
    h.api.cut(pos, false, h.send);
    assertLegacyFootprint(h, pos);
    const { rez, tool } = h.api.inspect();
    const mesh = h.messages.filter(m => m.mesh_add?.id > 0).at(-1).mesh_add;
    const vertices = new Float32Array(mesh.sab);
    const mid = Math.floor(tool.profileDim.pix / 2);
    const index = (mid * tool.profileDim.pix + mid) * 3;
    assert.equal(vertices[index], Math.fround(mid * rez - tool.profileDim.size / 2 + rez / 2));
});

test('animation tags only prototype contour layers and does not mutate print outputs', () => {
    const prototype = [{ point: { x: 0, y: 0, z: 5 } }];
    prototype.mode = { type: 'contour', curvedPathPrototype: true };
    const normal = [{ point: { x: 1, y: 0, z: 5 } }];
    normal.mode = { type: 'contour' };
    const other = [{ point: { x: 2, y: 0, z: 5 } }];
    other.mode = { type: 'outline', curvedPathPrototype: true };
    const h = harness([prototype, normal, other]);
    const { path } = h.api.inspect();
    assert.equal(path[0].curvedPathPrototype, true);
    assert.equal(path[1].curvedPathPrototype, undefined);
    assert.equal(path[2].curvedPathPrototype, undefined);
    assert.equal(prototype[0].curvedPathPrototype, undefined);
    assert.equal(path[1], normal[0]);
    assert.equal(path[2], other[0]);
});

test('same-tool transition out of prototype restores legacy mesh and deformation', () => {
    const h = harness();
    const tool = new Tool(h.settings, 1);
    const experimental = [{ point: { x: 3.2, y: -2.3, z: 5 }, tool }];
    experimental.mode = { type: 'contour', curvedPathPrototype: true };
    const normal = [{ point: { x: 3.2, y: -2.3, z: 5 }, tool }];
    normal.mode = { type: 'contour' };
    h.worker.current.print.output = [experimental, normal];
    h.worker.dispatch.animate_setup({ settings: h.settings }, h.send);
    h.worker.dispatch.animate({ speed: 1000, steps: 1 }, h.send);
    assert.equal(h.api.inspect().curvedPathPrototype, true);
    h.worker.dispatch.animate({ speed: 1000, steps: 1 }, h.send);
    assert.equal(h.api.inspect().curvedPathPrototype, false);
    assert.equal(h.messages.filter(m => m.mesh_add?.id > 0).length, 2);
    // Reset stock before comparing a legacy cut after the transition.
    const { grid, gridX, gridY } = h.api.inspect();
    for (let x = 0; x < gridX; x++) for (let y = 0; y < gridY; y++) {
        grid[(x * gridY + y) * 3 + 2] = x * y === 0 || x === gridX - 1 || y === gridY - 1 ? 0 : 20;
    }
    const pos = normal[0].point;
    vm.runInContext('tool.pos = path[1].point; deformMesh(tool.pos, {data(){},done(){}});', h.context);
    assertLegacyFootprint(h, pos);
});
