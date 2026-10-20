import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { id, keccak256 } from 'ethers';
import { initialState, transition, assertValidState, SCALE, WIDTH, FIGHTER_W, roundHalfToEven } from '../src/game.ts';
import { encodeTraceState, hashTraceState, TRACE_DOMAIN } from '../src/protocol.ts';
import { referenceStep, referenceStateBytes } from './fixtures/fixed-point-reference.mjs';
import * as legacy from './fixtures/legacy-binary64.mjs';

const mirrorMask = m => (m & 12) | ((m & 1) << 1) | ((m & 2) >> 1);
const mirror = s => {
  const flip = f => ({...f, x: WIDTH-FIGHTER_W-f.x, facing: -f.facing});
  return {...s, p1:flip(s.p2), p2:flip(s.p1), winner:s.winner === 'P1' ? 'P2' : s.winner === 'P2' ? 'P1' : s.winner};
};
const scenario = (x1,x2, extra={}) => {
  const s=initialState(); s.frame=1; s.timerFramesLeft=299;
  s.p1.x=x1; s.p2.x=x2;
  Object.assign(s.p1,extra);
  return s;
};

test('ties-to-even midpoint is bounded and exactly reflection symmetric; floor is not', () => {
  let floorFailures=0;
  for(let n=0;n<=2*WIDTH;n++) {
    const r=roundHalfToEven(n);
    assert.ok(Math.abs(2*r-n)<=1);
    assert.equal(roundHalfToEven(2*WIDTH-n),WIDTH-r);
    if (n%2) assert.equal(r%2,0);
    if (Math.floor((2*WIDTH-n)/2)!==WIDTH-Math.floor(n/2)) floorFailures++;
  }
  assert.equal(floorFailures,WIDTH);
});

test('all 256 mask pairs match independent integer reference and mirrored collision scenarios', () => {
  const states=[initialState(), scenario(20000,21001), scenario(20000,21003),scenario(0,1),scenario(WIDTH-FIGHTER_W-1,WIDTH-FIGHTER_W),scenario(50000,50000),scenario(50000,56000,{y:94*SCALE,vy:0})];
  for (const s of states) for(let a=0;a<16;a++) for(let b=0;b<16;b++) {
    const next=transition(s,a,b);
    assert.deepEqual(next,referenceStep(s,a,b));
    assertValidState(next);
    assert.deepEqual(transition(mirror(s),mirrorMask(b),mirrorMask(a)),mirror(next));
  }
});

test('seeded complete matches and clamp-recollision cycles remain canonical and match BigInt', () => {
  let seed=0x12345678, steps=0;
  const rand=()=>{seed=(Math.imul(seed,1664525)+1013904223)>>>0;return seed>>>28;};
  for(let match=0;match<64;match++) {
    let s=initialState();
    while(!s.roundOver) {
      const a=rand(),b=rand(), next=transition(s,a,b);
      assert.deepEqual(next,referenceStep(s,a,b));
      assert.deepEqual(transition(mirror(s),mirrorMask(b),mirrorMask(a)),mirror(next));
      assertValidState(next);
      assert.equal(encodeTraceState(next),referenceStateBytes(next,id(`${TRACE_DOMAIN}:state`)));
      s=next;steps++;
    }
    assert.strictEqual(transition(s,15,15),s);
  }
  let s=initialState();
  for(let frame=1;frame<=300;frame++) {
    const masks=frame<=108?[1,1]:frame===109?[2,0]:frame%2===0?[1,0]:[2,0];
    const next=transition(s,...masks);
    assert.deepEqual(next,referenceStep(s,...masks));assertValidState(next);hashTraceState(next);s=next;
  }
  assert.ok(steps>10000);
});

test('canonical codec rejects noninteger, invalid and ambiguous states', () => {
  const valid=transition(initialState(),8,0);
  for(const mutate of [s=>s.p1.x=0.5,s=>s.p1.x=-0,s=>s.p1.x=NaN,s=>s.p1.x=Infinity,s=>s.p1.x=2**53,s=>s.p1.x=-1,s=>s.p1.y=0,s=>s.p1.vy=1,s=>s.p1.hp=8,s=>s.p1.facing=0,s=>s.p1.attackActive=5,s=>s.p1.attackCooldown=10,s=>s.timerFramesLeft=0,s=>s.roundOver=true,s=>s.winner='toString',s=>s.p1.w=28,s=>s.extra=0]) {
    const s=structuredClone(valid);mutate(s);assert.throws(()=>encodeTraceState(s));
  }
  for(const mask of [-1,16,1.5,NaN,Infinity]) assert.throws(()=>transition(initialState(),mask,0));
  assert.equal(hashTraceState({...valid,p1:Object.fromEntries(Object.entries(valid.p1).reverse())}),hashTraceState(valid));
});

test('reference vectors pin transition results and independent ABI bytes/hashes', async () => {
  const vectors=JSON.parse(await readFile(new URL('./fixtures/fixed-point-v2.json',import.meta.url),'utf8'));
  for(const v of vectors.states) {
    assert.deepEqual(transition(v.before,...v.inputs),v.after,v.name);
    assert.deepEqual(referenceStep(v.before,...v.inputs),v.after,v.name);
    assert.equal(encodeTraceState(v.after),v.encoded,v.name);
    assert.equal(referenceStateBytes(v.after,id(`${TRACE_DOMAIN}:state`)),v.encoded,v.name);
    assert.equal(keccak256(v.encoded),v.hash,v.name);
  }
});

function legacyComparable(s) {
  const f = ({w,h,...rest}) => { void w;void h;return {...rest,x:rest.x*SCALE,y:rest.y*SCALE,vy:rest.vy*SCALE}; };
  return {...s,p1:f(s.p1),p2:f(s.p2)};
}
test('unchanged movement, jump and attack scenarios match development gameplay exactly', () => {
  for(const policy of [()=>[0,0],()=>[2,1],f=>[f%25===1?8:0,0],f=>[f<80?2:4,f<80?1:4]]) {
    let s=initialState(),old=legacy.initialState();
    for(let f=1;f<=300&&!s.roundOver;f++) {
      const inputs=policy(f);s=transition(s,...inputs);old=legacy.transition(old,...inputs);
      assert.deepEqual(s,legacyComparable(old));
    }
  }
});

test('development comparison records boundary-sensitive gameplay differences without requiring replay compatibility', t => {
  let seed=0x12345678;
  const rand=()=>{seed=(Math.imul(seed,1664525)+1013904223)>>>0;return seed>>>28;};
  const changed=[];
  let commonActiveSteps=0,maxPositionError=0;
  for(let match=0;match<128;match++) {
    let current=initialState(),old=legacy.initialState();
    for(let frame=1;frame<=300;frame++) {
      const masks=match<64?[rand(),rand()]:frame<=108?[1,1]:frame===109?[2,0]:frame<=160?(frame%2===0?[1,0]:[2,0]):[rand(),rand()];
      const bothActive=!current.roundOver&&!old.roundOver;
      current=transition(current,...masks);old=legacy.transition(old,...masks);
      if(bothActive) {
        commonActiveSteps++;
        maxPositionError=Math.max(maxPositionError,Math.abs(current.p1.x/SCALE-old.p1.x),Math.abs(current.p2.x/SCALE-old.p2.x));
      }
      if(current.roundOver&&old.roundOver)break;
    }
    if(current.winner!==old.winner||current.frame!==old.frame)changed.push({match,current:[current.winner,current.frame],old:[old.winner,old.frame]});
  }
  // Fixed seeded characterization, not a universal error/outcome guarantee.
  assert.equal(commonActiveSteps,31907);
  assert.equal(maxPositionError,1/512);
  assert.deepEqual(changed,[
    {match:71,current:['P1',300],old:['P1',203]},
    {match:73,current:['P1',216],old:['P1',197]},
    {match:94,current:['P2',300],old:['P1',300]},
  ]);
  t.diagnostic(JSON.stringify({matches:128,commonActiveSteps,maxPositionError,changed}));
});
