/** Copyright Stewart Allen <sa@grid.space> -- All Rights Reserved */

import { ClipperLib } from '../../../../ext/clip2.esm.js';

const SCALE = 100000;
const EPSILON = 1 / SCALE;

function singleOutline(tree, label) {
    const children = tree.Childs();
    if (children.length !== 1 || children[0].ChildCount()) {
        throw new Error(`curved path prototype requires one connected ${label} without holes`);
    }
    return children[0].Contour().map(p => ({ x: p.X / SCALE, y: p.Y / SCALE }));
}

/** Project ONLY the supplied widget's unrolled triangles; do not use its shadow. */
export function projectBoardOutline(vertices) {
    if (!vertices?.length || vertices.length % 9) {
        throw new Error('curved path prototype requires unrolled triangle geometry');
    }
    const triangles = [];
    for (let i = 0; i < vertices.length; i += 9) {
        const tri = [0, 3, 6].map(offset => ({
            X: Math.round(vertices[i + offset] * SCALE),
            Y: Math.round(vertices[i + offset + 1] * SCALE)
        }));
        if (tri.some(p => !Number.isSafeInteger(p.X) || !Number.isSafeInteger(p.Y))) {
            throw new Error('curved path prototype requires finite XY geometry');
        }
        const area = ClipperLib.Clipper.Area(tri);
        if (Math.abs(area) < 1) continue; // vertical/degenerate projected faces
        if (area < 0) tri.reverse(); // top and bottom triangles must not cancel
        triangles.push(tri);
    }
    if (!triangles.length) throw new Error('curved path prototype has no projected surface');
    const clip = new ClipperLib.Clipper();
    clip.StrictlySimple = true;
    const tree = new ClipperLib.PolyTree();
    // A single union of a dense projected mesh can spend minutes resolving
    // coincident edges. Reduce bounded batches first, then union their contours.
    // Preserve hole winding in intermediate trees; validate only the final tree.
    let paths = triangles;
    const batchSize = 1024;
    if (triangles.length > batchSize) {
        paths = [];
        for (let i = 0; i < triangles.length; i += batchSize) {
            const batchClip = new ClipperLib.Clipper();
            const batchTree = new ClipperLib.PolyTree();
            batchClip.StrictlySimple = true;
            batchClip.AddPaths(triangles.slice(i, i + batchSize), ClipperLib.PolyType.ptSubject, true);
            batchClip.Execute(ClipperLib.ClipType.ctUnion, batchTree,
                ClipperLib.PolyFillType.pftNonZero, ClipperLib.PolyFillType.pftNonZero);
            paths.push(...ClipperLib.Clipper.PolyTreeToPaths(batchTree));
        }
    }
    clip.AddPaths(paths, ClipperLib.PolyType.ptSubject, true);
    clip.Execute(ClipperLib.ClipType.ctUnion, tree,
        ClipperLib.PolyFillType.pftNonZero, ClipperLib.PolyFillType.pftNonZero);
    return singleOutline(tree, 'projected board outline');
}

function insetOutline(outline, margin) {
    if (!margin) return outline;
    // Extra 0.01 mm covers polygon approximation of the rounded inset joins.
    const offset = new ClipperLib.ClipperOffset(2, 0.005 * SCALE);
    const tree = new ClipperLib.PolyTree();
    offset.AddPath(outline.map(p => ({ X: Math.round(p.x * SCALE), Y: Math.round(p.y * SCALE) })),
        ClipperLib.JoinType.jtRound, ClipperLib.EndType.etClosedPolygon);
    offset.Execute(tree, -(margin + 0.01) * SCALE);
    return singleOutline(tree, 'inset board outline (reduce safety margin if empty)');
}

function railAt(outline, y) {
    const intersections = [];
    for (let i = 0; i < outline.length; i++) {
        const a = outline[i], b = outline[(i + 1) % outline.length];
        // Do not extend edge ranges by EPSILON: between nearly level rail
        // vertices that would count adjacent edges as phantom crossings.
        if (a.y === b.y) {
            if (y === a.y) intersections.push(a.x, b.x);
        } else if (y >= Math.min(a.y, b.y) && y <= Math.max(a.y, b.y)) {
            const t = Math.max(0, Math.min(1, (y - a.y) / (b.y - a.y)));
            intersections.push(a.x + (b.x - a.x) * t);
        }
    }
    intersections.sort((a, b) => a - b);
    const xs = intersections.filter((x, i) => !i || x - intersections[i - 1] > EPSILON);
    if (!xs.length) throw new Error('curved path prototype found a discontinuous outline');
    // At a vertex there can be extra coincident/tangent intersections. Interior
    // Y stations are separately checked for a single continuous cross-section.
    return { left: xs[0], right: xs[xs.length - 1], count: xs.length };
}

// Intersect triangles with each Y station and retain the widest 3D points.
// Assign triangles only to stations within their Y range to avoid an O(mesh *
// stations) scan of the entire board for every rail sample.
function railApexSections(vertices, stations) {
    const sections = stations.map(s => ({ y: s.y, bottomZ: Infinity, left: { x: Infinity, z: -Infinity }, right: { x: -Infinity, z: -Infinity } }));
    const lowerBound = y => {
        let low = 0, high = stations.length;
        while (low < high) {
            const mid = (low + high) >>> 1;
            if (stations[mid].y < y) low = mid + 1;
            else high = mid;
        }
        return low;
    };
    const add = (section, x, z) => {
        section.bottomZ = Math.min(section.bottomZ, z);
        if (x < section.left.x || (x === section.left.x && z > section.left.z)) section.left = { x, z };
        if (x > section.right.x || (x === section.right.x && z > section.right.z)) section.right = { x, z };
    };
    for (let i = 0; i < vertices.length; i += 9) {
        const minY = Math.min(vertices[i + 1], vertices[i + 4], vertices[i + 7]);
        const maxY = Math.max(vertices[i + 1], vertices[i + 4], vertices[i + 7]);
        for (let j = lowerBound(minY); j < sections.length && sections[j].y <= maxY; j++) {
            const section = sections[j], y = section.y;
            for (let edge = 0; edge < 3; edge++) {
                const a = i + edge * 3, b = i + ((edge + 1) % 3) * 3;
                const ay = vertices[a + 1], by = vertices[b + 1];
                if (ay === by) {
                    if (y === ay) { add(section, vertices[a], vertices[a + 2]); add(section, vertices[b], vertices[b + 2]); }
                } else if (y >= Math.min(ay, by) && y <= Math.max(ay, by)) {
                    const t = (y - ay) / (by - ay);
                    add(section, vertices[a] + (vertices[b] - vertices[a]) * t,
                        vertices[a + 2] + (vertices[b + 2] - vertices[a + 2]) * t);
                }
            }
        }
    }
    for (let i = 0; i < sections.length; i++) {
        const section = sections[i];
        if (!Number.isFinite(section.left.z) || !Number.isFinite(section.right.z)) {
            throw new Error('curved rail-apex prototype could not find a closed rail section');
        }
        const before = sections[Math.max(0, i - 1)], after = sections[Math.min(sections.length - 1, i + 1)];
        for (const side of ['left', 'right']) {
            const slope = after.y === before.y ? 0 : (after[side].x - before[side].x) / (after.y - before.y);
            const sign = side === 'left' ? -1 : 1;
            const length = Math.hypot(1, slope);
            section[side].normal = { x: sign / length, y: -sign * slope / length };
        }
    }
    return sections;
}

function outsetOutline(outline, distance) {
    const offset = new ClipperLib.ClipperOffset(2, 0.005 * SCALE);
    const tree = new ClipperLib.PolyTree();
    offset.AddPath(outline.map(p => ({ X: Math.round(p.x * SCALE), Y: Math.round(p.y * SCALE) })),
        ClipperLib.JoinType.jtRound, ClipperLib.EndType.etClosedPolygon);
    offset.Execute(tree, (distance + 0.01) * SCALE);
    return singleOutline(tree, 'rail-apex cutter-centre envelope');
}

/**
 * Y-longitudinal prototype: midpoint/stringer first, then left/right widening
 * passes. Paths are piecewise linear and sample every inset vertex Y as well
 * as uniform stations, so interpolation stays inside each rail band.
 */
function generateBoardPathsY(vertices, { stepover = 5, safetyMargin = 10, sampleStep = 1, railApex = false, toolRadius = 0, edgeHeight = 0 } = {}) {
    if (!(stepover > 0) || !Number.isFinite(stepover) || !(sampleStep > 0) || !Number.isFinite(sampleStep) ||
        !(safetyMargin >= 0) || !Number.isFinite(safetyMargin)) {
        throw new Error('curved path prototype requires positive stepover/sample spacing and nonnegative safety margin');
    }
    if (railApex && (!(toolRadius > 0) || !Number.isFinite(toolRadius) || !(edgeHeight >= 0) || !Number.isFinite(edgeHeight))) {
        throw new Error('curved rail-apex prototype requires cutter radius and corner height');
    }
    const outline = projectBoardOutline(vertices);
    const inset = insetOutline(outline, safetyMargin);
    const minY = inset.reduce((min, p) => Math.min(min, p.y), Infinity);
    const maxY = inset.reduce((max, p) => Math.max(max, p.y), -Infinity);
    if (maxY - minY <= EPSILON) throw new Error('curved path prototype has no longitudinal extent');
    const ys = inset.map(p => p.y);
    const intervals = Math.ceil((maxY - minY) / sampleStep);
    if (intervals > 1000000) throw new Error('curved path prototype sample spacing is too small');
    for (let i = 0; i <= intervals; i++) ys.push(minY + (maxY - minY) * i / intervals);
    ys.sort((a, b) => a - b);
    const stations = ys.filter((y, i) => !i || y - ys[i - 1] > EPSILON).map(y => ({ y, ...railAt(inset, y) }));
    for (let i = 1; i < stations.length; i++) {
        if (railAt(inset, (stations[i - 1].y + stations[i].y) / 2).count !== 2) {
            throw new Error('curved path prototype requires a Y-monotone board outline');
        }
    }
    // Blunt tips can have nonzero width even after inset. Smoothly converge
    // within a short end zone instead of adding a sudden lateral tip segment.
    const taperLength = Math.min(Math.max(safetyMargin, sampleStep * 2), (maxY - minY) / 4);
    const maxHalfWidth = stations.reduce((max, s) => Math.max(max, (s.right - s.left) / 2), 0);
    const maxBoardHalfWidth = outline.reduce((max, p) => {
        const rail = railAt(outline, p.y);
        return Math.max(max, (rail.right - rail.left) / 2);
    }, 0);
    const apexSections = railApex ? railApexSections(vertices, stations) : undefined;
    const sidePasses = Math.ceil((maxBoardHalfWidth + (railApex ? toolRadius : 0)) / stepover);
    if (!sidePasses || sidePasses > 10000) throw new Error('curved path prototype pass count is invalid');
    if ((1 + 2 * sidePasses) * stations.length > 2000000) {
        throw new Error('curved path prototype exceeds two million XY points; increase sample spacing or stepover');
    }
    const paths = [];
    const addPath = (side, fraction) => {
        const path = stations.map((s, index) => {
            const centre = (s.left + s.right) / 2;
            const distance = Math.min(s.y - minY, maxY - s.y);
            const t = Math.min(1, distance / taperLength);
            const taper = t * t * (3 - 2 * t);
            const rail = side === 'left' ? s.left : s.right;
            if (railApex) {
                const section = apexSections[index];
                const target = side === 'left' ? section.left : section.right;
                const amount = fraction * taper;
                return {
                    x: centre + (target.x + target.normal.x * toolRadius - centre) * amount,
                    y: s.y + target.normal.y * toolRadius * amount,
                    // Only a lower bound: never lower a toolAtZ() clearance
                    // result to force contact with an obstructed rail apex.
                    minZ: (side === 'centre' ? Math.max(section.left.z, section.right.z) : target.z) - edgeHeight
                };
            }
            return { x: centre + (rail - centre) * fraction * taper, y: s.y };
        });
        if (paths.length % 2) path.reverse();
        paths.push({ side, fraction, points: path });
    };
    addPath('centre', 0);
    for (let i = 1; i <= sidePasses; i++) {
        addPath('left', i / sidePasses);
        addPath('right', i / sidePasses);
    }
    return { outline, inset, clipOutline: railApex ? outsetOutline(outline, toolRadius) : inset,
        paths, maxHalfWidth, maxBoardHalfWidth, sidePasses, stepover, safetyMargin, railApex, apexSections };
}

/** Perimeter cut: straight flute begins just below the underside rocker.
 * Uses only the operation mesh. This intentionally does not sample deck Z.
 */
function generateBoardOutlineY(vertices, { outline = projectBoardOutline(vertices), toolRadius,
    edgeHeight, through = 0.1, sampleStep = 1, startXY, clockwise = true } = {}) {
    if (![toolRadius, edgeHeight, through, sampleStep].every(Number.isFinite) ||
        toolRadius <= 0 || edgeHeight < 0 || through < 0 || sampleStep <= 0) {
        throw new Error('invalid prototype outline cutter or sampling parameters');
    }
    const ring = outsetOutline(outline, toolRadius);
    const area = ring.reduce((sum, a, i) => {
        const b = ring[(i + 1) % ring.length];
        return sum + a.x * b.y - b.x * a.y;
    }, 0);
    if ((area < 0) !== clockwise) ring.reverse();
    if (startXY) {
        let nearest = 0, distance = Infinity;
        ring.forEach((p, i) => {
            const d = Math.hypot(p.x - startXY.x, p.y - startXY.y);
            if (d < distance) { nearest = i; distance = d; }
        });
        ring.push(...ring.splice(0, nearest));
    }
    let minY = Infinity, maxY = -Infinity;
    for (let i = 1; i < vertices.length; i += 3) {
        minY = Math.min(minY, vertices[i]); maxY = Math.max(maxY, vertices[i]);
    }
    const points = [];
    for (let i = 0; i < ring.length; i++) {
        const a = ring[i], b = ring[(i + 1) % ring.length];
        const count = Math.ceil(Math.hypot(b.x - a.x, b.y - a.y) / sampleStep);
        if (points.length + count > 2000000) throw new Error('prototype outline exceeds sample limit');
        for (let j = 0; j < count; j++) {
            const t = j / count, x = a.x + (b.x - a.x) * t, y = a.y + (b.y - a.y) * t;
            let distance = Infinity, contactY;
            for (let k = 0; k < outline.length; k++) {
                const c = outline[k], d = outline[(k + 1) % outline.length];
                const dx = d.x - c.x, dy = d.y - c.y;
                const u = Math.max(0, Math.min(1, ((x - c.x) * dx + (y - c.y) * dy) / (dx * dx + dy * dy)));
                const dist = Math.hypot(x - c.x - u * dx, y - c.y - u * dy);
                if (dist < distance) { distance = dist; contactY = c.y + u * dy; }
            }
            points.push({ x, y, contactY: Math.max(minY, Math.min(maxY, contactY)) });
        }
    }
    if (points.length > 2000000) throw new Error('prototype outline exceeds sample limit');
    const ys = [...new Set(points.map(p => p.contactY))].sort((a, b) => a - b);
    const sections = railApexSections(vertices, ys.map(y => ({ y })));
    const bottoms = new Map(sections.map(s => [s.y, s.bottomZ]));
    for (const p of points) {
        p.bottomZ = bottoms.get(p.contactY);
        p.z = p.bottomZ - edgeHeight - through;
    }
    points.push({ ...points[0] }); // explicit closure for contouring's open polygons
    return points;
}


// Proper 90-degree rotation preserves winding and milling direction. Only the
// outline helper uses this frame; raster, tabs and output stay in physical XY.
function boardFrameVertices(vertices) {
    const local = new Float32Array(vertices.length);
    for (let i = 0; i < vertices.length; i += 3) {
        local[i] = -vertices[i + 1]; local[i + 1] = vertices[i]; local[i + 2] = vertices[i + 2];
    }
    return local;
}
const toBoardFrame = p => ({ ...p, x: -p.y, y: p.x });
const fromBoardFrame = p => ({ ...p, x: p.y, y: -p.x });

export function generateBoardPaths(vertices, options = {}) {
    const axis = options.lengthAxis ?? 'Y';
    if (axis !== 'X' && axis !== 'Y') throw new Error('prototype length axis must be X or Y');
    const result = generateBoardPathsY(axis === 'X' ? boardFrameVertices(vertices) : vertices, options);
    result.lengthAxis = axis;
    if (axis === 'X') {
        for (const key of ['outline', 'inset', 'clipOutline']) result[key] = result[key].map(fromBoardFrame);
        for (const path of result.paths) path.points = path.points.map(fromBoardFrame);
        if (result.apexSections) result.apexSections = result.apexSections.map(section => ({
            ...section, x: section.y,
            left: { ...section.left, x: section.y, y: -section.left.x, normal: fromBoardFrame(section.left.normal) },
            right: { ...section.right, x: section.y, y: -section.right.x, normal: fromBoardFrame(section.right.normal) }
        }));
    }
    return result;
}

export function generateBoardOutline(vertices, options = {}) {
    const axis = options.lengthAxis ?? 'Y';
    if (axis !== 'X' && axis !== 'Y') throw new Error('prototype length axis must be X or Y');
    if (axis === 'Y') return generateBoardOutlineY(vertices, options);
    return generateBoardOutlineY(boardFrameVertices(vertices), {
        ...options, outline: options.outline?.map(toBoardFrame), startXY: options.startXY && toBoardFrame(options.startXY)
    }).map(p => {
        const point = fromBoardFrame(p);
        point.contactX = p.contactY;
        delete point.contactY;
        return point;
    });
}
