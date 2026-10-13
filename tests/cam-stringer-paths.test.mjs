import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

globalThis.self ??= globalThis;
const { projectBoardOutline, generateBoardPaths } = await import('../src/kiri/mode/cam/core/curved-path.js');

function triangles(outline, z = 1) {
    const vertices = [];
    for (let i = 1; i < outline.length - 1; i++) {
        for (const p of [outline[0], outline[i], outline[i + 1]]) vertices.push(p.x, p.y, z);
    }
    return vertices;
}
const asymmetric = [{ x:0,y:0 },{ x:40,y:100 },{ x:25,y:200 },{ x:0,y:240 },{ x:-35,y:180 },{ x:-60,y:100 }];
const rectangle = [{x:-30,y:0},{x:30,y:0},{x:30,y:200},{x:-30,y:200}];
const close = (a, b, tolerance = 1e-4) => assert.ok(Math.abs(a - b) < tolerance, `${a} ≈ ${b}`);
function distanceToOutline(point, outline) {
    return Math.min(...outline.map((a, i) => {
        const b = outline[(i + 1) % outline.length], dx = b.x - a.x, dy = b.y - a.y;
        const t = Math.max(0, Math.min(1, ((point.x - a.x) * dx + (point.y - a.y) * dy) / (dx * dx + dy * dy)));
        return Math.hypot(point.x - a.x - t * dx, point.y - a.y - t * dy);
    }));
}
function contains(point, outline) {
    if (distanceToOutline(point, outline) < 1e-4) return true;
    let inside = false;
    for (let i = 0; i < outline.length; i++) {
        const a = outline[i], b = outline[(i + 1) % outline.length];
        if ((a.y > point.y) !== (b.y > point.y) && point.x < a.x + (b.x - a.x) * (point.y - a.y) / (b.y - a.y)) inside = !inside;
    }
    return inside;
}

test('projected triangle union preserves asymmetric outline and intermediate edge intersections', () => {
    const mesh = triangles(asymmetric);
    // A second, oppositely wound surface must union rather than cancel.
    const reversed = [];
    for (let i = 0; i < mesh.length; i += 9) reversed.push(...mesh.slice(i+6,i+9),...mesh.slice(i+3,i+6),...mesh.slice(i,i+3));
    const outline = projectBoardOutline([...mesh,...reversed]);
    assert.equal(outline.length, asymmetric.length);
    const result = generateBoardPaths(mesh, {stepover:10,safetyMargin:0,sampleStep:2});
    const left = result.paths.find(p => p.side === 'left' && p.fraction === 1);
    const right = result.paths.find(p => p.side === 'right' && p.fraction === 1);
    close(left.points.find(p => p.y === 50).x, -30);
    close(right.points.find(p => p.y === 50).x, 20);
    close(result.paths[0].points.find(p => p.y === 100).x, -10);
    assert.equal(result.sidePasses, 5);
    assert.equal(result.paths.length, 11);
});

test('passes alternate direction in widening centre/left/right order and converge at both tips', () => {
    const {paths} = generateBoardPaths(triangles(asymmetric), {stepover:8,safetyMargin:10,sampleStep:2});
    const ends = [paths[0].points[0],paths[0].points.at(-1)];
    assert.equal(paths[0].side,'centre');
    for (let i=0;i<paths.length;i++) {
        const p = paths[i];
        assert.equal(p.side, i === 0 ? 'centre' : i % 2 ? 'left' : 'right');
        assert.equal(p.points[0].y < p.points.at(-1).y, i % 2 === 0);
        const ordered = i % 2 ? [...p.points].reverse() : p.points;
        close(ordered[0].x,ends[0].x);close(ordered[0].y,ends[0].y);
        close(ordered.at(-1).x,ends[1].x);close(ordered.at(-1).y,ends[1].y);
        for (let j=1;j<ordered.length;j++) assert.ok(ordered[j].y > ordered[j-1].y);
    }
});

test('maximum lateral pass spacing stays within configurable millimetre stepover', () => {
    const {paths,sidePasses,maxBoardHalfWidth} = generateBoardPaths(triangles(asymmetric), {stepover:7,safetyMargin:10,sampleStep:2});
    assert.equal(sidePasses,Math.ceil(maxBoardHalfWidth/7));
    const centre=paths[0].points;
    for(const side of ['left','right']) {
        let previous=centre;
        for(const path of paths.filter(p=>p.side===side)) {
            const current=[...path.points].sort((a,b)=>a.y-b.y);
            for(let i=0;i<current.length;i++) assert.ok(Math.abs(current[i].x-previous[i].x)<=7+1e-6);
            previous=current;
        }
    }
});

test('safety margin is actual XY distance, including sloping rails and interpolated segments', () => {
    const result=generateBoardPaths(triangles(asymmetric),{stepover:8,safetyMargin:10,sampleStep:5});
    for(const path of result.paths) for(let i=1;i<path.points.length;i++) {
        const a=path.points[i-1],b=path.points[i];
        for(let j=0;j<=4;j++) {
            const p={x:a.x+(b.x-a.x)*j/4,y:a.y+(b.y-a.y)*j/4};
            assert.ok(contains(p,result.outline));
            assert.ok(distanceToOutline(p,result.outline)>=10-1e-4);
        }
    }
});

test('blunt ends converge without duplicate points or abrupt lateral tip segments', () => {
    const result=generateBoardPaths(triangles(rectangle),{stepover:5,safetyMargin:10,sampleStep:1});
    const outer=result.paths.at(-1).points;
    close(outer[0].x,0);close(outer.at(-1).x,0);
    for(let i=1;i<outer.length;i++) {
        assert.ok(Math.hypot(outer[i].x-outer[i-1].x,outer[i].y-outer[i-1].y)>0);
        assert.ok(Math.abs(outer[i].x-outer[i-1].x)<4);
    }
});

test('rejects disconnected fixtures, holes, invalid inputs, and collapsed insets', () => {
    const fixture=rectangle.map(p=>({x:p.x+200,y:p.y}));
    assert.throws(()=>projectBoardOutline([...triangles(rectangle),...triangles(fixture)]),/one connected/);
    // Four rectangles form a connected ring with a projected hole.
    const rect=(x0,y0,x1,y1)=>triangles([{x:x0,y:y0},{x:x1,y:y0},{x:x1,y:y1},{x:x0,y:y1}]);
    assert.throws(()=>projectBoardOutline([...rect(0,0,100,20),...rect(0,80,100,100),...rect(0,20,20,80),...rect(80,20,100,80)]),/without holes/);
    const uShape=[...rect(0,0,100,20),...rect(0,20,20,100),...rect(80,20,100,100)];
    assert.throws(()=>generateBoardPaths(uShape,{safetyMargin:0}),/Y-monotone/);
    assert.throws(()=>generateBoardPaths(triangles(rectangle),{safetyMargin:40}),/inset/);
    assert.throws(()=>generateBoardPaths(triangles(rectangle),{stepover:0}),/positive stepover/);
    assert.throws(()=>projectBoardOutline([0,1,2]),/triangle/);
});

// Execute real OpContour.prepare() with polygon/output doubles to verify the
// opt-in ordering fix. The default branch still calls tip2tipEmit().
const opSource=fs.readFileSync(new URL('../src/kiri/mode/cam/work/op-contour.js',import.meta.url),'utf8');
function prepareHarness(flag) {
    const emitted=[], layers=[];
    let greedyCalls=0;
    const context=vm.createContext({CamOp:class {constructor(state,op){this.state=state;this.op=op;}},
        newPoint:(x,y,z)=>({x,y,z}),
        tip2tipEmit(data,start,emit){greedyCalls++;for(const entry of [...data].reverse())emit(entry,entry.last);}
    });
    vm.runInContext(opSource.replace(/^import .*;\s*$/gm,'').replace('export { OpContour };','globalThis.OpContour=OpContour;')+
        '\nArray.prototype.appendAll=function(items){this.push(...items);};',context);
    const op=new context.OpContour({settings:{process:{}},widget:{getBoundingBox:()=>({min:{x:0,y:0}})}},
        {tool:1,rate:100,curvedPathPrototype:flag});
    op.toolStep=5;op.tolerance=1;op.topo={};
    const poly=(id,first,last)=>({id,first:()=>first,last:()=>last,clone(){return poly(id,first,last);},annotate(){return this;},reverse(){[first,last]=[last,first];}});
    op.sliceOut=[{index:0,camLines:[poly('centre',0,10)]},{index:1,camLines:[poly('left-segment-1',10,7),poly('left-segment-2',5,0)]},
        {index:2,camLines:[poly('right',0,10)]}];
    op.prepare({widget:op.state.widget,zmax:20,setTool(){},setContouring(){},setTolerance(){},polyEmit(p){emitted.push({id:p.id,first:p.first(),last:p.last()});},newLayer(){layers.push(1);}},()=>{});
    return {emitted,layers,greedyCalls};
}

test('prototype prepare preserves pass order, directions, and clipped segment order',()=>{
    const result=prepareHarness(true);
    assert.deepEqual(result.emitted,[{id:'centre',first:0,last:10},{id:'left-segment-1',first:10,last:7},
        {id:'left-segment-2',first:5,last:0},{id:'right',first:0,last:10}]);
    assert.equal(result.greedyCalls,0);assert.equal(result.layers.length,4);
});

test('normal prepare retains endpoint ordering and reversal',()=>{
    const result=prepareHarness(false);
    assert.equal(result.greedyCalls,1);
    assert.equal(result.emitted[0].id,'right');
    assert.equal(result.emitted[0].first,10);
});

test('nearly level asymmetric rail vertices do not produce phantom cross-section intersections', () => {
    const outline=[{x:0,y:0},{x:80,y:50.00002},{x:100,y:80},{x:0,y:120},
        {x:-100,y:80},{x:-80,y:50}];
    const mesh=[];
    for(let i=0;i<outline.length;i++) {
        const a=outline[i],b=outline[(i+1)%outline.length];
        mesh.push(0,60,1,a.x,a.y,1,b.x,b.y,1);
    }
    const result=generateBoardPaths(mesh,{stepover:5,safetyMargin:0,sampleStep:2});
    assert.equal(result.paths.length,41);
    assert.ok(result.paths.every(path=>path.points.length>2));
    assert.ok(result.paths.flatMap(p=>p.points).every(p=>Number.isFinite(p.x)&&Number.isFinite(p.y)));
});

test('batched dense triangle union preserves the outline, inset, and path layout', () => {
    const mesh=triangles(asymmetric);
    const dense=Array.from({length:300},()=>mesh).flat(); // 1,200 overlapping triangles
    const options={stepover:8,safetyMargin:10,sampleStep:2};
    const direct=generateBoardPaths(mesh,options),batched=generateBoardPaths(dense,options);
    const vertexSet=points=>points.map(p=>`${p.x},${p.y}`).sort();
    assert.deepEqual(vertexSet(batched.outline),vertexSet(direct.outline));
    assert.deepEqual(vertexSet(batched.inset),vertexSet(direct.inset));
    assert.equal(batched.paths.length,direct.paths.length);
    assert.deepEqual(batched.paths,direct.paths);
});

function roundedRailMesh() {
    const ys=[-120,-60,0,60,120],rings=ys.map(y=>Array.from({length:32},(_,i)=>{
        const angle=i*Math.PI*2/32;
        return {x:40*(1-y*y/100000)*Math.cos(angle),y,z:30+y*y/10000+20*Math.sin(angle)};
    }));
    const mesh=[];
    const add=(...points)=>{for(const p of points)mesh.push(p.x,p.y,p.z);};
    for(let j=1;j<rings.length;j++)for(let i=0;i<32;i++) {
        const next=(i+1)%32,a=rings[j-1][i],b=rings[j-1][next],c=rings[j][i],d=rings[j][next];
        add(a,b,c);add(b,d,c);
    }
    return mesh;
}

test('rail-apex mode derives widest 3D contact points and offsets the cutter centre outside the rail',()=>{
    const result=generateBoardPaths(roundedRailMesh(),{stepover:10,safetyMargin:10,sampleStep:2,
        railApex:true,toolRadius:4,edgeHeight:2});
    const mid=result.apexSections.find(section=>Math.abs(section.y)<1e-6);
    assert.ok(mid);close(mid.left.x,-40);close(mid.right.x,40);close(mid.right.z,30);
    close(mid.right.normal.x,1);close(mid.right.normal.y,0);
    const right=result.paths.find(p=>p.side==='right' && p.fraction===1).points.find(p=>Math.abs(p.y)<1e-6);
    const left=result.paths.find(p=>p.side==='left' && p.fraction===1).points.find(p=>Math.abs(p.y)<1e-6);
    close(right.x,44);close(left.x,-44);close(right.minZ,28);close(left.minZ,28);
    assert.equal(result.sidePasses,5);
    assert.ok(contains(right,result.clipOutline));
    assert.ok(!contains(right,result.outline));
    assert.ok(result.paths[0].points[0].y>-120 && result.paths[0].points.at(-1).y<120);
});

test('rail-apex mode preserves alternating order and a finite Z lower bound',()=>{
    const result=generateBoardPaths(roundedRailMesh(),{stepover:10,safetyMargin:10,sampleStep:2,
        railApex:true,toolRadius:4,edgeHeight:2});
    for(let i=0;i<result.paths.length;i++){
        const path=result.paths[i].points;
        assert.equal(path[0].y<path.at(-1).y,i%2===0);
        assert.ok(path.every(p=>Number.isFinite(p.minZ)));
    }
    assert.throws(()=>generateBoardPaths(roundedRailMesh(),{railApex:true}),/cutter radius/);
});
