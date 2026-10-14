import test from 'node:test';
import assert from 'node:assert/strict';
import { refineScallopPaths, DEFAULT_SCALLOP_HEIGHT } from '../src/kiri/mode/cam/core/scallop-path.js';
import { Tool } from '../src/kiri/mode/cam/core/tool.js';

function paths(width=40,axis='Y') {
    const point=(x,y)=>axis==='Y'?{x,y,minZ:0}:{x:y,y:-x,minZ:0};
    return {lengthAxis:axis,paths:[
        {side:'centre',fraction:0,points:[point(0,0),point(0,10)]},
        {side:'left',fraction:.5,points:[point(-width/2,10),point(-width/2,0)]},
        {side:'right',fraction:.5,points:[point(width/2,0),point(width/2,10)]},
        {side:'left',fraction:1,points:[point(-width,10),point(-width,0)]},
        {side:'right',fraction:1,points:[point(width,0),point(width,10)]}]};
}
const ball=d=>10-Math.sqrt(Math.max(0,100-d*d));
const flat={radius:10,resolution:.1,heightAt:ball,toolAt:()=>0,surfaceAt:(x,y)=>Math.abs(x)<=40?0:undefined};

test('numerical scallop refinement agrees with spherical cutter flat-plane cusp and retains order',async()=>{
    const generated=await refineScallopPaths(paths(),{...flat,target:.05});
    assert.ok(generated.paths.length>5);
    assert.ok(generated.scallop.worstSampledAdditionalCusp<=.05);
    const left=generated.paths.filter(p=>p.side==='left');
    let previous=0;
    for(const p of left) {
        const gap=(p.fraction-previous)*40;
        assert.ok(ball(gap/2)<=.05+1e-8);
        previous=p.fraction;
    }
    assert.equal(previous,1);
    generated.paths.forEach((p,i)=>{
        if(i) assert.equal(p.side,i%2?'left':'right');
        assert.equal(p.points[0].y,i%2?10:0);
    });
});

test('smaller target adds passes; X-long geometry produces equivalent fractions',async()=>{
    const loose=await refineScallopPaths(paths(),{...flat,target:.1});
    const tight=await refineScallopPaths(paths(),{...flat,target:.02});
    assert.ok(tight.paths.length>loose.paths.length);
    const x=await refineScallopPaths(paths(40,'X'),{...flat,target:.1,surfaceAt:(x,y)=>Math.abs(y)<=40?0:undefined});
    assert.deepEqual(x.paths.map(p=>p.fraction),loose.paths.map(p=>p.fraction));
});

test('bullnose swept profile concentrates passes near curved steep rails',async()=>{
    const tool=new Tool({controller:{units:'mm'},tools:[{id:1,type:'bullnose',metric:true,
        flute_diam:32.16,flute_len:71.83,shaft_diam:6.35,shaft_len:30,corner_radius:9.93,bottom_radius:191.69}]},1);
    const surface=x=>Math.abs(x)<=40?30-.01*x*x:undefined;
    const samples=Array.from({length:801},(_,i)=>-40+i*.1);
    const toolAt=x=>Math.max(0,...samples.filter(q=>Math.abs(q-x)<=16.08).map(q=>surface(q)-tool.bullNoseHeight(Math.abs(q-x))));
    const result=await refineScallopPaths(paths(),{target:.05,radius:16.08,resolution:.2,
        heightAt:d=>tool.bullNoseHeight(d),toolAt,surfaceAt:(x,y)=>surface(x)});
    const fractions=result.paths.filter(p=>p.side==='right').map(p=>p.fraction);
    let previous=0;const gaps=fractions.map(f=>{const gap={mid:(f+previous)/2,width:f-previous};previous=f;return gap;});
    const middle=gaps.filter(g=>g.mid<.25),rail=gaps.filter(g=>g.mid>.75);
    const average=a=>a.reduce((s,g)=>s+g.width,0)/a.length;
    assert.ok(average(rail)<average(middle),JSON.stringify(gaps));
    assert.ok(result.scallop.worstSampledAdditionalCusp<=.05);
});

test('invalid targets and impossible pass budgets fail clearly and refinement yields',async()=>{
    await assert.rejects(refineScallopPaths(paths(),{...flat,target:0}),/invalid/);
    await assert.rejects(refineScallopPaths(paths(),{...flat,target:.001,maxPasses:7}),/pass limit/);
    let yields=0;
    await refineScallopPaths(paths(),{...flat,target:.02,yieldProgress:async()=>{yields++;}});
    assert.ok(yields>0);
});

test('reference pass calibration derives a reusable height rather than fixing other boards to that count',async()=>{
    const seed=()=>{const p=paths();p.paths=p.paths.filter(p=>p.fraction===0||p.fraction===1);return p;};
    const calibrated=await refineScallopPaths(seed(),{...flat,target:.05,calibratePasses:21});
    assert.equal(calibrated.paths.length,21);
    assert.equal(calibrated.scallop.target,calibrated.scallop.worstSampledAdditionalCusp);
    assert.ok(calibrated.scallop.target>0);
    const reference=await refineScallopPaths(seed(),{...flat,target:calibrated.scallop.target});
    // A height threshold can accept equal-height gaps together; counts
    // are approximate when the reference has a plateau.
    assert.ok(reference.paths.length>=17 && reference.paths.length<=21);
    assert.ok(reference.scallop.worstSampledAdditionalCusp<=calibrated.scallop.target);
    const larger=paths(80);larger.paths=larger.paths.filter(p=>p.fraction===0||p.fraction===1);
    await refineScallopPaths(larger,{...flat,target:calibrated.scallop.target,surfaceAt:(x,y)=>Math.abs(x)<=80?0:undefined});
    assert.ok(larger.paths.length>reference.paths.length);
    assert.equal(larger.scallop.target,calibrated.scallop.target);
});

test('reference calibration validates counts and never changes compensated depth floor',async()=>{
    const seed=paths();seed.paths=seed.paths.filter(p=>p.fraction===0||p.fraction===1);
    await assert.rejects(refineScallopPaths(seed,{...flat,calibratePasses:2}),/reference/);
    await refineScallopPaths(seed,{...flat,calibratePasses:11});
    assert.ok(seed.paths.every(p=>p.points.every(q=>q.minZ===0)));
});


test('general 1 mm target adds bottom cuts compared with the previous reference height',async()=>{
    assert.deepEqual(DEFAULT_SCALLOP_HEIGHT,{deck:1,bottom:1});
    const seed=()=>{const p=paths();p.paths=p.paths.filter(q=>q.fraction===0||q.fraction===1);return p;};
    const previous=await refineScallopPaths(seed(),{...flat,target:1.5988517037160932});
    const general=await refineScallopPaths(seed(),{...flat,target:DEFAULT_SCALLOP_HEIGHT.bottom});
    assert.ok(general.paths.length>previous.paths.length);
    assert.ok(general.scallop.worstSampledAdditionalCusp<=1);
    assert.ok(general.paths.every(p=>p.points.every(q=>q.minZ===0)));
});
