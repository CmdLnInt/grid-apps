/** Copyright Stewart Allen <sa@grid.space> -- All Rights Reserved */

import { codec } from '../../../core/codec.js';
import { newPoint } from '../../../../geo/point.js';
import { newPolygon } from '../../../../geo/polygon.js';
import { newSlice } from '../../../core/slice.js';
import { Slicer as topo_slicer } from './slicer-topo.js';
import { polygons as POLY } from '../../../../geo/polygons.js';
import { Tool } from '../core/tool.js';
import { generateBoardPaths } from '../core/curved-path.js';

const RAD2DEG = 180 / Math.PI;
const DEG2RAD = Math.PI / 180;

export class Topo {
    constructor() { }

    async generate(opt = {}) {
        let { state, contour, onupdate, ondone } = opt;
        let { widget, settings, shadow, tabs } = opt.state;

        let { controller, process } = settings,
            { webGPU } = controller,
            { workarea } = state,
            animesh = parseInt(controller.animesh || 100) * 2500,
            axis = contour.axis.toLowerCase(),
            contourX = axis === "x",
            contourY = axis === "y",
            curvedPathPrototype = contour.curvedPathPrototype === true,
            curvedPathRailApex = curvedPathPrototype && contour.curvedPathRailApex === true,
            tool = new Tool(settings, contour.tool),
            rasterPadding = curvedPathRailApex ? tool.maxDiameter() / 2 + 2 : 0,
            bounds = curvedPathRailApex
                ? widget.getBoundingBox().clone().expandByVector(new THREE.Vector3(rasterPadding, rasterPadding, 0))
                : widget.getBoundingBox().clone(),
            tolerance = contour.tolerance,
            flatness = contour.flatness || (tolerance / 100),
            minX = bounds.min.x,
            maxX = bounds.max.x,
            minY = bounds.min.y,
            maxY = bounds.max.y,
            zBottom = contour.bottom ? workarea.bottom_z : 0,
            zMin = workarea.bottom_z + 0.0001,
            boundsX = maxX - minX,
            boundsY = maxY - minY,
            inside = contour.inside,
            density = 1 + (contour.reduction || 0),
            resolution = (tolerance ? tolerance : 1 / Math.sqrt(animesh / (boundsX * boundsY))).round(5),
            toolOffset = tool.generateProfile(resolution).profile,
            toolDiameter = tool.fluteDiameter(),
            toolStep = toolDiameter * contour.step,
            leave = contour.leave || 0,
            maxangle = contour.angle,
            curvesOnly = contour.curves,
            bridge = contour.bridging || 0,
            stepsX = Math.ceil(boundsX / resolution),
            stepsY = Math.ceil(boundsY / resolution),
            // Isolate the experiment from the legacy cache. Rebuilding ensures
            // raster spacing, grid dimensions, and the current tool profile all
            // use the same resolution, including automatic tolerance changes.
            widtopo = curvedPathPrototype ? undefined : widget.topo,
            topoCache = widtopo
                && widtopo.tolerance === tolerance
                && widtopo.diameter === toolDiameter
                ? widtopo : undefined,
            topo = topoCache || {
                axis,
                data: new Float32Array(new SharedArrayBuffer(stepsX * stepsY * 4)),
                stepsX,
                stepsY,
                bounds,
                diameter: toolDiameter,
                resolution,
                tolerance,
                profile: toolOffset,
                widget,
                raster: true,
                slices: null
            },
            data = topo.data,
            newslices = [],
            tabsMax = tabs ? Math.max(...tabs.map(tab => tab.dim.z / 2 + tab.pos.z)) : 0,
            tabsOn = tabs,
            tabHeight = Math.max(process.camTabsHeight + zBottom, tabsMax),
            clipTab = tabsOn ? [] : null,
            clipTo = inside ? shadow.base : POLY.expand(shadow.base, toolDiameter / 2 + resolution * 3),
            partOff = inside ? 0 : toolDiameter / 2 + resolution,
            gridDelta = Math.floor(partOff / resolution),
            debug_clips = true;

        if (curvedPathRailApex && !tool.isBullNose()) {
            throw new Error('curved rail-apex prototype currently requires a bull nose cutter');
        }
        if (curvedPathPrototype && boundsY <= boundsX) {
            throw new Error('curved path prototype requires board length along Y (blue axis); rotate the board 90 degrees around Z');
        }

        // Prototype operations must neither consume nor replace the cache used
        // by existing Contour X/Y operations.
        if (!curvedPathPrototype) widget.topo = topo;

        if (contour.clipto) {
            let { stock } = settings;
            let { center, x, y } = stock;
            clipTo.push(newPolygon().centerRectangle(center, x, y));
        }

        if (tolerance === 0 && !topoCache) {
            console.log(widget.id, 'topo auto tolerance', resolution.round(4));
        }

        // console.log({ resolution, flatness });
        // used by Pocket -> Contour
        this.tolerance = resolution;

        if (tabsOn) {
            clipTab.appendAll(tabs.map(tab => {
                let ctab = POLY.expand([tab.poly], toolDiameter / 2);
                ctab.forEach(ct => ct.z = tab.dim.z / 2 + tab.pos.z);
                return ctab;
            }).flat());
        }

        // debug clipTab and clipTo
        if (debug_clips) {
            const debug = newSlice(-1);
            const output = debug.output();
            if (clipTab) output.setLayer("clip.tab", { line: 0xff0000 }).addPolys(clipTab);
            if (clipTo) output.setLayer("clip.to", { line: 0x00dd00 }).addPolys(clipTo);
            newslices.push(debug);
        }

        if (webGPU && !contour.nogpu && !curvedPathPrototype) {
            // invert tool Z offset for gpu code
            let toolBounds = new THREE.Box3()
                .expandByPoint({ x: -toolDiameter/2, y: -toolDiameter/2, z: 0 })
                .expandByPoint({ x: toolDiameter/2, y: toolDiameter/2, z: 0 });
            let toolPos = tool.profile.slice();
            for (let i=0; i<toolPos.length; i+= 3) {
                // toolPos[i+2] = -toolPos[i+2];
                toolBounds.expandByPoint({ x: toolPos[i], y: toolPos[i+1], z: toolPos[i+2] });
            }
            let toolData = { positions: toolPos, bounds: toolBounds };

            let vertices = widget.getGeoVertices({ unroll: true, translate: true });
            let wbounds = widget.getBoundingBox();
            if (!inside) {
                wbounds.expandByVector({ x: toolDiameter/2 + resolution, y: toolDiameter/2 + resolution, z: 0 });
            }

            // swap XY vertices (unswap later after polylines generated)
            if (contourY) {
                vertices = vertices.slice();
                for (let i=0; i<vertices.length; i+= 3) {
                    let tmp = vertices[i+1];
                    vertices[i+1] = vertices[i+0];
                    vertices[i+0] = tmp;
                }
                ['min','max'].forEach(ext => {
                    ext = wbounds[ext];
                    let tmp = ext.x;
                    ext.x = ext.y;
                    ext.y = tmp;
                });
            }

            let trace = contour.trace;
            let gpu = await self.get_raster_gpu({
                mode: trace ? "tracing" : "planar",
                resolution
            });
            let xStep = density;
            let yStep = Math.ceil(toolStep / resolution);
            let epsilon = 10e-4;
            // load the pre-generated tool profile
            await gpu.loadTool({
                sparseData: toolData
            });
            // rasterize the terrain to the same resolution
            let terrain = await gpu.loadTerrain({
                triangles: vertices,
                boundsOverride: wbounds
            });
            let { gridWidth, positions } = terrain;
            // generate all scanline points passing tool over terrain
            let output = await gpu.generateToolpaths({
                xStep,
                yStep,
                zFloor: zBottom - 1,
                onProgress(pct) { console.log({ pct }); onupdate(pct/100, 100) }
            });
            gpu.mode = 'tracing';
            // create coastline path around part for tip-to-tip travels
            // convert shadow/clip poly lines to raster float32 array groups
            let paths = POLY.flatten(clipTo).map(poly => poly.points.map(p => [ p.x, p.y ]).flat().toFloat32());
            let coastline = await gpu.generateToolpaths({
                paths,
                step: 1,
                zFloor: zBottom
            });
            this.coastline = coastline.paths.map(arr => newPolygon().fromArray([0,...arr]));
            gpu.terminate();

            let { numScanlines, pointsPerLine, pathData } = output;
            let xmult = xStep * resolution;
            let ymult = yStep * resolution;
            let xoff = wbounds.min.x;
            let yoff = wbounds.min.y;
            let slices = [];
            function calcPoint(x, y, z, tx, ty) {
                let p = newPoint(x, y, z);
                p.tx = tx;
                p.ty = ty;
                return p;
            }
            // for each toolpath, return a point in part space coordinated
            // attach to a polyline, and annotate with terrain coordinates
            // so we can later dertermine if the point is on or off the part
            for (let i=0; i<numScanlines; i++) {
                let lineStart = i * pointsPerLine;
                let lineData = pathData.slice(lineStart, lineStart + pointsPerLine);
                let points = Array.from(lineData).map((v,j) => calcPoint(j * xmult + xoff, i * ymult + yoff, v, j * xStep, i * yStep));
                let slice = newSlice(i);
                let poly = newPolygon().setOpen();
                let lines = [ ];
                // track z co-planar skipped points for latent emission
                let skip = 0;
                let lp;
                for (let p of points) {
                    // detect points where no rays intersect the part (off part)
                    if (inside && positions[p.ty * gridWidth + p.tx] < zBottom - epsilon) {
                        if (poly.length > 1) {
                            lines.push(poly);
                            poly = newPolygon().setOpen();
                        } else if (poly.length === 1) {
                            poly = newPolygon().setOpen();
                        }
                        lp = undefined;
                        skip = 0;
                        continue;
                    }
                    // off part but we want to return zBottom (outside)
                    if (p.z < zBottom - epsilon) {
                        lp = p;
                        if (poly.length === 0) {
                            skip++;
                            continue;
                        }
                        if (poly.length > 1) {
                            skip = 0;
                            p.z = zBottom;
                            poly.push(p);
                            lines.push(poly);
                            poly = newPolygon().setOpen();
                            continue;
                        }
                    } else if (lp && skip && poly.length === 0) {
                        // latent/last point output
                        lp.z = zBottom;
                        poly.push(lp);
                    }
                    poly.push(lp = p);
                    skip = 0;
                }
                // require two points or more
                if (poly.length > 1) {
                    lines.push(poly);
                }
                // fixup/swap when contouring along Y
                if (contourY) {
                    for (let poly of lines)
                    for (let p of poly.points) {
                        p.swapXY();
                    }
                }
                // raise output points when inside tab boundaries
                if (tabsOn && clipTab.length)
                for (let poly of lines) {
                    for (let p of poly.points) {
                        for (let clip of clipTab) {
                            if (p.z < clip.z && p.isInPolygon(clip)) {
                                p.z = clip.z;
                                break;
                            }
                        }
                    }
                }
                // drop interior points along a continuous slope
                for (let poly of lines) {
                    let { points } = poly;
                    if (points.length < 2) continue;
                    let merged = [ points[0] ];
                    let lastP = points[0];
                    let latent = null;
                    let lastSlope = undefined;
                    for (let i=1; i<points.length; i++) {
                        let newP = points[i];
                        const dl = (newP.x - lastP.x) || (newP.y - lastP.y);
                        const dz = newP.z - lastP.z;
                        const slope = Math.atan2(dz, dl);
                        if (curvesOnly && Math.abs(dz) < flatness) {
                            // end current segment with latent if present
                            if (latent) {
                                merged.push(latent);
                                latent = null;
                            }
                            // add empty points as path separators
                            merged.push(undefined);
                            lastSlope = undefined;
                        } else if (lastSlope !== undefined && Math.abs(lastSlope - slope) < flatness) {
                            latent = newP;
                        } else {
                            if (latent) {
                                merged.push(latent);
                                latent = null;
                            }
                            merged.push(newP);
                            lastSlope = slope;
                        }
                        lastP = newP;
                    }
                    // add final latent point if present
                    if (latent && merged.peek() !== latent) {
                        merged.push(latent);
                    }
                    poly.points = merged;
                }
                // drop flat regions when enabled
                if (curvesOnly) {
                    let nulines = [];
                    for (let poly of lines) {
                        let { points } = poly;
                        let newp = [];
                        for (let p of points) {
                            if (p) {
                                newp.push(p);
                            } else if (newp.length) {
                                nulines.push(newPolygon(newp).setOpen());
                                newp = [];
                            }
                        }
                        nulines.push(newPolygon(newp).setOpen());
                    }
                    lines = nulines.filter(p => p.perimeter() > toolStep);
                }
                slice.camLines = lines;
                slices.push(slice);
                if (inside) {
                    onupdate(i, numScanlines);
                }
            }
            ondone(slices);
            return this;
        }

        const probe = this.probe = new Probe({
            profile: toolOffset,
            // A cached raster may have been built with a different auto resolution.
            // The prototype must use that raster's actual spacing and dimensions.
            resolution: curvedPathPrototype ? topo.resolution : resolution,
            data,
            stepsX: curvedPathPrototype ? topo.stepsX : stepsX,
            stepsY: curvedPathPrototype ? topo.stepsY : stepsY,
            boundsX,
            boundsY,
            minX: curvedPathPrototype ? topo.bounds.min.x : minX,
            minY: curvedPathPrototype ? topo.bounds.min.y : minY,
            zMin
        });

        const { toolAtZ, toolAtXY, zAtXY } = probe;

        this.toolAtZ = toolAtZ;
        this.toolAtXY = toolAtXY;
        this.zAtXY = zAtXY;

        const trace = this.trace = new Trace(probe, {
            curvesOnly,
            maxangle,
            flatness,
            bridge,
            contourX
        });

        if (curvedPathRailApex) trace.physicalTool = tool;

        if (topo.raster) {
            const box = topo.box = new THREE.Box2();

            const params = {
                resolution,
                curvedPathPrototype,
                curvedPathRailApex,
                minX,
                maxX,
                curvesOnly,
                flatness,
                stepsY,
                minY,
                maxY,
                zMin,
                data,
                box
            };

            onupdate(0, 1, "raster");
            await this.raster(widget, params, (i, l, p) => {
                onupdate(i / 2, l, p);
            });
            topo.raster = false;
        }

        await this.contour({
            box: topo.box,
            minX,
            maxX,
            minY,
            maxY,
            stepsX,
            stepsY,
            boundsX,
            boundsY,
            partOff,
            gridDelta,
            resolution,
            toolStep,
            contourX,
            contourY,
            curvedPathPrototype,
            prototypeVertices: curvedPathPrototype ? widget.getGeoVertices({ unroll: true, translate: true }) : undefined,
            prototypeStepover: contour.curvedPathStepover ?? 5,
            prototypeSafetyMargin: contour.curvedPathSafetyMargin ?? 10,
            prototypeRailApex: curvedPathRailApex,
            prototypeToolRadius: tool.fluteDiameter() / 2,
            prototypeEdgeHeight: curvedPathRailApex ? tool.getBullNoseParams().rise : undefined,
            rasterPadding,
            density,
            clipTo,
            clipTab,
            clipTabZ: clipTab ? clipTab.map(t => t.z) : undefined,
            tabHeight,
            newslices,
            leave
        }, (i, l, p) => {
            onupdate(l / 2 + i / 2, l, p);
        });

        ondone(newslices);

        return this;
    }

    async raster(widget, params, onupdate) {
        const { resolution } = params;
        const { box } = params;
        const { dispatch, minions } = self.kiri_worker;

        const vertices = widget.getGeoVertices({ unroll: true, translate: true }).toShared();
        const range = { min: Infinity, max: -Infinity };

        // swap XZ in shared array
        for (let i = 0, l = vertices.length; i < l; i += 3) {
            const x = vertices[i];
            const z = vertices[i + 2];
            vertices[i] = z;
            vertices[i + 2] = x;
            range.min = Math.min(range.min, x);
            range.max = Math.max(range.max, x);
        }

        if (params.curvedPathRailApex) {
            // Keep the padded raster's pixel origin aligned with the slice
            // planes; do not label model-origin slices as padded-origin cells.
            range.min = params.minX;
            range.max = params.maxX;
        }
        const shards = Math.ceil(Math.min(25, vertices.length / 27000));
        const step = (range.max - range.min) / shards;

        let slices = [];
        let index = 0;
        let slice = { min: range.min, max: range.min + step, index };
        for (let z = range.min; z < range.max; z += resolution) {
            if (z > slice.max) {
                slices.push(slice);
                slice = { min: z, max: z + step, index };
            }
            index++;
        }
        slices.push(slice);
        // console.log({ shards, range, step, slices });

        let complete = 0;
        // define sharded ranges
        if (minions.running > 1 && !params.curvedPathPrototype) {

            dispatch.putCache({ key: widget.id, data: vertices }, {
                done: data => {
                    // console.log({ put_cache_done: data });
                }
            });

            let promises = slices.map(slice => {
                return new Promise(resolve => {
                    minions.queue({
                        cmd: "topo_raster",
                        id: widget.id,
                        params,
                        slice
                    }, data => {
                        resolve(data);
                        onupdate(++complete, slices.length, "raster");
                    });
                });
            });

            // merge boxes for all rasters for contouring clipping
            (await Promise.all(promises))
                .map(rec => rec.box)
                .map(box => new THREE.Box2(
                    new THREE.Vector2(box.min.x, box.min.y),
                    new THREE.Vector2(box.max.x, box.max.y)
                ))
                .map(box2 => {
                    box.union(box2);
                    return box2;
                });

            dispatch.clearCache({}, {
                done: data => {
                    // console.log({ clear_cache_done: data });
                }
            });

        } else {

            // iterate over shards, merge output
            // const output = [];
            for (let slice of slices) {
                new topo_slicer(slice.index)
                    .setFromArray(vertices, slice)
                    .slice(resolution)
                    .map(rec => {

                        const slice = newSlice(rec.z);
                        slice.index = rec.index;
                        slice.lines = rec.lines;
                        for (let line of rec.lines) {
                            const { p1, p2 } = line;
                            if (!p1.swapped) { p1.swapXZ(); p1.swapped = true }
                            if (!p2.swapped) { p2.swapXZ(); p2.swapped = true }
                        }

                        raster_slice({
                            ...params,
                            box,
                            lines: rec.lines,
                            gridx: rec.index,
                            slice: params.curvedPathPrototype ? undefined : slice
                        });

                        return slice;
                    });
                onupdate(++complete, slices.length, "raster");
                if (params.curvedPathPrototype) {
                    // Let the worker deliver progress/cancellation messages
                    // between batches instead of waiting on the minion queue.
                    await new Promise(resolve => setTimeout(resolve, 0));
                }
            }

        }
    }

    async contour(params, onupdate) {
        const trace = this.trace;
        const concurrent = !params.curvedPathPrototype && self.kiri_worker.minions.running;

        const { minX, maxX, minY, maxY, boundsX, boundsY, stepsX, stepsY } = params;
        const { gridDelta, resolution, density, partOff, toolStep, contourX, contourY } = params;
        const { clipTo, clipTab, clipTabZ, tabHeight, newslices, leave } = params;

        // Prototype geometry comes only from this operation's widget, never
        // stock, tabs, a global widget collection, or the combined shadow.
        if (params.curvedPathPrototype) {
            onupdate(0, 1, "project board outline");
            const generated = generateBoardPaths(params.prototypeVertices, {
                stepover: params.prototypeStepover,
                safetyMargin: params.prototypeSafetyMargin,
                sampleStep: resolution * density,
                railApex: params.prototypeRailApex,
                toolRadius: params.prototypeToolRadius,
                edgeHeight: params.prototypeEdgeHeight
            });
            const insetClip = newPolygon(generated.clipOutline.map(p => newPoint(p.x, p.y, 0)));
            trace.init({
                box: params.box.clone().expandByVector(new THREE.Vector3(
                    params.prototypeRailApex ? params.rasterPadding : partOff,
                    params.prototypeRailApex ? params.rasterPadding : partOff, 0)),
                // Apex cutter centres intentionally leave the board/stock XY
                // mask; use the explicit cutter-centre envelope instead.
                leave, clipTo: params.prototypeRailApex ? undefined : clipTo, clipWithin: [insetClip], clipTab, clipTabZ, tabHeight,
                resolution, density, concurrent: false
            });
            try {
                this.prototypePaths = generated;
                onupdate(0, generated.paths.length, "stringer-to-rail prototype");
                for (let i = 0; i < generated.paths.length; i++) {
                    const segments = trace.followPath_sync(generated.paths[i].points);
                    if (segments.length) {
                        const slice = newSlice(i);
                        slice.camLines = segments;
                        newslices.push(slice);
                    }
                    onupdate(i + 1, generated.paths.length, "stringer-to-rail prototype");
                }
            } finally {
                trace.cleanup();
            }
            return;
        }

        let stepsTaken = 0,
            stepsTotal = 0;

        if (contourX) {
            stepsTotal += ((maxY - minY + partOff * 2) / toolStep) | 0;
        }

        if (contourY) {
            stepsTotal += ((maxX - minX + partOff * 2) / toolStep) | 0;
        }

        if (stepsTotal === 0) {
            return;
        }

        const box = params.box.clone().expandByVector(new THREE.Vector3(
            partOff, partOff, 0
        ));

        trace.init({
            box,
            leave,
            clipTo,
            clipTab,
            clipTabZ,
            tabHeight,
            resolution,
            concurrent,
            density
        });

        let resolver;
        let pcount = 0;
        let slicesY = [];
        let slicesX = [];
        let promise = new Promise(resolve => {
            resolver = () => {
                // sort output slices (required for async)
                slicesY.sort((a, b) => a.z - b.z);
                slicesX.sort((a, b) => a.z - b.z);
                newslices.appendAll(slicesY);
                newslices.appendAll(slicesX);
                resolve();
            }
        });
        let inc = () => { pcount++ };
        let dec = () => { if (--pcount === 0 && concurrent) resolver() };

        if (contourY) {
            onupdate(0, stepsTotal, "contour y");
            // emit slice per X
            for (let x = minX - partOff; x <= maxX + partOff; x += toolStep) {
                if (x < box.min.x || x > box.max.x) continue;
                const gridx = Math.round(((x - minX) / boundsX) * stepsX);
                const gridy = -gridDelta;
                inc();
                trace.crossY({
                    from: minY - partOff,
                    to: maxY + partOff,
                    x,
                    gridx,
                    gridy
                }, segments => {
                    if (segments.length > 0) {
                        let slice = newSlice(x);
                        slice.camLines = segments;
                        slicesY.push(slice);
                    }
                    onupdate(++stepsTaken, stepsTotal, "contour y");
                    dec();
                });
            }
        }

        if (contourX) {
            // emit slice per Y
            onupdate(0, stepsTotal, "contour x");
            for (let y = minY - partOff; y <= maxY + partOff; y += toolStep) {
                if (y < box.min.y || y > box.max.y) continue;
                const gridy = Math.round(((y - minY) / boundsY) * stepsY);
                const gridx = -gridDelta;
                inc();
                trace.crossX({
                    from: minX - partOff,
                    to: maxX + partOff,
                    y,
                    gridx,
                    gridy
                }, segments => {
                    if (segments.length > 0) {
                        let slice = newSlice(y);
                        slice.camLines = segments;
                        slicesX.push(slice);
                    }
                    onupdate(++stepsTaken, stepsTotal, "contour x");
                    dec();
                });
            }
        }

        if (!concurrent) resolver();

        await promise;

        // const lines = newslices.map(s => (s.camLines || []).map(p => p.length));
        // const points = lines.flat().reduce((a,b) => a+b);
        // console.log({ lines, points });

        trace.cleanup();
    }

}

export class Probe {

    // Rail-apex centres lie outside the model, where rounding the centre to a
    // pixel can shift the whole cutter footprint into the steep deck surface.
    // Evaluate the bull nose at each raster cell's actual physical distance.
    toolAtPhysicalXY(px, py, tool) {
        const { data, resolution, minX, minY, stepsX, stepsY, zMin } = this.params;
        const fluteRadius = tool.fluteDiameter() / 2;
        const radius = Math.max(fluteRadius, tool.shaftDiameter() / 2);
        const fluteLength = tool.fluteLength();
        const { corner, bottom, center, rise, join } = tool.getBullNoseParams();
        const x0 = Math.max(0, Math.ceil((px - radius - minX) / resolution));
        const x1 = Math.min(stepsX - 1, Math.floor((px + radius - minX) / resolution));
        const y0 = Math.max(0, Math.ceil((py - radius - minY) / resolution));
        const y1 = Math.min(stepsY - 1, Math.floor((py + radius - minY) / resolution));
        let height = zMin;
        for (let x = x0; x <= x1; x++) {
            for (let y = y0; y <= y1; y++) {
                const distance = Math.hypot(minX + x * resolution - px, minY + y * resolution - py);
                if (distance > radius) continue;
                let offset;
                if (distance > fluteRadius) offset = fluteLength;
                else if (distance <= join) offset = bottom
                    ? distance ** 2 / (bottom + Math.sqrt(Math.max(0, bottom ** 2 - distance ** 2))) : 0;
                else offset = rise - Math.sqrt(Math.max(0, corner ** 2 - (distance - center) ** 2));
                height = Math.max(height, (data[x * stepsY + y] || zMin) - offset);
            }
        }
        return height;
    }

    constructor(params) {

        const { data, profile } = params;
        const { stepsX, stepsY, boundsX, zMin, minX, minY } = params;

        this.params = params;

        // return the touching z given topo x,y and a tool profile
        const toolAtZ = this.toolAtZ = function (x, y) {
            let sx = stepsX,
                sy = stepsY,
                xl = sx - 1,
                yl = sy - 1;

            let gv, i = 0, mz = -Infinity;

            while (i < profile.length) {
                // tool profile point x, y, and z offsets
                const tx = profile[i++] + x;
                const ty = profile[i++] + y;
                const tz = profile[i++];
                if (tx < 0 || tx > xl || ty < 0 || ty > yl) {
                    // if outside max topo steps, use zMin
                    gv = zMin;
                } else {
                    // lookup grid value @ tx, ty
                    gv = data[tx * sy + ty] || zMin;
                }
                // update the rest
                mz = Math.max(tz + gv, mz);
            }

            return Math.max(mz, zMin);
        }

        // export z probe function
        const rx = stepsX / boundsX;
        const ry = stepsX / boundsX;
        const toolAtXY = this.toolAtXY = function (px, py) {
            px = Math.round(rx * (px - minX));
            py = Math.round(ry * (py - minY));
            return toolAtZ(px, py);
        };

        const zAtXY = this.zAtXY = function (px, py) {
            let ix = Math.round(rx * (px - minX));
            let iy = Math.round(ry * (py - minY));
            return data[ix * stepsY + iy] || zMin;
        };
    }

}

export class Trace {

    constructor(probe, params) {

        const { curvesOnly, maxangle, flatness, bridge, contourX, leave } = params;

        this.params = params;
        this.probe = probe;

        let trace,
            slice,
            latent,
            lastPP,
            lastSlope;

        const newslice = this.newslice = () => {
            this.slice = slice = [];
        }

        const newtrace = this.newtrace = function () {
            trace = newPolygon().setOpen();
        }

        const end_poly = this.end_poly = function (point) {
            if (latent) {
                trace.push(latent);
            }
            if (trace.length > 0) {
                // add additional constraint on min perimeter()
                if (trace.length > 1) {
                    slice.push(trace);
                }
                newtrace();
            }
            lastPP = undefined;
            latent = undefined;
            lastSlope = undefined;
            if (point) {
                trace.push(point);
                lastPP = point;
            }
        }

        const log = function (map) {
            for (let key in map) {
                const val = map[key];
                if (typeof val === 'number') {
                    map[key] = val.round(4);
                }
            }
            console.log(...arguments);
        }

        this.push_point = function (x, y, z) {
            const newP = newPoint(x, y, z);
            const lastP = lastPP;

            if (lastP) {
                const dl = (x - lastP.x) || (y - lastP.y);
                const dz = z - lastP.z;
                const slope = Math.atan2(dz, dl);
                if (curvesOnly && Math.abs(dz) < flatness) {
                    end_poly(newP);
                } else if (lastSlope !== undefined && Math.abs(lastSlope - slope) < flatness) {
                    latent = newP;
                } else {
                    if (latent) {
                        trace.push(latent);
                        latent = undefined;
                    }
                    if (curvesOnly) {
                        const dv = contourX ? Math.abs(lastP.x - x) : Math.abs(lastP.y - y);
                        const angle = Math.atan2(Math.abs(dz), dv) * RAD2DEG;
                        if (angle > maxangle) {
                            end_poly();
                        }
                    }
                    trace.push(newP);
                }
                lastSlope = slope;
            } else {
                trace.push(newP);
            }

            lastPP = newP;
        }

        const object = this.object = this;

        this.inClip = function (clips, checkZ, point) {
            let ok = 0;
            for (let i = 0; i < clips.length; i++) {
                let poly = clips[i];
                let zok = checkZ ? checkZ <= poly.z : true;
                object.tabZ = poly.z;
                if (zok && point.isInPolygon(poly)) {
                    ok++;
                }
            }
            return ok > 0;
        }

    }

    init(params) {
        this.cross = params;
        const { minions } = self.kiri_worker ?? {};
        const { clipTab, clipTabZ } = params;

        // because codec does not encode arbitrary fields
        // in this case, z is appended to clip tabs in topo constructor
        // we pass it as a side-channel and re-consitute here
        if (clipTab)
            for (let i = 0, l = clipTab.length; i < l; i++) {
                clipTab[i].z = clipTabZ[i];
            }

        if (minions && this.cross.concurrent) {
            minions.broadcast("trace_init", codec.encode({
                probe: this.probe.params,
                trace: this.params,
                cross: params,
            }));
        }
    }

    cleanup() {
        const { minions } = self.kiri_worker;

        if (minions && this.cross.concurrent) {
            minions.broadcast("trace_cleanup");
        }
    }

    crossY(params, then) {
        const { minions } = self.kiri_worker;

        if (minions && this.cross.concurrent) {
            minions.queue({
                cmd: "trace_y",
                params
            }, data => {
                then(codec.decode(data.slice));
            });
        } else {
            this.crossY_sync(params, then);
        }
    }

    crossX(params, then) {
        const { minions } = self.kiri_worker;

        if (minions && this.cross.concurrent) {
            minions.queue({
                cmd: "trace_x",
                params
            }, data => {
                then(codec.decode(data.slice));
            });
        } else {
            this.crossX_sync(params, then);
        }
    }

    /**
     * Project an ordered physical XY polyline onto the compensated CPU raster.
     * Returns open Polygon segments; clipping is evaluated at each sample.
     * Keep vertices as well as arc-length samples to preserve XY corners.
     */
    followPath_sync(path) {
        const { box, resolution, density, leave = 0, clipTo, clipWithin, clipTab, tabHeight } = this.cross;
        const { minX, minY, stepsX, stepsY, resolution: rasterResolution } = this.probe.params;
        const pixelSize = rasterResolution ?? resolution;
        const step = resolution * density;
        if (!(step > 0) || !Number.isFinite(step) || !(pixelSize > 0) || !Number.isFinite(pixelSize)) {
            throw new Error("followPath_sync requires positive finite raster and sample resolution");
        }
        const segments = this.slice = [];
        let polygon = newPolygon().setOpen();
        const end = () => {
            if (polygon.length > 1) segments.push(polygon);
            polygon = newPolygon().setOpen();
        };
        const emit = (x, y, minZ) => {
            // Raster cells are written at min + index * resolution, not at
            // index * bounds/steps (which differs when bounds are rounded up).
            const gridx = Math.round((x - minX) / pixelSize);
            const gridy = Math.round((y - minY) / pixelSize);
            if (x < box.min.x || x > box.max.x || y < box.min.y || y > box.max.y ||
                x < minX || y < minY ||
                x > minX + (stepsX - 1) * pixelSize || y > minY + (stepsY - 1) * pixelSize ||
                gridx < 0 || gridx >= stepsX || gridy < 0 || gridy >= stepsY) {
                end();
                return;
            }
            const point = newPoint(x, y);
            if ((clipTo && !this.inClip(clipTo, undefined, point)) ||
                (clipWithin && !this.inClip(clipWithin, undefined, point))) {
                end();
                return;
            }
            let z = this.physicalTool
                ? this.probe.toolAtPhysicalXY(x, y, this.physicalTool)
                : this.probe.toolAtZ(gridx, gridy);
            if (Number.isFinite(minZ)) z = Math.max(z, minZ);
            if (clipTab && clipTab.length && z < tabHeight) {
                // Reuse the same Z-aware polygon predicate. Evaluate tabs one
                // at a time so tabZ belongs to a matching tab, including overlaps.
                for (const tab of clipTab) {
                    if (this.inClip([tab], z, point)) z = Math.max(z, this.tabZ);
                }
            }
            point.z = z + leave;
            polygon.push(point);
        };
        if (!path.length) return segments;
        for (const point of path) {
            if (!Number.isFinite(point.x) || !Number.isFinite(point.y)) {
                throw new Error("followPath_sync requires finite physical XY coordinates");
            }
        }
        emit(path[0].x, path[0].y, path[0].minZ);
        let untilSample = step;
        for (let i = 1; i < path.length; i++) {
            const from = path[i - 1], to = path[i];
            const dx = to.x - from.x, dy = to.y - from.y;
            const length = Math.hypot(dx, dy);
            if (!length) continue;
            let distance = untilSample;
            while (distance < length) {
                const t = distance / length;
                const minZ = Number.isFinite(from.minZ) && Number.isFinite(to.minZ)
                    ? from.minZ + (to.minZ - from.minZ) * t : undefined;
                emit(from.x + dx * t, from.y + dy * t, minZ);
                distance += step;
            }
            emit(to.x, to.y, to.minZ);
            untilSample = distance - length;
            if (untilSample <= step * 1e-10) untilSample = step;
        }
        end();
        return segments;
    }

    crossY_sync(params, then) {
        const { push_point, end_poly, newtrace, newslice, inClip } = this.object;
        const { clipTab, tabHeight, clipTo, box, resolution, density, leave } = this.cross;
        const { toolAtZ } = this.probe;

        let { from, to, x, gridx, gridy } = params;

        const step = resolution * density;
        const checkr = newPoint(0, 0);
        newslice();
        newtrace();
        for (let y = from; y < to; y += step) {
            if (y < box.min.y || y > box.max.y) {
                gridy += density;
                continue;
            }
            // find tool z at grid point
            let tv = toolAtZ(gridx, gridy);
            checkr.x = x;
            checkr.y = y;
            // when tabs are on and this point is inside the
            // tab polygon, ensure z is at least tabHeight
            if (clipTab && clipTab.length && tv < tabHeight && inClip(clipTab, tv, checkr)) {
                tv = this.tabZ;
            }
            // if the value is on the floor and inside the clip
            // poly (usually shadow), end the segment
            if (clipTo && !inClip(clipTo, undefined, checkr)) {
                end_poly();
                gridy += density;
                continue;
            }
            push_point(x, y, tv + leave);
            gridy += density;
        }
        end_poly();
        then(this.slice);
    }

    crossX_sync(params, then) {
        const { push_point, end_poly, newtrace, newslice, inClip } = this.object;
        const { clipTab, tabHeight, clipTo, box, resolution, density, leave } = this.cross;
        const { toolAtZ } = this.probe;
        let { from, to, y, gridx, gridy } = params;

        const step = resolution * density;
        const checkr = newPoint(0, 0);
        newslice();
        newtrace();
        for (let x = from; x < to; x += step) {
            if (x < box.min.x || x > box.max.x) {
                gridx += density;
                continue;
            }
            // find tool z at grid point
            let tv = toolAtZ(gridx, gridy);
            checkr.x = x;
            checkr.y = y;
            // when tabs are on and this point is inside the
            // tab polygon, ensure z is at least tabHeight
            if (clipTab && clipTab.length && tv < tabHeight && inClip(clipTab, tv, checkr)) {
                tv = this.tabZ;
            }
            // if the value is on the floor and inside the clip
            // poly (usually shadow), end the segment
            if (clipTo && !inClip(clipTo, undefined, checkr)) {
                end_poly();
                gridx += density;
                continue;
            }
            push_point(x, y, tv + leave);
            gridx += density;
        }
        end_poly();
        then(this.slice);
    }
}

export function raster_slice(inputs) {
    const { lines, data, box, resolution, curvesOnly } = inputs;
    const { flatness, zMin, minY, maxY, stepsY, gridx } = inputs;
    const { slice } = inputs;

    let gridy,
        gridi, // index
        gridv, // value
        i, il, j, x, y, tv;

    // filter lines pairs to only surface "up-facing", "uncovered" lines
    let points = [];
    // emit an array of valid line-pairs
    const len = lines.length;

    outer: for (let i = 0; i < len; i++) {
        let l1 = lines[i], p1 = l1.p1, p2 = l1.p2;
        // eliminate vertical
        if (Math.abs(p1.y - p2.y) < flatness) continue;
        // eliminate if both points below cutoff
        if (p1.z < zMin && p2.z < zMin) continue;
        // sort p1,p2 by y for comparison
        if (p1.y > p2.y) { const tp = p1; p1 = p2; p2 = tp };
        // eliminate if points "under" other lines
        for (let j = 0; j < len; j++) {
            // skip self and adjacent
            if (j >= i - 1 && j <= i + 1) continue;
            let l2 = lines[j], p3 = l2.p1, p4 = l2.p2;
            // sort p3,p4 by y for comparison
            if (p3.y > p4.y) { const tp = p3; p3 = p4; p4 = tp };
            // it's under the other line
            if (Math.max(p1.z, p2.z) < Math.min(p3.z, p4.z)) {
                // it's inside the other line, too, so skip
                if (p1.y >= p3.y && p2.y <= p4.y) continue outer;
            }
        }
        points.push(p1, p2);
        box.expandByPoint(p1);
        box.expandByPoint(p2);
    }

    gridy = 0;
    // rasterize one x slice
    for (y = minY; y < maxY && gridy < stepsY; y += resolution) {
        gridi = gridx * stepsY + gridy;
        gridv = data[gridi] || zMin;
        // strategy using raw lines (faster slice, but more lines)
        for (i = 0, il = points.length; i < il; i += 2) {
            const p1 = points[i], p2 = points[i + 1];
            // one endpoint above grid
            const crossz = (p1.z > gridv || p2.z > gridv);
            // segment crosses grid y
            const spansy = (p1.y <= y && p2.y >= y);
            if (crossz && spansy) {
                // compute intersection of z ray up
                // and segment at this grid point
                const dy = p1.y - p2.y,
                    dz = p1.z - p2.z,
                    pct = (p1.y - y) / dy,
                    nz = p1.z - (dz * pct);
                // save if point is greater than existing grid point
                if (nz > gridv) {
                    gridv = data[gridi] = Math.max(nz, zMin);
                    if (slice) slice.output()
                        .setLayer("heights", { face: 0, line: 0 })
                        .addLine(
                            newPoint(p1.x, y, 0),
                            newPoint(p1.x, y, gridv)
                        );
                }
            }
        }
        gridy++;
    }

    // remove flat lines when curvesOnly
    if (curvesOnly) {
        let nup = [];
        for (let i = 0, p = points, l = p.length; i < l; i += 2) {
            const p1 = p[i];
            const p2 = p[i + 1];
            if (Math.abs(p1.z - p2.z) >= flatness) {
                nup.push(p1, p2);
            }
        }
        points = nup;
    }

    return points;
};

export async function generate(opt) {
    return new Topo().generate(opt);
}
