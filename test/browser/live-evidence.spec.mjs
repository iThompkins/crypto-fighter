import { test, expect } from '@playwright/test';

test('live disconnect/reconnect preserves history; reload recovers inspection without signing', async ({ context }) => {
  test.setTimeout(120_000);
  const host = await context.newPage(), joiner = await context.newPage();
  const errors = [];
  for (const page of [host, joiner]) page.on('pageerror', e => errors.push(e.message));
  await Promise.all([host.goto('/'), joiner.goto('/')]);
  await host.getByRole('button', { name: 'Host Tab', exact: true }).click();
  await joiner.getByRole('button', { name: 'Joiner Tab', exact: true }).click();
  await expect(host.getByTestId('peer-id')).not.toHaveText('initialize first');
  await expect(joiner.getByTestId('peer-id')).not.toHaveText('initialize first');
  await joiner.getByPlaceholder('Paste host peer ID in joiner tab').fill(await host.getByTestId('peer-id').innerText());
  await joiner.getByRole('button', { name: 'Connect', exact: true }).click();
  await expect(host.getByText('Connected', { exact: true })).toBeVisible();
  await expect(joiner.getByText('Connected', { exact: true })).toBeVisible();
  await host.getByRole('button', { name: 'Start Match', exact: true }).click();
  await expect(host.getByText('practice: running', { exact: true })).toBeVisible();
  // Role changes must not invalidate existing connection callbacks.
  await host.getByRole('button', { name: 'Host Tab', exact: true }).click();
  await expect(host.getByText(/Reset locally before changing role/)).toBeVisible();
  await joiner.getByRole('button', { name: 'Disconnect', exact: true }).click();
  await expect(host.getByText('Not connected', { exact: true })).toBeVisible();
  await expect(joiner.getByText('Not connected', { exact: true })).toBeVisible();
  await joiner.getByRole('button', { name: 'Connect', exact: true }).click();
  await expect(host.getByText('Connected', { exact: true })).toBeVisible();
  await expect(joiner.getByText('Connected', { exact: true })).toBeVisible();
  await expect(host.getByText('300 / 300', { exact: true })).toBeVisible({ timeout: 45_000 });
  await expect(joiner.getByText('300 / 300', { exact: true })).toBeVisible({ timeout: 45_000 });
  const uninterrupted = await host.evaluate(async () => {
    const { BrowserEvidenceStore } = await import('/src/evidence-store.ts');
    const { buildEvidenceBundle } = await import('/src/evidence-trace.ts');
    const { canonicalJson } = await import('/src/evidence-archive.ts');
    const store = new BrowserEvidenceStore();
    const results = [];
    for (const context of await store.contexts()) {
      const bundle = await buildEvidenceBundle({ format: 'phase-b-journal-v1', journal: await store.read(context) });
      results.push(canonicalJson({ transcript: bundle.reconstruction.transcript, states: bundle.reconstruction.states, trace: bundle.trace }));
    }
    return results;
  });
  await host.reload();
  await expect(host.getByRole('button', { name: 'Start Match', exact: true })).toBeDisabled();
  const recovered = await host.evaluate(async () => {
    const { BrowserEvidenceStore } = await import('/src/evidence-store.ts');
    const { LiveMatch } = await import('/src/live-match.ts');
    const { buildEvidenceBundle } = await import('/src/evidence-trace.ts');
    const { canonicalJson } = await import('/src/evidence-archive.ts');
    const store = new BrowserEvidenceStore();
    const result = [];
    for (const context of await store.contexts()) {
      const match = await LiveMatch.recover(context, store);
      let rejected = false;
      try { await match.consent(); } catch { rejected = true; }
      const bundle = await buildEvidenceBundle(await match.exportEvidence());
      result.push({ snapshot: match.snapshot(), rejected, outbound: await match.tick(1), canonical: canonicalJson({ transcript: bundle.reconstruction.transcript, states: bundle.reconstruction.states, trace: bundle.trace }) });
    }
    return result;
  });
  expect(recovered).toHaveLength(2);
  expect(recovered.map(value => value.canonical)).toEqual(uninterrupted);
  expect(uninterrupted[0]).toBe(uninterrupted[1]);
  for (const value of recovered) {
    expect(value.snapshot.status).toBe('inspection');
    expect(value.snapshot.state.frame).toBe(300);
    expect(value.snapshot.settlementEligible).toBe(false);
    expect(value.rejected).toBe(true);
    expect(value.outbound).toEqual([]);
    expect(JSON.stringify(value.snapshot)).not.toContain('privateKey');
    expect(value.snapshot.history.some(e => e.observation?.kind === 'disconnect')).toBe(true);
  }
  expect(recovered[0].snapshot.frames).toEqual(recovered[1].snapshot.frames);
  expect(errors).toEqual([]);
});

test('IndexedDB commits are atomic across tabs and recovered rows reject tampering', async ({ page }) => {
  await page.goto('/');
  const result = await page.evaluate(async () => {
    const { BrowserEvidenceStore } = await import('/src/evidence-store.ts');
    const { LiveMatch } = await import('/src/live-match.ts');
    const store = new BrowserEvidenceStore('atomic-evidence-test');
    const writes = await Promise.allSettled([store.initialize('context', { kind: 'genesis' }), store.initialize('context', { kind: 'genesis' })]);
    let rejected = false;
    try { await LiveMatch.recover('context', store); } catch { rejected = true; }
    return { fulfilled: writes.filter(w => w.status === 'fulfilled').length, rows: await store.read('context'), rejected };
  });
  expect(result.fulfilled).toBe(1);
  expect(result.rows).toHaveLength(1);
  expect(result.rejected).toBe(true);
});

test('browser verifies locally read escrow delegation before authenticated live play', async ({ context }) => {
  const { Interface } = await import('ethers');
  const { GENESIS_ABI } = await import('../../src/genesis.ts');
  const { binding } = await import('../fixtures/genesis.mjs');
  const { readFile } = await import('node:fs/promises');
  const host = await context.newPage(), joiner = await context.newPage();
  await Promise.all([host.goto('/'), joiner.goto('/')]);
  await host.getByRole('button', { name: 'Host Tab', exact: true }).click();
  await joiner.getByRole('button', { name: 'Joiner Tab', exact: true }).click();
  await expect(host.getByTestId('peer-id')).not.toHaveText('initialize first');
  await expect(joiner.getByTestId('peer-id')).not.toHaveText('initialize first');
  await joiner.getByPlaceholder('Paste host peer ID in joiner tab').fill(await host.getByTestId('peer-id').innerText());
  await joiner.getByRole('button', { name: 'Connect', exact: true }).click();
  await expect(host.getByText('Connected', { exact: true })).toBeVisible();
  await expect(joiner.getByText('Connected', { exact: true })).toBeVisible();
  const identity = async (page, player) => (await page.locator('section').filter({ has: page.getByText(`Player ${player}`, { exact: true }) }).last().innerText()).match(/0x[0-9a-fA-F]{40}/)[0];
  const b = { ...binding, p1Session: await identity(host, 1), p2Session: await identity(joiner, 2) };
  const iface = new Interface(GENESIS_ABI);
  const replies = {
    [iface.getFunction('getGenesisBinding').selector]: iface.encodeFunctionResult('getGenesisBinding', [b, true]),
    [iface.getFunction('challengeForGenesis').selector]: iface.encodeFunctionResult('challengeForGenesis', [1]),
  };
  // This RPC fixture exercises browser lookup/signing; real activation is covered
  // separately by hh/test/genesis.cjs. It exposes no session private keys.
  for (const [page, account] of [[host, b.p1], [joiner, b.p2]]) {
    await page.evaluate(({ replies, account }) => {
      window.ethereum = { request: async ({ method, params }) => {
        if (method === 'eth_chainId') return '0x7a69';
        if (method === 'eth_accounts' || method === 'eth_requestAccounts') return [account];
        if (method === 'eth_blockNumber') return '0x1';
        if (method === 'eth_call') {
          if (window.holdTestRpc) { await new Promise(resolve => { window.releaseTestRpc = resolve; }); window.holdTestRpc = false; }
          return replies[params[0].data.slice(0, 10)];
        }
        throw new Error(`Unexpected wallet request ${method}`);
      } };
    }, { replies, account });
    await page.getByRole('button', { name: 'Connect Wallet', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Wallet Connected', exact: true })).toBeVisible();
    await page.getByPlaceholder('Arena contract address (0x...)').fill(b.arena);
    await page.getByPlaceholder('Challenge id', { exact: true }).fill('1');
  }
  const consents = [];
  for (const page of [host, joiner]) {
    const download = page.waitForEvent('download');
    if (page === host) await page.evaluate(() => { window.holdTestRpc = true; });
    await page.getByRole('button', { name: 'Export genesis consent', exact: true }).click();
    if (page === host) {
      await expect.poll(() => page.evaluate(() => typeof window.releaseTestRpc)).toBe('function');
      await page.getByRole('button', { name: 'Start Match', exact: true }).click();
      await expect(page.getByText(/Match preparation already in progress/)).toBeVisible();
      await page.evaluate(() => { window.holdTestRpc = false; window.releaseTestRpc(); });
    }
    consents.push(JSON.parse(await readFile(await (await download).path(), 'utf8')));
  }
  const authorization = { binding: b, p1Signature: consents[0].signature, p2Signature: consents[1].signature };
  for (const page of [host, joiner]) {
    await page.getByRole('textbox', { name: 'Genesis authorization', exact: true }).fill(JSON.stringify(authorization));
    await page.getByRole('button', { name: 'Load activated escrow match', exact: true }).click();
    await expect(page.getByText('escrow authorized; ready to start', { exact: true })).toBeVisible();
  }
  await host.getByRole('button', { name: 'Start Match', exact: true }).click();
  for (const page of [host, joiner]) {
    await expect(page.getByText('escrow: running', { exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Claim Result', exact: true })).toBeDisabled();
  }
  const saved = await host.evaluate(async () => {
    const { BrowserEvidenceStore } = await import('/src/evidence-store.ts');
    const store = new BrowserEvidenceStore();
    return Promise.all((await store.contexts()).filter(c => !c.startsWith("consent:")).map(c => store.read(c)));
  });
  expect(saved).toHaveLength(2);
  for (const rows of saved) {
    expect(rows[0].config.mode).toBe('escrow');
    expect(rows[0].record.lookup.blockNumber).toBe(1);
    expect(rows[0].record.binding.genesis).toBe(b.genesis);
    expect(JSON.stringify(rows)).not.toContain('privateKey');
  }
});
