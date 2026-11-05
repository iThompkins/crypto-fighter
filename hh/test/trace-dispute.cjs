const assert = require('node:assert/strict');
const { ethers, network } = require('hardhat');
const abi = ethers.AbiCoder.defaultAbiCoder();
const tag = (s) => ethers.id(`CryptoFighter:fixed-point-trace-v2:${s}`);
const hash = (types, values) => ethers.keccak256(abi.encode(types, values));
const zero = ethers.ZeroHash;
const checkpoint = (stateHash) => ({ stateHash, frameHead: zero, p1Head: zero, p2Head: zero, p1PreviousHead: zero, p2PreviousHead: zero });
const cpHash = (c) => hash(Array(7).fill('bytes32'), [tag('checkpoint'), ...Object.values(c)]);
const state = (frame = 300) => ({ frame, timer: 300 - frame, terminal: true, outcome: 3, p1: [30720,52224,0,7,1,0,0], p2: [146432,52224,0,7,-1,0,0] });
function tree(context, checkpoints) {
  const leaves = Array.from({length:512}, (_, i) => i <= 300
    ? hash(['bytes32','bytes32','uint256','bytes32'], [tag('leaf'), context, i, cpHash(checkpoints[i])])
    : hash(['bytes32','bytes32','uint256'], [tag('padding'), context, i]));
  const levels = [leaves];
  while (levels.at(-1).length > 1) {
    const prev = levels.at(-1), next = [];
    for (let i = 0; i < prev.length; i += 2) next.push(hash(Array(3).fill('bytes32'), [tag('node'), prev[i], prev[i+1]]));
    levels.push(next);
  }
  return { root: levels.at(-1)[0], checkpoints, open(i) {
    let cursor = i;
    const siblings = [];
    for (let d = 0; d < 9; d++) { siblings.push(levels[d][cursor ^ 1]); cursor >>= 1; }
    return { checkpoint: checkpoints[i], siblings };
  }};
}
async function reject(p, reason) {
  await assert.rejects(p, (e) => { assert.equal(new ethers.Interface(['error Error(string)']).parseError(e.data).args[0], reason); return true; });
}
async function fixture(divergence = 151) {
  const [p1,p2,other] = await ethers.getSigners();
  const arena = await (await ethers.getContractFactory('CryptoFighterArena')).deploy();
  const sessions = [ethers.Wallet.createRandom(), ethers.Wallet.createRandom()];
  const genesis = ethers.randomBytes(32);
  await arena.challenge(genesis, await arena.CANONICAL_RULES_HASH(), sessions[0].address, p2.address, 86400, {value:1});
  await arena.connect(p2).join(1, sessions[1].address, {value:1});
  await arena.authorizeGenesis(1, sessions[0].signingKey.sign(await arena.genesisAuthorizationDigest(1,1)).serialized, sessions[1].signingKey.sign(await arena.genesisAuthorizationDigest(1,2)).serialized);
  const context = (await arena.getChallenge(1)).matchContextHash;
  const start = {...state(0), terminal:false, outcome:0};
  const a = Array.from({length:301}, (_,i) => checkpoint(ethers.id(`state-${i}`)));
  a[0] = checkpoint(await arena.hashTraceState(start));
  a[300] = checkpoint(await arena.hashTraceState(state()));
  const b = a.map((c,i) => i < divergence ? {...c} : {...c, stateHash:ethers.id(`other-${i}`)});
  return {arena,p1,p2,other,sessions,context,a:tree(context,a),b:tree(context,b)};
}
async function claim(m) { await m.arena.claimTrace(1,m.a.root,m.a.open(0),m.a.open(300),state()); }
async function challenge(m) { await m.arena.connect(m.p2).challengeTrace(1,m.b.root,m.b.open(0),m.b.open(300)); }

describe('On-chain authenticated trace bisection', function () {
  it('preserves equal(low), unequal(high) through both response orders and isolates one transition', async function () {
    for (const divergence of [1,151,300]) {
      const m = await fixture(divergence);
      await claim(m); await challenge(m);
      let g = await m.arena.getTraceGame(1);
      while (g.phase === 2n) {
        const mid = Number((g.low + g.high)/2n), deadline = g.deadline;
        const sides = g.round % 2n ? [[m.p2,m.b],[m.p1,m.a]] : [[m.p1,m.a],[m.p2,m.b]];
        await m.arena.connect(sides[0][0]).revealMidpoint(1,g.round,sides[0][1].open(mid));
        const pending = await m.arena.getTraceGame(1);
        assert.equal(pending.deadline,deadline); assert.equal(pending.low,g.low); assert.equal(pending.high,g.high);
        await m.arena.connect(sides[1][0]).revealMidpoint(1,g.round,sides[1][1].open(mid));
        g = await m.arena.getTraceGame(1);
        assert.equal(g.agreed,cpHash(m.a.checkpoints[Number(g.low)]));
        assert.equal(g.agreed,cpHash(m.b.checkpoints[Number(g.low)]));
        assert.equal(g.claimantUpper,cpHash(m.a.checkpoints[Number(g.high)]));
        assert.equal(g.challengerUpper,cpHash(m.b.checkpoints[Number(g.high)]));
        assert.notEqual(g.claimantUpper,g.challengerUpper);
      }
      assert.equal(g.low,BigInt(divergence-1)); assert.equal(g.high,BigInt(divergence)); assert.ok(g.round <= 9n);
      await reject(m.arena.revealMidpoint(1,g.round,m.a.open(divergence)), 'not bisecting');
      assert.equal(await ethers.provider.getBalance(await m.arena.getAddress()),2n);
    }
  });
  it('rejects invalid endpoints, metadata, outsider and duplicate claims', async function () {
    const m = await fixture();
    await reject(m.arena.connect(m.other).claimTrace(1,m.a.root,m.a.open(0),m.a.open(300),state()),'not participant');
    await reject(m.arena.claimTrace(1,m.a.root,m.a.open(1),m.a.open(300),state()),'invalid trace opening');
    await reject(m.arena.claimTrace(1,m.a.root,m.a.open(0),m.a.open(300),{...state(),outcome:1}),'terminal state mismatch');
    await claim(m);
    await reject(m.arena.claimTrace(1,m.a.root,m.a.open(0),m.a.open(300),state()),'trace already claimed');
    await reject(m.arena.challengeTrace(1,m.b.root,m.b.open(0),m.b.open(300)),'only trace opponent');
    await reject(m.arena.connect(m.p2).challengeTrace(1,m.a.root,m.a.open(0),m.a.open(300)),'trace endpoints equal');
    const wrong = tree(ethers.id('other context'),m.b.checkpoints);
    await reject(m.arena.connect(m.p2).challengeTrace(1,wrong.root,wrong.open(0),wrong.open(300)),'invalid trace opening');
    await challenge(m);
    await reject(m.arena.connect(m.p2).challengeTrace(1,m.b.root,m.b.open(0),m.b.open(300)),'trace not challengeable');
  });
  it('rejects invalid, duplicate, stale-round and outsider responses without extending the clock', async function () {
    const m = await fixture(); await claim(m); await challenge(m);
    const before = await m.arena.getTraceGame(1);
    await reject(m.arena.connect(m.other).revealMidpoint(1,0,m.a.open(150)),'not trace participant');
    await reject(m.arena.revealMidpoint(1,0,m.a.open(149)),'invalid trace opening');
    await reject(m.arena.revealMidpoint(1,1,m.a.open(150)),'wrong trace round');
    assert.deepEqual(await m.arena.getTraceGame(1),before);
    await m.arena.revealMidpoint(1,0,m.a.open(150));
    await reject(m.arena.revealMidpoint(1,0,m.a.open(150)),'already revealed');
    await m.arena.connect(m.p2).revealMidpoint(1,0,m.b.open(150));
    await reject(m.arena.revealMidpoint(1,0,m.a.open(150)),'wrong trace round');
  });
  it('accepts challenge and response at inclusive deadlines and rejects late responses', async function () {
    const m = await fixture(); await claim(m);
    await network.provider.send('evm_setNextBlockTimestamp',[Number((await m.arena.getTraceGame(1)).deadline)]);
    await challenge(m);
    const deadline = (await m.arena.getTraceGame(1)).deadline;
    await network.provider.send('evm_setNextBlockTimestamp',[Number(deadline)]);
    await m.arena.revealMidpoint(1,0,m.a.open(150));
    await reject(m.arena.connect(m.p2).revealMidpoint(1,0,m.b.open(150)),'trace deadline passed');
    assert.equal((await m.arena.getTraceGame(1)).deadline,deadline);
  });
});
module.exports = { fixture, claim, challenge, tree, cpHash, checkpoint, state, reject };
