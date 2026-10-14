/** Copyright Stewart Allen <sa@grid.space> -- All Rights Reserved */

// General ridge target for both sides, checked on workspace_choco.kmz
// with the kiribullnosedims.png cutter and full rail-apex paths.
// These are positive additional ridge heights, never penetration allowances.
export const DEFAULT_SCALLOP_HEIGHT = Object.freeze({
    deck: 1,
    bottom: 1
});

/** Numerical cusp refinement against a locally denser compensated sweep.
 * Checks representative longitudinal sections. This controls sampled additional
 * cusp, not total error from rasterization, allowance, tabs or travel moves.
 */
export async function refineScallopPaths(generated, { target = DEFAULT_SCALLOP_HEIGHT.deck, radius, resolution,
    heightAt, toolAt, surfaceAt, maxSections = 65, maxPasses = 1000, calibratePasses, yieldProgress = async () => {} } = {}) {
    if (!Number.isFinite(target) || target <= 0 || !(radius > 0) || !(resolution > 0) ||
        !Number.isInteger(maxSections) || maxSections < 2 || !Number.isInteger(maxPasses) || maxPasses < 3) {
        throw new Error('invalid prototype scallop parameters');
    }
    const lengthAxis = generated.lengthAxis ?? 'Y';
    const centre = generated.paths[0].points;
    if (centre.length < 2) throw new Error('scallop refinement requires at least two longitudinal samples');
    const outward = side => {
        const path = generated.paths.find(p => p.side === side && p.fraction === 1);
        if (!path) throw new Error('scallop refinement requires complete rail paths');
        const points = path.points;
        const forward = Math.hypot(points[0].x-centre[0].x,points[0].y-centre[0].y) <=
            Math.hypot(points.at(-1).x-centre[0].x,points.at(-1).y-centre[0].y);
        return forward ? points : [...points].reverse();
    };
    const indices = [...new Set(Array.from({length:Math.min(maxSections,centre.length)},(_,i) =>
        Math.round(i*(centre.length-1)/(Math.min(maxSections,centre.length)-1))))];
    const sides = {left:outward('left'),right:outward('right')};
    const caches = new Map();
    const position = (side, index, fraction) => {
        const a=centre[index],b=sides[side][index];
        return {x:a.x+(b.x-a.x)*fraction,y:a.y+(b.y-a.y)*fraction,
            minZ: b.minZ};
    };
    const compensated = (side,index,fraction) => {
        const key=`${side}:${index}:${fraction}`;
        if(caches.has(key)) return caches.get(key);
        const p=position(side,index,fraction);
        p.z=Math.max(toolAt(p.x,p.y),Number.isFinite(p.minZ)?p.minZ:-Infinity);
        if(!Number.isFinite(p.z)) throw new Error('nonfinite compensated scallop sample');
        caches.set(key,p);return p;
    };
    const sweep = (p,q) => {
        const d=Math.hypot(p.x-q.x,p.y-q.y);
        return d <= radius ? p.z+heightAt(d) : Infinity;
    };
    let evaluations=0;
    const error = (side,from,to) => {
        let worst=0, residual=0;
        for(const index of indices) {
            const a=compensated(side,index,from),b=compensated(side,index,to);
            const mid=compensated(side,index,(from+to)/2);
            // Examine transverse contact locations across the flute footprint,
            // including shifted contacts on steep rails (not just tip centres).
            const count=Math.max(16,Math.min(128,Math.ceil(2*radius/(resolution/2))));
            for(let j=0;j<=count;j++) {
                const offset=-radius+2*radius*j/count;
                const q={x:mid.x+(lengthAxis==='Y'?offset:0),y:mid.y+(lengthAxis==='X'?offset:0)};
                const surface=surfaceAt(q.x,q.y);
                if(!Number.isFinite(surface)) continue;
                const coarse=Math.min(sweep(a,q),sweep(b,q));
                const reference=Math.max(surface,Math.min(coarse,sweep(mid,q)));
                if (Number.isFinite(reference)) {
                    worst=Math.max(worst,coarse-reference);
                    residual=Math.max(residual,coarse-surface);
                }
            }
        }
        evaluations++;
        return { additional: worst, residual };
    };
    // Preserve the existing stepover as an upper bound; refine each interval.
    const fractions=[...new Set(generated.paths.filter(p=>p.side==='left').map(p=>p.fraction).concat(0))].sort((a,b)=>a-b);
    const accepted=[0];let worstAccepted=0, worstResidual=0;
    if (calibratePasses !== undefined && (!Number.isInteger(calibratePasses) || calibratePasses < 3 || calibratePasses > maxPasses)) {
        throw new Error('invalid reference scallop pass count');
    }
    const stack=[];
    for(let i=fractions.length-1;i>0;i--) stack.push([fractions[i-1],fractions[i],0]);
    const measure = (from,to,depth=0) => {
        const left=error('left',from,to),right=error('right',from,to);
        return {from,to,depth,worst:Math.max(left.additional,right.additional),
            residual:Math.max(left.residual,right.residual)};
    };
    if (calibratePasses !== undefined) {
        const budget=Math.round((calibratePasses-1)/2);
        const gaps=[];
        for(let i=1;i<fractions.length;i++) gaps.push(measure(fractions[i-1],fractions[i]));
        if(gaps.length>budget) throw new Error('reference seed already exceeds desired pass count');
        while(gaps.length<budget) {
            let index=0;
            for(let i=1;i<gaps.length;i++) if(gaps[i].worst>gaps[index].worst) index=i;
            const gap=gaps[index],mid=(gap.from+gap.to)/2;
            if(gap.depth>=20) throw new Error('reference scallop refinement exceeded depth limit');
            gaps.splice(index,1,measure(gap.from,mid,gap.depth+1),measure(mid,gap.to,gap.depth+1));
            if(evaluations%16===0) await yieldProgress(evaluations);
        }
        gaps.sort((a,b)=>a.from-b.from);
        for(const gap of gaps) {
            accepted.push(gap.to);worstAccepted=Math.max(worstAccepted,gap.worst);
            worstResidual=Math.max(worstResidual,gap.residual);
        }
        target=Math.max(worstAccepted,Number.EPSILON);
    } else while(stack.length) {
        const [from,to,depth]=stack.pop();
        const gap=measure(from,to,depth),worst=gap.worst;
        if(worst>target) {
            if(depth>=20 || 1+2*(accepted.length+stack.length+2)>maxPasses) {
                throw new Error('scallop target exceeds prototype pass limit; increase target or raster precision');
            }
            const mid=(from+to)/2;
            stack.push([mid,to,depth+1],[from,mid,depth+1]);
        } else {
            accepted.push(to);worstAccepted=Math.max(worstAccepted,worst);
            worstResidual=Math.max(worstResidual,gap.residual);
        }
        if(evaluations%16===0) await yieldProgress(evaluations);
    }
    if((1+2*(accepted.length-1))*centre.length>2000000) {
        throw new Error('scallop paths exceed two million points; increase target or sample spacing');
    }
    const paths=[generated.paths[0]];
    for(const fraction of accepted.slice(1)) for(const side of ['left','right']) {
        const points=centre.map((_,index)=>position(side,index,fraction));
        if(paths.length%2) points.reverse();
        paths.push({side,fraction,points});
    }
    generated.paths=paths;
    generated.sidePasses=accepted.length-1;
    generated.scallop={target,worstSampledAdditionalCusp:worstAccepted,worstLocalPairRasterExcess:worstResidual,calibratedPasses:calibratePasses,sections:indices.length,evaluations};
    return generated;
}
