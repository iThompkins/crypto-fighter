const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const solc = require('solc');
const { ethers } = require('hardhat');
const vectors = JSON.parse(fs.readFileSync(path.join(__dirname,'../../test/fixtures/fixed-point-v2.json'),'utf8'));
const asState = s => ({frame:s.frame,timer:s.timerFramesLeft,terminal:s.roundOver,outcome:{P1:1,P2:2,TIE_BOTH_LOSE:3}[s.winner] ?? 0,p1:s.p1,p2:s.p2});
const fromState = s => ({
  frame:Number(s.frame), timerFramesLeft:Number(s.timer), roundOver:s.terminal,
  winner:{1n:'P1',2n:'P2',3n:'TIE_BOTH_LOSE'}[s.outcome] ?? null,
  p1:Object.fromEntries(['x','y','vy','hp','facing','attackCooldown','attackActive'].map(k=>[k,Number(s.p1[k])])),
  p2:Object.fromEntries(['x','y','vy','hp','facing','attackCooldown','attackActive'].map(k=>[k,Number(s.p2[k])])),
});
let referenceStep;
before(async function () {
  ({referenceStep}=await import(pathToFileURL(path.join(__dirname,'../../test/fixtures/fixed-point-reference.mjs')).href));
});

describe('Phase A fixed-point codec and arithmetic parity (no adjudication)', function () {
  it('hashes independent state vectors exactly, including negative velocity and terminal states', async function () {
    const arena=await (await ethers.getContractFactory('CryptoFighterArena')).deploy();
    for(const v of vectors.states) assert.equal(await arena.hashTraceState(asState(v.after)),v.hash,v.name);
  });
  it('matches the specified nearest-even division with integer Solidity arithmetic', async function () {
    // Test-only harness compiled in memory, not linked into escrow or a verifier.
    const source='// SPDX-License-Identifier: MIT\npragma solidity ^0.8.24; contract RoundingHarness { function midpoint(uint256[] calldata ns) external pure returns (uint256[] memory out) { out=new uint256[](ns.length); for(uint256 i=0;i<ns.length;i++){ require(ns[i]<=368640); uint256 q=ns[i]/2; out[i]=q+(ns[i]%2)*(q%2); } } }';
    const compiled=JSON.parse(solc.compile(JSON.stringify({language:'Solidity',sources:{'RoundingHarness.sol':{content:source}},settings:{outputSelection:{'*':{'*':['abi','evm.bytecode.object']}}}})));
    assert.equal(compiled.errors?.some(e=>e.severity==='error') ?? false,false);
    const artifact=compiled.contracts['RoundingHarness.sol'].RoundingHarness;
    const [signer]=await ethers.getSigners();
    const harness=await new ethers.ContractFactory(artifact.abi,artifact.evm.bytecode.object,signer).deploy();
    const nums=vectors.midpoints.map(v=>v.numerator);
    assert.deepEqual(Array.from(await harness.midpoint(nums)),vectors.midpoints.map(v=>BigInt(v.expected)));
    const reflected=nums.map(n=>368640-n);
    assert.deepEqual(Array.from(await harness.midpoint(reflected)),vectors.midpoints.map(v=>184320n-BigInt(v.expected)));
  });
  it('executes the canonical transition vectors independently in Solidity', async function () {
    const verifier=await (await ethers.getContractFactory('GameTransitionVerifier')).deploy();
    for(const v of vectors.states) {
      const actual=await verifier.executeTransition(asState(v.before),v.inputs[0],v.inputs[1]);
      assert.deepEqual(fromState(actual),v.after,v.name);
    }
  });
  it('matches the independent oracle for every input pair across boundary states', async function () {
    const verifier=await (await ethers.getContractFactory('GameTransitionVerifier')).deploy();
    const states=vectors.states.map(v=>v.before).filter(s=>!s.roundOver).slice(0,4);
    for(const state of states) {
      const cases=[];
      for(let a=0;a<16;a++) for(let b=0;b<16;b++) cases.push([a,b]);
      const actual=await Promise.all(cases.map(([a,b])=>verifier.executeTransition(asState(state),a,b)));
      actual.forEach((result,index)=>assert.deepEqual(fromState(result),referenceStep(state,...cases[index])));
    }
  });
});
