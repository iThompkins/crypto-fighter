const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { execFileSync } = require('node:child_process');
const { mkdtempSync, readFileSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { ethers } = require('hardhat');

const abi = ethers.AbiCoder.defaultAbiCoder();
const tag = s => ethers.id(`CryptoFighter:fixed-point-trace-v2:${s}`);
const hash = (types, values) => ethers.keccak256(abi.encode(types, values));
const cpHash = c => hash(Array(7).fill('bytes32'), [tag('checkpoint'), c.stateHash, c.frameHead, c.p1Head, c.p2Head, c.p1PreviousHead, c.p2PreviousHead]);
const asState = s => ({ frame:s.frame, timer:s.timerFramesLeft, terminal:s.roundOver,
  outcome:{P1:1,P2:2,TIE_BOTH_LOSE:3}[s.winner] ?? 0, p1:s.p1, p2:s.p2 });
const packet = p => ({ matchId:p.matchId, frame:p.frame, player:p.player, inputMask:p.inputMask,
  prevSelfHash:p.prevSelfHash, prevOppHash:p.prevOppHash, signature:p.signature });
const opening = o => ({ checkpoint:o.checkpoint, siblings:o.siblings });
const emptyPacket = () => ({ matchId:ethers.ZeroHash, frame:0, player:0, inputMask:0,
  prevSelfHash:ethers.ZeroHash, prevOppHash:ethers.ZeroHash, signature:'0x' });

function tree(context, checkpoints) {
  const leaves = Array.from({length:512}, (_, i) => i <= 300
    ? hash(['bytes32','bytes32','uint256','bytes32'], [tag('leaf'), context, i, cpHash(checkpoints[i])])
    : hash(['bytes32','bytes32','uint256'], [tag('padding'), context, i]));
  const levels = [leaves];
  while (levels.at(-1).length > 1) {
    const previous = levels.at(-1), next = [];
    for (let i=0; i<previous.length; i+=2) next.push(hash(Array(3).fill('bytes32'), [tag('node'), previous[i], previous[i+1]]));
    levels.push(next);
  }
  return { root:levels.at(-1)[0], checkpoints, open(index) {
    const siblings=[]; let cursor=index;
    for (let depth=0; depth<9; depth++) { siblings.push(levels[depth][cursor ^ 1]); cursor >>= 1; }
    return { checkpoint:checkpoints[index], siblings };
  }};
}

function corrupt(trace, frame, label) {
  return tree(trace.contextHash, trace.checkpoints.map((checkpoint, index) =>
    index < frame ? {...checkpoint} : {...checkpoint, frameHead:ethers.id(`${label}-${index}`)}));
}

async function reject(promise, reason) {
  await assert.rejects(promise, error => {
    const parsed = new ethers.Interface(['error Error(string)']).parseError(error.data);
    assert.equal(parsed.args[0], reason);
    return true;
  });
}

let modules, transcript;
before(async function () {
  await import(pathToFileURL(path.resolve(__dirname, '../../tools/register-types.mjs')).href);
  const file = path.join(mkdtempSync(path.join(tmpdir(), 'crypto-fighter-step-')), 'terminal.json');
  execFileSync(process.execPath, [path.resolve(__dirname, '../../tools/make-transcript.mjs'), file]);
  transcript = JSON.parse(readFileSync(file, 'utf8'));
  modules = {
    genesis: await import(pathToFileURL(path.resolve(__dirname, '../../src/genesis.ts')).href),
    live: await import(pathToFileURL(path.resolve(__dirname, '../../src/live-protocol.ts')).href),
    evidence: await import(pathToFileURL(path.resolve(__dirname, '../../src/evidence-trace.ts')).href),
  };
});

async function fixture() {
  const [p1,p2,relayer,outsider] = await ethers.getSigners();
  const s1 = new ethers.Wallet('0x' + '1'.padStart(64,'0'));
  const s2 = new ethers.Wallet('0x' + '2'.padStart(64,'0'));
  const arena = await (await ethers.getContractFactory('CryptoFighterArena')).deploy();
  await arena.connect(p1).challenge(transcript.matchId, await arena.CANONICAL_RULES_HASH(), s1.address, p2.address, 86400, {value:1});
  const joined = await (await arena.connect(p2).join(1, s2.address, {value:1})).wait();
  const locator = {chainId:'31337', arena:await arena.getAddress(), challengeId:'1'};
  let record = await modules.genesis.readGenesisRecord(ethers.provider, locator, joined.blockNumber);
  const authorization = { binding:record.binding,
    p1Signature:s1.signingKey.sign(modules.genesis.genesisAuthorizationDigest(record.binding,1)).serialized,
    p2Signature:s2.signingKey.sign(modules.genesis.genesisAuthorizationDigest(record.binding,2)).serialized };
  const activated = await (await arena.connect(relayer).authorizeGenesis(1,authorization.p1Signature,authorization.p2Signature)).wait();
  record = await modules.genesis.readGenesisRecord(ethers.provider, locator, activated.blockNumber);
  const config = {version:1,mode:'escrow',matchId:transcript.matchId,rulesHash:record.binding.rulesHash,
    p1PublicKey:s1.signingKey.publicKey,p2PublicKey:s2.signingKey.publicKey,authorization};
  const context = modules.live.configHash(config);
  const readiness=[s1,s2].map((key,index)=>({type:'READY',context,slot:index+1,
    signature:key.signingKey.sign(modules.live.lifecycleDigest(context,index+1,'READY')).serialized}));
  const archive={format:'phase-b-journal-v1',journal:[{kind:'genesis',config,localSlot:1,record},
    ...readiness.map(message=>({kind:'message',message})),
    ...transcript.packets.map(value=>({kind:'message',message:{type:'INPUT',context,packet:value}}))]};
  const bundle=await modules.evidence.buildEvidenceBundle(archive,record);
  const defense=await modules.evidence.loadEvidenceDefense(bundle,record);
  const correct=tree(bundle.trace.contextHash,bundle.trace.checkpoints.map(value=>({...value})));
  return {arena,p1,p2,outsider,s1,s2,bundle,defense,correct};
}

async function isolate(m, claimant, challenger, frame) {
  const terminal=asState(m.bundle.reconstruction.states.at(-1));
  await m.arena.connect(m.p1).claimTrace(1,claimant.root,opening(claimant.open(0)),opening(claimant.open(300)),terminal);
  await m.arena.connect(m.p2).challengeTrace(1,challenger.root,opening(challenger.open(0)),opening(challenger.open(300)));
  let game=await m.arena.getTraceGame(1);
  while(game.phase === 2n) {
    const mid=Number((game.low+game.high)/2n);
    await m.arena.connect(m.p1).revealMidpoint(1,game.round,opening(claimant.open(mid)));
    await m.arena.connect(m.p2).revealMidpoint(1,game.round,opening(challenger.open(mid)));
    game=await m.arena.getTraceGame(1);
  }
  assert.equal(game.low,BigInt(frame-1));
  assert.equal(game.high,BigInt(frame));
}

function witness(m, claimant, challenger, frame) {
  const step=m.defense.step(frame);
  const packets=step.kind === 'execution' ? [packet(step.p1),packet(step.p2)] : [emptyPacket(),emptyPacket()];
  const state=step.kind === 'execution' ? step.preState : step.terminalState;
  return [1,opening(claimant.open(frame-1)),asState(state),...packets,opening(claimant.open(frame)),opening(challenger.open(frame))];
}

describe('Solidity one-step execution adjudication', function () {
  it('consumes a Phase C witness and selects the canonical claimant transition', async function () {
    const m=await fixture(), frame=40, bad=corrupt(m.bundle.trace,frame,'bad-challenger');
    await isolate(m,m.correct,bad,frame);
    await m.arena.connect(m.p1).adjudicateStep(...witness(m,m.correct,bad,frame));
    const game=await m.arena.getTraceGame(1);
    assert.equal(game.phase,4n); assert.equal(game.verdict,1n);
    assert.equal(game.canonicalPost,cpHash(m.correct.checkpoints[frame]));
    assert.equal(await ethers.provider.getBalance(await m.arena.getAddress()),2n);
  });

  it('selects a correct challenger and can determine that neither execution claim is valid', async function () {
    for (const neither of [false,true]) {
      const m=await fixture(), frame=1;
      const claimant=corrupt(m.bundle.trace,frame,'bad-claimant');
      const challenger=neither ? corrupt(m.bundle.trace,frame,'bad-challenger') : m.correct;
      await isolate(m,claimant,challenger,frame);
      await m.arena.connect(m.p2).adjudicateStep(...witness(m,claimant,challenger,frame));
      assert.equal((await m.arena.getTraceGame(1)).verdict,neither ? 3n : 2n);
    }
  });

  it('verifies terminal absorption without fabricating post-terminal packets', async function () {
    const m=await fixture(), frame=m.bundle.trace.terminalFrame+1;
    const bad=corrupt(m.bundle.trace,frame,'bad-absorption');
    await isolate(m,m.correct,bad,frame);
    await m.arena.connect(m.p1).adjudicateStep(...witness(m,m.correct,bad,frame));
    const game=await m.arena.getTraceGame(1);
    assert.equal(game.verdict,1n);
    assert.equal(game.canonicalPost,cpHash(m.correct.checkpoints[frame-1]));
  });

  it('rejects malformed membership, context, frame, slot, chains and signatures before accepting once', async function () {
    const m=await fixture(), frame=40, bad=corrupt(m.bundle.trace,frame,'bad');
    await isolate(m,m.correct,bad,frame);
    const args=witness(m,m.correct,bad,frame);
    await reject(m.arena.connect(m.outsider).adjudicateStep(...args),'not trace participant');
    const malformed=structuredClone(args); malformed[1].siblings.pop();
    await reject(m.arena.connect(m.p1).adjudicateStep(...malformed),'invalid trace opening');
    const wrongState=structuredClone(args); wrongState[2].p1.x+=1;
    await reject(m.arena.connect(m.p1).adjudicateStep(...wrongState),'pre-state mismatch');
    const wrongPost=structuredClone(args); wrongPost[5].siblings[0]=ethers.ZeroHash;
    await reject(m.arena.connect(m.p1).adjudicateStep(...wrongPost),'invalid trace opening');
    for (const [index,field,value,reason] of [
      [3,'matchId',ethers.id('wrong-match'),'wrong match'],
      [3,'frame',frame+1,'wrong frame'],
      [3,'player',2,'wrong slots'],
      [3,'prevSelfHash',ethers.id('wrong-self'),'broken self chain'],
      [3,'prevOppHash',ethers.id('wrong-ack'),'broken acknowledgement chain'],
      [3,'signature','0x'+'00'.repeat(65),'bad recovery id'],
    ]) {
      const changed=structuredClone(args); changed[index][field]=value;
      await reject(m.arena.connect(m.p1).adjudicateStep(...changed),reason);
    }
    await m.arena.connect(m.p1).adjudicateStep(...args);
    await reject(m.arena.connect(m.p1).adjudicateStep(...args),'transition not isolated');
  });

  it('records signed invalid-input and equivocation faults separately without economic effects', async function () {
    const m=await fixture();
    const make=(mask,overrides={})=>{
      const value={matchId:transcript.matchId,frame:1,player:1,inputMask:mask,
        prevSelfHash:ethers.ZeroHash,prevOppHash:ethers.ZeroHash,...overrides};
      const digest=ethers.keccak256(abi.encode(['bytes32','uint256','uint256','uint256','bytes32','bytes32'],
        [value.matchId,value.frame,value.player,value.inputMask,value.prevSelfHash,value.prevOppHash]));
      return {...value,signature:m.s1.signingKey.sign(digest).serialized};
    };
    const invalid=make(16);
    const fault=await m.arena.proveInvalidInput.staticCall(1,invalid);
    await m.arena.proveInvalidInput(1,invalid);
    assert.equal(await m.arena.provenEvidenceFaults(fault),true);
    await reject(m.arena.proveInvalidInput(1,invalid),'fault already proven');
    const a=make(0), b=make(1);
    const equivocation=await m.arena.proveEquivocation.staticCall(1,a,b);
    await m.arena.proveEquivocation(1,a,b);
    assert.equal(await m.arena.provenEvidenceFaults(equivocation),true);
    await reject(m.arena.proveEquivocation(1,a,a),'duplicate packet');
    await reject(m.arena.proveEquivocation(1,a,{...b,matchId:ethers.id('wrong')}),'wrong match');
    assert.equal(await ethers.provider.getBalance(await m.arena.getAddress()),2n);
    assert.equal((await m.arena.getChallenge(1)).status,2n);
  });

  it('binds participant trace roots to retained journal hashes without claiming availability', async function () {
    const m=await fixture(), root=m.bundle.trace.root, journal=m.bundle.reconstruction.journalHash;
    await reject(m.arena.connect(m.outsider).publishTraceArchive(1,root,journal),'not participant');
    await m.arena.connect(m.p1).publishTraceArchive(1,root,journal);
    assert.equal(await m.arena.traceArchiveHashes(1,m.p1.address,root),journal);
    await m.arena.connect(m.p1).publishTraceArchive(1,root,journal);
    await reject(m.arena.connect(m.p1).publishTraceArchive(1,root,ethers.id('different-journal')),'archive commitment conflict');
    assert.equal(await ethers.provider.getBalance(await m.arena.getAddress()),2n);
  });
});
