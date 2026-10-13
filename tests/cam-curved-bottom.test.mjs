import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { createBottomContours } from '../src/kiri/mode/cam/core/curved-bottom.js';

const deck = {type:'contour',axis:'X',tool:7,curvedPathPrototype:true,
    curvedPathRailApex:true,curvedPathOutline:true,curvedPathStepover:12.8,leave:.1};

test('empty side B copies deck settings, disables perimeter and isolates records',()=>{
    const bottom=createBottomContours([deck],[],'X');
    assert.equal(bottom.length,1);
    assert.equal(bottom[0].curvedPathSide,'bottom');
    assert.equal(bottom[0].curvedPathOutline,false);
    for(const key of ['tool','leave','curvedPathStepover','curvedPathRailApex']) assert.equal(bottom[0][key],deck[key]);
    bottom[0].leave=5;
    assert.equal(deck.leave,.1);
    assert.equal(deck.curvedPathOutline,true);
});

test('existing setups, other axes, disabled and parked operations are untouched',()=>{
    assert.deepEqual(createBottomContours([deck],[{type:'contour'}],'X'),[]);
    assert.deepEqual(createBottomContours([deck],[],'Y'),[]);
    assert.deepEqual(createBottomContours([{...deck,curvedPathPrototype:false}],[],'X'),[]);
    assert.deepEqual(createBottomContours([{...deck,disabled:true}],[],'X'),[]);
    assert.deepEqual(createBottomContours([{type:'|'},deck],[],'X'),[]);
    assert.deepEqual(createBottomContours([{...deck,curvedPathSide:'bottom'}],[],'X'),[]);
    assert.equal(createBottomContours([deck],[{type:'flip'}],'X').length,1);
});

function flipHarness(ops,op2) {
    const process={ops,op2,camZAnchor:'top'};
    const env={current:{process},poppedRec:{type:'flip',axis:'X'}};
    const rotations=[];let saves=0,clears=0;
    const context=vm.createContext({createBottomContours,env,
        api:{view:{set_arrange(){}},widgets:{all:()=>[]},
            selection:{rotate(...angles){rotations.push(angles);}},client:{clear(){clears++;}},
            conf:{save(){saves++;}}},CAM:{traces_clear(){}},
        opAdd(rec){process.ops.push({...rec});saves++;},opRender(){}});
    const source=fs.readFileSync(new URL('../src/kiri/mode/cam/app/cl-flip.js',import.meta.url),'utf8');
    vm.runInContext(source.replace(/^import .*;\s*$/gm,'').replace(/\bexport /g,'')+';globalThis.flip=opFlip;',context);
    return {process,env,context,rotations,inspect:()=>({saves,clears})};
}

test('real Flip action creates side B, rotates around X and restores deck without duplication',()=>{
    const a=[deck,{type:'flip',axis:'X'}],h=flipHarness(a,[]);
    h.context.flip();
    assert.equal(h.process.ops[0].curvedPathSide,'bottom');
    assert.equal(h.process.ops.at(-1).type,'flip');
    assert.equal(h.process.op2,a);
    assert.equal(h.process.camZAnchor,'bottom');
    assert.deepEqual(h.rotations[0],[Math.PI,0,0]);
    h.env.poppedRec=h.process.ops.at(-1);
    h.context.flip();
    assert.equal(h.process.ops,a);
    assert.equal(h.process.op2.length,2);
    assert.equal(h.process.camZAnchor,'top');
    assert.equal(h.inspect().clears,2);
});

test('return-flip-only side B seeds once and saves setup; normal flip stays legacy',()=>{
    const h=flipHarness([deck],[{type:'flip',axis:'Y'}]);
    h.context.flip();
    assert.equal(h.process.ops.length,2);
    assert.equal(h.process.ops.at(-1).axis,'X');
    assert.equal(h.inspect().saves,1);
    const normal=flipHarness([{type:'contour'}],[]);
    normal.context.flip();
    assert.equal(normal.process.ops.length,1);
    assert.equal(normal.process.ops[0].type,'flip');
});
