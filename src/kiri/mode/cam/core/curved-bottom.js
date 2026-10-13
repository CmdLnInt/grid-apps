/** Copyright Stewart Allen <sa@grid.space> -- All Rights Reserved */

/** Seed an empty side B only; the existing Flip action transforms geometry.
 * Never overwrite a user's second setup or duplicate operations on flip-back.
 */
export function createBottomContours(ops, otherSide, axis) {
    if (axis !== 'X' || otherSide.some(op => op.type !== 'flip')) return [];
    const contours = [];
    for (const op of ops) {
        if (op.type === '|') break;
        if (op.type !== 'contour' || op.disabled || op.curvedPathPrototype !== true ||
            op.curvedPathSide === 'bottom') continue;
        const bottom = JSON.parse(JSON.stringify(op));
        bottom.curvedPathSide = 'bottom';
        bottom.curvedPathOutline = false;
        bottom.note = op.note ? `${op.note} — bottom` : 'Curved bottom';
        contours.push(bottom);
    }
    return contours;
}
