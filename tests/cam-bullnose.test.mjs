import test from 'node:test';
import assert from 'node:assert/strict';
import { Tool } from '../src/kiri/mode/cam/core/tool.js';

function cutter(values = {}) {
    return new Tool({
        controller: { units: 'mm' },
        tools: [{ id: 1, type: 'bullnose', metric: true, flute_diam: 32.16,
            flute_len: 71.83, shaft_diam: 10, shaft_len: 20, taper_tip: 0,
            corner_radius: 9.93, bottom_radius: 191.69, ...values }]
    }, 1);
}

const close = (a, b, tolerance = 1e-7) => assert.ok(Math.abs(a - b) < tolerance, `${a} ≈ ${b}`);

test('reference cutter has tangent bottom and corner arcs', () => {
    const tool = cutter();
    const { radius, corner, bottom, center, rise, join } = tool.getBullNoseParams();
    close(tool.bullNoseHeight(0), 0);
    close(tool.bullNoseHeight(radius), rise);
    close(Math.hypot(center, bottom - rise), bottom - corner);
    const delta = 1e-5;
    close(tool.bullNoseHeight(join - delta), tool.bullNoseHeight(join + delta), 1e-5);
    const leftSlope = (tool.bullNoseHeight(join) - tool.bullNoseHeight(join - delta)) / delta;
    const rightSlope = (tool.bullNoseHeight(join + delta) - tool.bullNoseHeight(join)) / delta;
    close(leftSlope, rightSlope, 1e-5);
    tool.generateProfile(0.2);
    assert.ok([...tool.profile].every(Number.isFinite));
    for (let i = 0; i < tool.profile.length; i += 3) {
        close(tool.profile[i + 2], -tool.bullNoseHeight(Math.hypot(tool.profile[i], tool.profile[i + 1]) * 0.2), 1e-5);
    }
});

test('supports flat bottoms, spherical ends, and zero corner radius', () => {
    const flat = cutter({ bottom_radius: 0 });
    close(flat.bullNoseHeight(2), 0);
    close(flat.bullNoseHeight(16.08), 9.93);
    const ball = cutter({ corner_radius: 16.08, bottom_radius: 16.08 });
    close(ball.bullNoseHeight(8), 16.08 - Math.sqrt(16.08 ** 2 - 64));
    const noCorner = cutter({ corner_radius: 0 });
    close(noCorner.bullNoseHeight(8), 191.69 - Math.sqrt(191.69 ** 2 - 64));
});

test('metric and inch definitions generate equivalent geometry', () => {
    const metric = cutter();
    const inch = cutter({ metric: false, flute_diam: 32.16 / 25.4,
        corner_radius: 9.93 / 25.4, bottom_radius: 191.69 / 25.4 });
    for (let radius = 0; radius <= 16; radius += 0.25) {
        close(metric.bullNoseHeight(radius), inch.bullNoseHeight(radius));
    }
});
