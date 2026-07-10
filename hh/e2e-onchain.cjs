const { chromium } = require('/home/node/.openclaw/workspace/node_modules/playwright-chromium');
const { ethers } = require('/home/node/.openclaw/workspace/crypto-fighter/node_modules/ethers');

const APP = 'http://127.0.0.1:4173/';
const RPC = 'http://127.0.0.1:8545';
const ARENA = process.env.ARENA || '0x5FbDB2315678afecb367f032d93F642f64180aa3';
const ACC0 = '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266'; // host / P1
const ACC1 = '0x70997970C51812dc3A010C7d01b50e0d17dc79C8'; // joiner / P2

// Inject a minimal EIP-1193 provider that forwards to the local node (which
// holds unlocked keys and signs eth_sendTransaction) and pins one account.
function shim(account) {
  return `
    window.ethereum = {
      isMetaMask: true,
      selectedAddress: ${JSON.stringify(account)},
      request: async ({ method, params }) => {
        if (method === 'eth_requestAccounts' || method === 'eth_accounts') return [${JSON.stringify(account)}];
        const r = await fetch(${JSON.stringify(RPC)}, {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ jsonrpc: '2.0', id: Date.now(), method, params: params || [] }),
        });
        const j = await r.json();
        if (j.error) throw new Error(j.error.message);
        return j.result;
      },
      on: () => {}, removeListener: () => {},
    };
  `;
}

async function main() {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  const host = await context.newPage();
  const joiner = await context.newPage();
  await host.addInitScript(shim(ACC0));
  await joiner.addInitScript(shim(ACC1));
  const errs = [];
  host.on('console', (m) => { if (m.type() === 'error') errs.push('HOST ' + m.text()); });
  joiner.on('console', (m) => { if (m.type() === 'error') errs.push('JOIN ' + m.text()); });

  await Promise.all([host.goto(APP, { waitUntil: 'networkidle' }), joiner.goto(APP, { waitUntil: 'networkidle' })]);
  await host.getByRole('button', { name: 'Host Tab' }).click();
  await joiner.getByRole('button', { name: 'Joiner Tab' }).click();
  await host.getByText('peer open:', { exact: false }).waitFor({ timeout: 30000 });
  await joiner.getByText('peer open:', { exact: false }).waitFor({ timeout: 30000 });
  const hostPeerId = await host.locator('section').filter({ hasText: 'Peer connection' }).locator('div').filter({ hasText: /^[a-zA-Z0-9_-]+$/ }).first().innerText();
  await joiner.getByPlaceholder('Paste host peer ID in joiner tab').fill(hostPeerId.trim());
  await joiner.getByRole('button', { name: 'Connect', exact: true }).click();
  await Promise.all([
    host.getByText('Connected', { exact: true }).waitFor({ timeout: 30000 }),
    joiner.getByText('Connected', { exact: true }).waitFor({ timeout: 30000 }),
  ]);

  // Connect wallets + set arena address on both tabs.
  for (const [page, who] of [[host, 'HOST'], [joiner, 'JOIN']]) {
    await page.getByRole('button', { name: 'Connect Wallet' }).click();
    await page.getByPlaceholder('Arena contract address (0x...)').fill(ARENA);
    await page.getByText('wallet connected:', { exact: false }).waitFor({ timeout: 15000 });
    console.log(who, 'wallet connected');
  }

  // P1 challenge.
  await host.getByRole('button', { name: 'Challenge (P1)' }).click();
  await host.getByText('challenge created:', { exact: false }).waitFor({ timeout: 30000 });
  const challengeId = (await host.getByPlaceholder('Challenge id').inputValue()).trim();
  console.log('HOST challenge id:', challengeId);

  // P2 join same challenge id.
  await joiner.getByPlaceholder('Challenge id').fill(challengeId);
  await joiner.getByRole('button', { name: 'Join (P2)' }).click();
  await joiner.getByText('joined challenge', { exact: false }).waitFor({ timeout: 30000 });
  console.log('JOIN joined challenge', challengeId);

  // Verify on-chain state directly via RPC.
  const provider = new ethers.JsonRpcProvider(RPC);
  const abi = ['function getChallenge(uint256) view returns (tuple(address p1,address p2,uint256 stake,uint64 createdAt,uint64 joinedAt,uint64 responseWindowSeconds,bytes32 matchId,bytes32 rulesHash,bytes32 matchContextHash,address p1SessionKey,address p2SessionKey,address restrictedOpponent,bytes32 latestTranscriptHead,uint8 status,address resultClaimant,uint8 claimedOutcome,uint32 claimedFinalFrame,bytes32 claimedFinalHead,bytes32 claimedP1Head,bytes32 claimedP2Head,uint64 resultDeadline,address timeoutClaimant,address timeoutAccused,uint32 timeoutFrame,uint64 timeoutDeadline,bytes32 timeoutTranscriptHead,bytes32 timeoutPacketHash))'];
  const arena = new ethers.Contract(ARENA, abi, provider);
  const ch = await arena.getChallenge(challengeId);
  const bal = await provider.getBalance(ARENA);
  console.log('--- on-chain challenge state ---');
  console.log('p1        :', ch.p1);
  console.log('p2        :', ch.p2);
  console.log('stake     :', ethers.formatEther(ch.stake), 'ETH each');
  console.log('status    :', ch.status.toString(), '(3=Active? no; enum None,Open,Active -> Active=2)');
  console.log('p1Session :', ch.p1SessionKey);
  console.log('p2Session :', ch.p2SessionKey);
  console.log('escrow bal:', ethers.formatEther(bal), 'ETH');
  const ok = ch.p1.toLowerCase() === ACC0.toLowerCase()
    && ch.p2.toLowerCase() === ACC1.toLowerCase()
    && ch.status === 2n
    && bal === ethers.parseEther('0.02');
  console.log('RESULT:', ok ? 'PASS (both funded, match Active, 0.02 ETH escrowed via UI+wallet)' : 'FAIL');
  if (errs.length) console.log('console errors:', errs.slice(0, 8).join(' | '));
  await browser.close();
  process.exit(ok ? 0 : 1);
}
main().catch((e) => { console.error(e.stack || e); process.exit(1); });
