---
description: Opt-in CPU stringer-to-rail surfboard finishing prototype
---

# Curved-path CAM prototype

This experiment runs only when a Contour operation has `curvedPathPrototype: true`. Normal Contour X/Y, WebGPU, UI controls, and G-code generation retain their existing behavior.

Orient the surfboard length along **Y**, with width along **X**. The earlier `workspace_choco.kmz` has its length along X; rotate the board 90 degrees around Z before testing Stage 2. Use the surfboard widget alone for this test. Red is X and blue is Y. An X-long board is rejected before rasterization. The prototype raster runs locally on the CPU worker, bypassing the minion queue and yielding between batches to deliver progress updates.

The prototype reads the current operation's widget through `getGeoVertices({ unroll: true, translate: true })`. It unions the XY projections of its triangles, including triangle edges between mesh vertices. It does not read stock geometry, tab meshes, other widgets, or the combined shadow. Disconnected projections, projected holes, and non-Y-monotone inset outlines are rejected rather than bridged. Separate semantic objects joined into one mesh cannot be distinguished automatically; the widget must contain only the board.

The centre/stringer pass follows the midpoint between left and right rails at each Y station. For symmetric boards this is a straight centreline; for asymmetric boards it is a geometric midpoint curve, not an independently supplied design stringer. Successive passes widen toward the left and right rails, in this order: centre, left 1, right 1, left 2, right 2, and so on. Every second pass reverses direction. The prototype emits these passes in order instead of applying the usual nearest-endpoint reordering.

Configure the operation through the browser console:

```js
const op = kiri_api.conf.get().process.ops.find(op => op.type === "contour");
op.curvedPathPrototype = true;
op.curvedPathStepover = 5;       // millimetres; default 5
op.curvedPathSafetyMargin = 10;  // millimetres; default 10
kiri_api.conf.save();
```

The number of widening passes per side is `ceil(maximum projected board half-width / stepover)`. Interpolation toward each inset rail keeps the lateral spacing no greater than this value; spacing decreases near the ends. The full centre-to-rail set is generated, replacing Stage 1's single sine path.

The margin is an XY polygon inset, not a horizontal X subtraction. A 0.01 mm numerical guard is added to the offset. Paths converge at common inset nose/tail endpoints; blunt ends use a short smooth taper to avoid abrupt lateral tip segments. Every inset polygon vertex Y is included along with uniformly sampled Y stations. Each XY polyline then passes through `Trace.followPath_sync()` for arc-length sampling, cutter-compensated Z, leave, tabs, and clipping. Output remains open polygons in `slice.camLines`.

To verify in the browser:

1. Restart `npm run dev`, then hard-refresh the local app.
2. Import the workspace and rotate its board into the Y orientation.
3. Apply the console settings above, then Slice and Preview.
4. Check that the centre pass comes first, successive left/right passes widen, and their directions alternate. Inspect both ends for continuity and convergence.
5. Replay stock animation, including the gated Stage 1 alignment correction.
6. Set `op.curvedPathPrototype = false`, save, and slice again to verify the normal Contour axis operation.

Automated checks:

```bash
node --test tests/cam-stringer-paths.test.mjs tests/cam-curved-path.test.mjs tests/cam-prototype-animation.test.mjs tests/cam-bullnose.test.mjs
```

The tests cover projected/asymmetric outlines, disconnected geometry and holes, inset distance, tip convergence, spacing, direction, output ordering, clipping, compensation, cache isolation, and animation gating. Browser geometry dependencies are substituted in the Topo/prepare tests; the outline tests execute the real Clipper union and offset implementation.

**This is not yet validated for machining.** The margin constrains cutter-centre XY positions; it does not guarantee that the cutter footprint stays inside the outline. Cutter-footprint and transition clearance remain to be validated, and clipping still evaluates sampled points rather than exact boundary intersections.

## Optional deck-to-rail-apex mode

Set `op.curvedPathRailApex = true` together with `op.curvedPathPrototype = true` to extend the deck cut to the widest rail points. This option currently requires a bull nose cutter. Leave it false or unset to retain the inset-only Stage 2 paths.

The rail apex is derived from transverse triangle/plane intersections, retaining each section's leftmost and rightmost 3D point. If several heights share the same maximum width, the highest one is used as the deck-side boundary. The cutter centre is offset outward by the flute radius along the rail's XY normal. The raster is padded and its slice planes aligned with that padded origin. In this mode, compensation evaluates the bull nose at each raster cell's actual physical XY distance, avoiding a whole-footprint shift from rounding an exterior cutter centre.

The intended minimum tip height is the apex height minus the height of the bull nose's outer corner. This is a lower bound only: the clearance sampler may raise the cutter to avoid neighbouring material. It never forces the tip below a computed clearance height.

The 10 mm safety margin still selects the protected longitudinal end region and convergence zone. It no longer stops the lateral rail cut 10 mm short; rail-apex mode deliberately permits cutter centres outside the projected board and stock XY masks, within an explicit cutter-centre envelope. Stock, fixtures, machine travel limits, and transitions still require independent clearance validation.

Pass count includes the additional outward cutter-centre reach. With Choco and a 12.8 mm stepover, expect 22 passes per side plus the centre pass (45 total). Change stepover only if you want a different pass count.

```js
var op = kiri_api.conf.get().process.ops.find(op => op.type === "contour");
op.curvedPathRailApex = true;
kiri_api.conf.save();
```

Re-slice and inspect the stock animation from the side: the final pass on each side should extend down to the widest rail point. This is a geometry/sampling prototype, not a validated machining strategy.
