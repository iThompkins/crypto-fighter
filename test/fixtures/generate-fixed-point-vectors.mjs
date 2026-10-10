// Explicit reviewed cases; regenerate with node test/fixtures/generate-fixed-point-vectors.mjs.
import { writeFile } from 'node:fs/promises';
import { id, keccak256 } from 'ethers';
import { referenceStep, referenceStateBytes } from './fixed-point-reference.mjs';
const genesis={frame:0,timerFramesLeft:300,roundOver:false,winner:null,p1:{x:30720,y:52224,vy:0,hp:7,facing:1,attackCooldown:0,attackActive:0},p2:{x:146432,y:52224,vy:0,hp:7,facing:-1,attackCooldown:0,attackActive:0}};
const positioned=(x1,x2)=>({...structuredClone(genesis),frame:1,timerFramesLeft:299,p1:{...genesis.p1,x:x1},p2:{...genesis.p2,x:x2}});
const timeout={...structuredClone(genesis),frame:299,timerFramesLeft:1};
const ko=positioned(30720,37888);ko.p1.hp=ko.p2.hp=1;
const air=positioned(30720,32000);air.p1.y=24064;
const cases=[
 ['idle genesis',genesis,[0,0]],['jump and move',genesis,[10,1]],
 ['odd midpoint rounds down to even',positioned(20000,21001),[0,0]],
 ['odd midpoint rounds up to even',positioned(20000,21003),[0,0]],
 ['left joint wall correction',positioned(0,1),[0,0]],
 ['right joint wall correction',positioned(177151,177152),[0,0]],
 ['equal position P1 left',positioned(50000,50000),[0,0]],
 ['vertical separation permits passing',air,[2,1]],
 ['simultaneous KO',ko,[4,4]],['timer tie',timeout,[0,0]],
 ['strict attack edge misses',positioned(30720,48128),[4,0]],
 ['one simulation unit inside attack hits',positioned(30720,48127),[4,0]],
];
const terminal=referenceStep(ko,4,4);cases.push(['terminal absorption',terminal,[15,15]]);
const states=cases.map(([name,before,inputs])=>{
 const after=referenceStep(before,...inputs),encoded=referenceStateBytes(after,id('CryptoFighter:fixed-point-trace-v2:state'));
 return {name,before,inputs,after,encoded,hash:keccak256(encoded)};
});
const midpointNumerators=[0,1,2,3,4,5,6,7,14335,14337,48169,48171,368637,368639,368640];
const midpoints=midpointNumerators.map(n=>{const low=BigInt(n)/2n,high=(BigInt(n)+1n)/2n;return {numerator:n,expected:Number(low%2n===0n?low:high)};});
await writeFile(new URL('./fixed-point-v2.json',import.meta.url),JSON.stringify({version:2,scale:256,midpoints,states},null,2)+'\n');
