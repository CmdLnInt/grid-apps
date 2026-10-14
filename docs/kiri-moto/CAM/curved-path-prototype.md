---
description: Opt-in CPU stringer-to-rail surfboard finishing prototype
---

# Curved-path CAM prototype

This experiment runs only when a Contour operation has `curvedPathPrototype: true`. Normal Contour X/Y, WebGPU, UI controls, and G-code generation retain their existing behavior.

OpenShaper boards can be imported with length along **X** and width along **Y**, without rotation. The prototype uses the longer XY extent as the longitudinal axis, so existing Y-long workspaces also remain supported. Red is X and blue is Y. Use the surfboard widget alone for this test. The prototype raster runs locally on the CPU worker, bypassing the minion queue and yielding between batches to deliver progress updates.

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

The margin is an XY polygon inset, not a horizontal X subtraction. A 0.01 mm numerical guard is added to the offset. Paths converge at common inset nose/tail endpoints; blunt ends use a short smooth taper to avoid abrupt lateral tip segments. Every inset polygon vertex along the longitudinal axis is included along with uniformly sampled stations. Each XY polyline then passes through `Trace.followPath_sync()` for arc-length sampling, cutter-compensated Z, leave, tabs, and clipping. Output remains open polygons in `slice.camLines`.

To verify in the browser:

1. Restart `npm run dev`, then hard-refresh the local app.
2. Import the original OpenShaper workspace with length along X; no rotation is needed. Existing Y-long workspaces also work.
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

Rail-apex finishing now defaults to zero finishing margin and reaches the longitudinal ends. The separate 10 mm outline end margin leaves nose/tail attachments. Rail-apex mode deliberately permits cutter centres outside the projected board and stock XY masks, within an explicit cutter-centre envelope. Stock, fixtures, machine travel limits, and transitions still require independent clearance validation.

Pass count includes the additional outward cutter-centre reach. With Choco and a 12.8 mm stepover, expect 22 passes per side plus the centre pass (45 total). Change stepover only if you want a different pass count.

```js
var op = kiri_api.conf.get().process.ops.find(op => op.type === "contour");
op.curvedPathRailApex = true;
kiri_api.conf.save();
```

Re-slice and inspect the stock animation from the side: the final pass on each side should extend down to the widest rail point. This is a geometry/sampling prototype, not a validated machining strategy.


## Appended deck perimeter prototype

Rail-apex mode appends perimeter rail paths after all deck passes, within the same contour operation. With a zero outline end margin these form one closed loop; the default 10 mm end margin leaves two open rail paths. The loop offsets the projected apex outline outward by the flute radius (plus the existing 0.01 mm offset guard). Its Z follows the lowest triangle intersection across each transverse board section. The cutter tip is below this underside curve by the bull nose's rounded-end rise plus `curvedPathOutlineThrough` (default 0.1 mm). For the Choco cutter this totals about 6.004 mm. This deliberately bypasses deck clearance sampling and the deck Z minimum; matching tabs raise the tip to their existing tab height.

```js
var op = kiri_api.conf.get().process.ops.find(op => op.type === "contour");
op.curvedPathPrototype = true;
op.curvedPathRailApex = true;
op.curvedPathOutline = true; // enabled by default in rail-apex mode
op.curvedPathOutlineThrough = 0.1; // millimetres
kiri_api.conf.save();
```

Reload the updated application, apply these settings, and re-slice. Preview should show all deck passes followed by two open rail paths that leave the nose and tail attached. Inspect side views and stock animation to check underside following and straight-flute engagement. Set `curvedPathOutline = false` to compare against the committed deck-only behavior. Normal contours and inset-only prototypes do not append this loop.

The section minimum is a conservative underside rocker definition, not an exact local bottom contact surface at the rail. Validate cutter swept volume, stock/support clearance (the tip extends about 6 mm below the underside), tabs, entry/exit and the transition from the last deck pass before machining. No additional safe transition strategy is introduced here.


## Bottom cut on side B

Use the existing CAM **Flip** operation, choose axis **X**, and use its Flip action. This rotates the board 180° around its length (nose and tail retain X), transforms tabs, switches the stock Z anchor, clears geometry caches and exchanges the two operation lists. Simply adding a Flip operation does not execute the flip.

When side B is empty (or contains only its return Flip), flipping an active prototype deck setup around X now seeds side B with copies of its active curved contours. Each is marked `curvedPathSide: "bottom"`, labelled `Curved bottom`, and has `curvedPathOutline: false`. Tool, stepover, leave, tolerance and rail-apex settings are copied. Existing side-B operations are never replaced; normal contours and Y flips retain their existing behavior. Flipping back restores the original deck list without creating duplicates.

Reload the updated app, open the deck workspace and save it before flipping. Add a Flip operation if needed, select **X**, and click its Flip action. Confirm the underside faces upward and the operation list shows the bottom contour followed by the return Flip. Slice and preview side B. Confirm stringer-to-rail passes follow the underside rocker and no perimeter loop is emitted. Use Flip around X again to return to the deck setup. Export each setup separately only after validating its coordinates, support and cutter clearance.

Bottom finishing uses the transformed mesh with the same compensated physical XY sampler; it does not invert an already-generated deck toolpath. Side B's stock animation starts with fresh stock and does not preserve the deck cut. The stock fixture/support and actual remaining material are not validated by this animation.

Run bottom-specific tests alongside the existing suite:

```bash
node --test tests/cam-curved-bottom.test.mjs tests/cam-stringer-paths.test.mjs tests/cam-curved-path.test.mjs tests/cam-prototype-animation.test.mjs tests/cam-bullnose.test.mjs
```


## Full finishing and outline end tabs

In rail-apex mode, deck and bottom finishing now use `curvedPathFinishingMargin` (default **0 mm**) and reach the full longitudinal outline, without the previous end taper. The older `curvedPathSafetyMargin` remains applicable to inset-only mode; existing saved values no longer shorten rail-apex finishing.

The deck outline independently uses `curvedPathOutlineEndMargin` (default **10 mm**) to leave nose and tail attached. It is split into open rail paths. Cutter centres stop an additional flute radius away from each end region, so the XY footprint does not cross the nominal 10 mm tab boundary. These are uncut outline regions, not newly created UI tab objects. Existing explicit tabs still raise the cutter as before. The bottom perimeter remains disabled.

```js
for (const op of kiri_api.conf.get().process.ops) {
    if (op.type === "contour" && op.curvedPathPrototype) {
        op.curvedPathFinishingMargin = 0;
        op.curvedPathOutlineEndMargin = 10;
    }
}
kiri_api.conf.save();
```

Reload and re-slice each side. Verify that finishing reaches both ends, and the deck outline cuts only the two rails, leaving gaps at nose and tail. Check the actual remaining end attachments in stock animation; shallow remaining thickness, finishing cutter coverage and existing stock shape can affect their strength. Transitions between the open rail paths still require clearance validation. Set the outline end margin to 0 only if a complete perimeter cut is intended.

## General scallop target

The general target is now **1 mm of additional sampled ridge height** for both deck and bottom. This follows the reference finish of about 60 deck passes and adds bottom passes compared with the earlier 40-pass reference. Other boards reuse the 1 mm target, so their pass counts adapt to shape and cutter rather than remaining fixed.

The 0.1 mm deepest-cut allowance is distinct from these positive ridge targets. Spacing never lowers compensation or grants additional penetration into the model. The targets describe additional sampled material left between cuts relative to a locally denser compensated sweep, not an exact scallop height above the CAD surface or certified depth accuracy.

Height-driven spacing starts from stringer and both outer rails and splits gaps where the swept bullnose profile warrants more paths. Old fixed stepover settings are used only when scallop spacing is disabled. Both rails use a shared fraction schedule, preserving centre/left/right ordering and alternating direction; outline end gaps, leave, tabs and output format retain their behavior.

Reload and remove previously saved 0.05 mm overrides on both operation lists to use the general 1 mm defaults:

```js
var settings = kiri_api.conf.get();
for (const op of [...settings.process.ops, ...(settings.process.op2 || [])]) {
    if (op.type === "contour" && op.curvedPathPrototype) {
        op.curvedPathScallop = true;
        delete op.curvedPathScallopHeight;
        delete op.curvedPathScallopCalibratePasses;
    }
}
kiri_api.conf.save();
```

An explicit `curvedPathScallopHeight` still overrides the side default. Smaller heights produce more paths. For a deliberate one-time calibration on a different reference board, set `curvedPathScallopCalibratePasses` to the desired total count (including stringer). The planner prioritizes the largest estimated ridge and records the derived height in `Topo.prototypePaths.scallop.target`. Save that height as the operation's `curvedPathScallopHeight` and remove the calibration count before using other boards. A newly seeded bottom operation drops deck-specific height/count overrides so it uses the general bottom default. Existing side-B records retain explicit overrides until removed.

Set `curvedPathScallop = false` to compare with the previous constant fraction/stepover paths. The planner yields progress while refining and rejects requests exceeding 1,000 passes or two million path points.

This is a sampled scallop estimate: it checks up to 65 longitudinal sections and transverse flute contact positions. The target bounds the additional sampled cusp relative to a denser compensated reference, not total error relative to the original CAD surface. Raster error, longitudinal variation between checked sections, finite toolpath sampling, leave and tab lifts are not included in that target. The returned `Topo.prototypePaths.scallop` records the target, worst sampled additional cusp, local-pair raster excess and section count for diagnostics. The local-pair raster excess compares just the two positions in each tested gap with terrain; it omits other passes and longitudinal cutter motion, and is not a final swept-stock error or promised machining tolerance. Validate actual swept volume and finish before machining.

### Cutter dimensions from kiribullnosedims.png

The Kiri tool screenshot supersedes the earlier drawing: metric is enabled; flute D=32.16 mm, flute length=71.83 mm, shaft diameter=6.35 mm, shaft length=30 mm, corner R1=9.93 mm and bottom R2=191.69 mm. Type is bullnose, tool number is 5, taper angle and tip are zero. The scallop planner reads the selected tool rather than hard-coding these dimensions. This snippet makes the current contour tool match the screenshot; it preserves the tool ID so existing contour references continue to work.

```js
var settings = kiri_api.conf.get();
var op = settings.process.ops.find(op => op.type === "contour" && op.curvedPathPrototype);
var tool = settings.tools.find(tool => tool.id === op.tool);
Object.assign(tool, {
    type: "bullnose",
    number: 5,
    metric: true,
    shaft_diam: 6.35,
    shaft_len: 30,
    flute_diam: 32.16,
    taper_angle: 0,
    taper_tip: 0,
    flute_len: 71.83,
    corner_radius: 9.93,
    bottom_radius: 191.69
});
kiri_api.conf.save();
```

Re-slice both sides after updating a shared tool: its diameter and corner rise also affect rail compensation and outline depth/end clearance. Inspect the deck's denser rail paths in preview, compare the disabled planner, and inspect stock animation. The automated flat-plane test checks the analytical spherical-cutter cusp; curved tests use the supplied bullnose dimensions and verify rail clustering, target sensitivity, X/Y equivalence, direction and limits.

```bash
node --test tests/cam-scallop-path.test.mjs tests/cam-curved-bottom.test.mjs tests/cam-stringer-paths.test.mjs tests/cam-curved-path.test.mjs tests/cam-prototype-animation.test.mjs tests/cam-bullnose.test.mjs
```

Verified with Choco and the screenshot cutter: the general 1 mm target produces **63 deck finishing passes** with a worst sampled additional ridge of **0.97009 mm**, and **53 bottom finishing passes** with a worst sampled additional ridge of **0.73625 mm**. The bottom adds 14 passes compared with the earlier 39-pass target. Both setups completed in about 22 seconds when tested concurrently. Binary subdivision may produce a finish finer than the requested threshold; other boards retain the height target, not these counts.
