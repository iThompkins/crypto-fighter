// Independent specification oracle: BigInt arithmetic, no production imports.
const U = 256n, W = 28n * U, H = 56n * U, STAGE = 720n * U, GROUND = 204n * U;
const clamp = (x, lo, hi) => x < lo ? lo : x > hi ? hi : x;
export function referenceStep(previous, a, b) {
  if (previous.roundOver) return structuredClone(previous);
  const fighters = [previous.p1, previous.p2].map(f => Object.fromEntries(Object.entries(f).map(([k,v]) => [k, BigInt(v)])));
  const masks = [BigInt(a), BigInt(b)];
  for (let i = 0; i < 2; i++) {
    const f = fighters[i], m = masks[i];
    f.attackActive = clamp(f.attackActive - 1n, 0n, 4n);
    f.attackCooldown = clamp(f.attackCooldown - 1n, 0n, 10n);
    const move = ((m & 2n ? 1n : 0n) - (m & 1n ? 1n : 0n)) * 5n * U;
    f.x = clamp(f.x + move, 0n, STAGE - W);
    if (move) f.facing = move > 0n ? 1n : -1n;
    if ((m & 8n) && f.y === GROUND) f.vy = -22n * U;
    f.vy += 2n * U;
    f.y += f.vy;
    if (f.y >= GROUND) { f.y = GROUND; f.vy = 0n; }
  }
  const [p, q] = fighters;
  if (p.y < q.y + H && q.y < p.y + H && p.x < q.x + W && q.x < p.x + W) {
    const left = p.x <= q.x ? p : q, right = left === p ? q : p;
    const sum = left.x + right.x + W;
    // Select the even candidate on exact half ties; not JS rounding.
    const low = sum / 2n, high = (sum + 1n) / 2n;
    const center = low === high || low % 2n === 0n ? low : high;
    left.x = clamp(center - W, 0n, STAGE - 2n * W);
    right.x = left.x + W;
  }
  for (let i = 0; i < 2; i++) {
    const f = fighters[i];
    if ((masks[i] & 4n) && f.attackActive === 0n && f.attackCooldown === 0n) {
      f.attackActive = 4n; f.attackCooldown = 10n;
    }
  }
  const hits = fighters.map((f, i) => {
    const target = fighters[1-i];
    const x = f.facing === 1n ? f.x + W : f.x - 40n * U;
    const y = f.y + 21n * U;
    return f.attackActive > 0n && x < target.x + W && x + 40n * U > target.x && y < target.y + H && y + 14n * U > target.y;
  });
  for (let i = 0; i < 2; i++) if (hits[1-i]) fighters[i].hp = clamp(fighters[i].hp - 1n, 0n, 7n);
  const frame = previous.frame + 1, timerFramesLeft = 300 - frame;
  const roundOver = p.hp === 0n || q.hp === 0n || timerFramesLeft === 0;
  const winner = !roundOver ? null : p.hp === q.hp ? 'TIE_BOTH_LOSE' : p.hp > q.hp ? 'P1' : 'P2';
  const convert = f => Object.fromEntries(Object.entries(f).map(([k,v]) => [k, Number(v)]));
  return { frame, timerFramesLeft, roundOver, winner, p1: convert(p), p2: convert(q) };
}

// Encode static ABI words independently of ethers' ABI coder and production codec.
export function referenceStateBytes(state, domainHash) {
  const outcome = {P1:1, P2:2, TIE_BOTH_LOSE:3};
  const fields = f => [f.x,f.y,f.vy,f.hp,f.facing,f.attackCooldown,f.attackActive];
  const words = [state.frame,state.timerFramesLeft,Number(state.roundOver),outcome[state.winner] ?? 0,...fields(state.p1),...fields(state.p2)];
  return domainHash + words.map(n => BigInt.asUintN(256,BigInt(n)).toString(16).padStart(64,'0')).join('');
}
