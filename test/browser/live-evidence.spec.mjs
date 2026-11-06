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
    await expect(page.getByRole('button', { name: 'Claim Result', exact: true })).toHaveCount(0);
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

test('funded offer preview shows exact risk, eligibility, reward, spender and recoverable approval', async ({ page }) => {
  const { Interface } = await import('ethers');
  const { FUNDED_ARENA_ABI } = await import('../../src/funded-match.ts');
  const { RANKED_POLICY_ABI } = await import('../../src/ranked.ts');
  const arena = '0x' + 'aa'.repeat(20), ranked = '0x' + 'bb'.repeat(20), vault = '0x' + 'cc'.repeat(20);
  const cfc = '0x' + 'dd'.repeat(20), tokenEscrow = '0x' + 'ee'.repeat(20);
  const p1 = '0x' + '11'.repeat(20), p2 = '0x' + '22'.repeat(20);
  const arenaInterface = new Interface([...FUNDED_ARENA_ABI, 'function rankedPolicy() view returns (address)']);
  const rankedInterface = new Interface(RANKED_POLICY_ABI);
  const tokenInterface = new Interface([
    'function allowance(address owner,address spender) view returns (uint256)',
    'function decimals() view returns (uint8)',
  ]);
  const replies = {
    [arenaInterface.getFunction('cfc').selector]: arenaInterface.encodeFunctionResult('cfc', [cfc]),
    [arenaInterface.getFunction('rankedPolicy').selector]: arenaInterface.encodeFunctionResult('rankedPolicy', [ranked]),
    [arenaInterface.getFunction('cfcVault').selector]: arenaInterface.encodeFunctionResult('cfcVault', [vault]),
    [arenaInterface.getFunction('tokenEscrow').selector]: arenaInterface.encodeFunctionResult('tokenEscrow', [tokenEscrow]),
    [rankedInterface.getFunction('eligibility').selector]: rankedInterface.encodeFunctionResult('eligibility', [true, 8, 34n * 10n ** 18n, 3]),
    [tokenInterface.getFunction('allowance').selector]: tokenInterface.encodeFunctionResult('allowance', [0]),
    [tokenInterface.getFunction('decimals').selector]: tokenInterface.encodeFunctionResult('decimals', [18]),
  };
  await page.goto('/');
  await page.evaluate(({ replies, p1 }) => {
    window.testTransactions = 0;
    window.ethereum = { request: async ({ method, params }) => {
      if (method === 'eth_chainId') return '0x7a69';
      if (method === 'eth_accounts' || method === 'eth_requestAccounts') return [p1];
      if (method === 'eth_blockNumber') return '0x1';
      if (method === 'eth_call') return replies[params[0].data.slice(0, 10)];
      if (method === 'eth_estimateGas') return '0x5208';
      if (method === 'eth_sendTransaction') { window.testTransactions++; throw new Error('user rejected approval'); }
      throw new Error(`Unexpected wallet request ${method}`);
    } };
  }, { replies, p1 });
  await page.getByRole('button', { name: 'Connect Wallet', exact: true }).click();
  await page.getByPlaceholder('Arena contract address (0x...)').fill(arena);
  await page.getByPlaceholder('Opponent wallet (required for ranked)').fill(p2);
  await page.getByText('Ranked offer (1 CFC ante; named equal-streak opponent)').click();
  await page.getByRole('button', { name: 'Preview create terms', exact: true }).click();
  await expect(page.getByText(/Ranked CFC: 1.0 token units at risk/)).toBeVisible();
  await expect(page.getByText(/34.0 CFC protocol-minted win reward.*streak 8; policy v3; exact allowance confirmation required/)).toBeVisible();
  const submit = page.getByRole('button', { name: 'Create funded offer', exact: true });
  await expect(submit).toBeEnabled();
  await submit.click();
  await expect(page.getByText(/Funded offer was not created/)).toBeVisible();
  await submit.click();
  await expect.poll(() => page.evaluate(() => window.testTransactions)).toBe(2);
  await expect(submit).toBeEnabled();
});

test('successful funded creation commits the browser session and blocks practice reset or reuse', async ({ page }) => {
  const { Interface } = await import('ethers');
  const { FUNDED_ARENA_ABI } = await import('../../src/funded-match.ts');
  const arena = '0x' + 'aa'.repeat(20), cfc = '0x' + 'dd'.repeat(20);
  const vault = '0x' + 'cc'.repeat(20), tokenEscrow = '0x' + 'ee'.repeat(20), p1 = '0x' + '11'.repeat(20);
  const iface = new Interface(FUNDED_ARENA_ABI);
  const token = new Interface([
    'function allowance(address owner,address spender) view returns (uint256)',
    'function decimals() view returns (uint8)',
  ]);
  const replies = {
    [iface.getFunction('cfc').selector]: iface.encodeFunctionResult('cfc', [cfc]),
    [iface.getFunction('cfcVault').selector]: iface.encodeFunctionResult('cfcVault', [vault]),
    [iface.getFunction('tokenEscrow').selector]: iface.encodeFunctionResult('tokenEscrow', [tokenEscrow]),
    [token.getFunction('allowance').selector]: token.encodeFunctionResult('allowance', [10n ** 18n]),
    [token.getFunction('decimals').selector]: token.encodeFunctionResult('decimals', [18]),
  };
  const transactionHash = '0x' + '12'.repeat(32), blockHash = '0x' + '34'.repeat(32);
  const event = iface.encodeEventLog(iface.getEvent('ChallengeCreated'), [
    1, p1, cfc, 10n ** 18n, 10n ** 18n, false, '0x' + '56'.repeat(32),
  ]);
  const receipt = {
    transactionHash, blockHash, blockNumber: '0x1', transactionIndex: '0x0',
    from: p1, to: arena, cumulativeGasUsed: '0x5208', gasUsed: '0x5208',
    contractAddress: null, logsBloom: '0x' + '00'.repeat(256), status: '0x1', type: '0x0', effectiveGasPrice: '0x1',
    logs: [{ ...event, address: arena, blockHash, blockNumber: '0x1', transactionHash, transactionIndex: '0x0', logIndex: '0x0', removed: false }],
  };
  await page.goto('/');
  await page.evaluate(({ replies, p1, transactionHash, receipt }) => {
    window.ethereum = { request: async ({ method, params }) => {
      if (method === 'eth_chainId') return '0x7a69';
      if (method === 'eth_accounts' || method === 'eth_requestAccounts') return [p1];
      if (method === 'eth_blockNumber') return '0x1';
      if (method === 'eth_call') return replies[params[0].data.slice(0, 10)];
      if (method === 'eth_estimateGas') return '0x5208';
      if (method === 'eth_sendTransaction') { window.sentTransaction = params[0]; return transactionHash; }
      if (method === 'eth_getTransactionByHash') return {
        hash: transactionHash, blockHash: receipt.blockHash, blockNumber: '0x1', transactionIndex: '0x0',
        from: p1, to: window.sentTransaction.to, gas: '0x5208', gasPrice: '0x1',
        input: window.sentTransaction.data, nonce: '0x0', value: '0x0', type: '0x0', chainId: '0x7a69',
        v: '0x1b', r: '0x' + '01'.padStart(64, '0'), s: '0x' + '02'.padStart(64, '0'),
      };
      if (method === 'eth_getTransactionReceipt') return receipt;
      throw new Error(`Unexpected wallet request ${method}`);
    } };
  }, { replies, p1, transactionHash, receipt });
  await page.getByRole('button', { name: 'Connect Wallet', exact: true }).click();
  await page.getByPlaceholder('Arena contract address (0x...)').fill(arena);
  await page.getByRole('button', { name: 'Preview create terms', exact: true }).click();
  await page.getByRole('button', { name: 'Create funded offer', exact: true }).click();
  await expect(page.getByText(/Created challenge 1; status open; confirmed transaction/)).toBeVisible();
  await expect(page.getByPlaceholder('Challenge id', { exact: true })).toHaveValue('1');
  await page.getByRole('button', { name: 'Preview create terms', exact: true }).click();
  await expect(page.getByText(/Current session key is already in use/)).toBeVisible();
  await page.getByRole('button', { name: 'New Match', exact: true }).click();
  await expect(page.getByText(/Session key is committed to funded challenge 1/)).toBeVisible();
});

test('joining an open funded offer previews chain terms and commits the current session', async ({ page }) => {
  const { Interface, ZeroAddress } = await import('ethers');
  const { FUNDED_ARENA_ABI } = await import('../../src/funded-match.ts');
  const arena = '0x' + 'aa'.repeat(20), cfc = '0x' + 'dd'.repeat(20), vault = '0x' + 'cc'.repeat(20);
  const tokenEscrow = '0x' + 'ee'.repeat(20), p1 = '0x' + '22'.repeat(20), p2 = '0x' + '11'.repeat(20);
  const iface = new Interface(FUNDED_ARENA_ABI);
  const token = new Interface([
    'function allowance(address owner,address spender) view returns (uint256)',
    'function decimals() view returns (uint8)',
  ]);
  const challenge = [
    p1, ZeroAddress, cfc, 10n ** 18n, 10n ** 18n,
    1, 0, 0, '0x' + '02'.repeat(32), '0x' + '03'.repeat(32), '0x' + '00'.repeat(32),
    '0x' + '44'.repeat(20), ZeroAddress, p2, false, 1, 0,
  ];
  const replies = {
    [iface.getFunction('getChallenge').selector]: iface.encodeFunctionResult('getChallenge', [challenge]),
    [iface.getFunction('cfc').selector]: iface.encodeFunctionResult('cfc', [cfc]),
    [iface.getFunction('cfcVault').selector]: iface.encodeFunctionResult('cfcVault', [vault]),
    [iface.getFunction('tokenEscrow').selector]: iface.encodeFunctionResult('tokenEscrow', [tokenEscrow]),
    [token.getFunction('allowance').selector]: token.encodeFunctionResult('allowance', [10n ** 18n]),
    [token.getFunction('decimals').selector]: token.encodeFunctionResult('decimals', [18]),
  };
  const transactionHash = '0x' + '78'.repeat(32), blockHash = '0x' + '89'.repeat(32);
  const receipt = {
    transactionHash, blockHash, blockNumber: '0x1', transactionIndex: '0x0', from: p2, to: arena,
    cumulativeGasUsed: '0x5208', gasUsed: '0x5208', contractAddress: null,
    logsBloom: '0x' + '00'.repeat(256), status: '0x1', type: '0x0', effectiveGasPrice: '0x1', logs: [],
  };
  await page.goto('/');
  await page.evaluate(({ replies, p2, transactionHash, receipt }) => {
    window.ethereum = { request: async ({ method, params }) => {
      if (method === 'eth_chainId') return '0x7a69';
      if (method === 'eth_accounts' || method === 'eth_requestAccounts') return [p2];
      if (method === 'eth_blockNumber') return '0x1';
      if (method === 'eth_call') return replies[params[0].data.slice(0, 10)];
      if (method === 'eth_estimateGas') return '0x5208';
      if (method === 'eth_sendTransaction') { window.sentTransaction = params[0]; return transactionHash; }
      if (method === 'eth_getTransactionByHash') return {
        hash: transactionHash, blockHash: receipt.blockHash, blockNumber: '0x1', transactionIndex: '0x0',
        from: p2, to: window.sentTransaction.to, gas: '0x5208', gasPrice: '0x1',
        input: window.sentTransaction.data, nonce: '0x0', value: '0x0', type: '0x0', chainId: '0x7a69',
        v: '0x1b', r: '0x' + '01'.padStart(64, '0'), s: '0x' + '02'.padStart(64, '0'),
      };
      if (method === 'eth_getTransactionReceipt') return receipt;
      throw new Error(`Unexpected wallet request ${method}`);
    } };
  }, { replies, p2, transactionHash, receipt });
  await page.getByRole('button', { name: 'Connect Wallet', exact: true }).click();
  await page.getByPlaceholder('Arena contract address (0x...)').fill(arena);
  await page.getByPlaceholder('Challenge id', { exact: true }).fill('7');
  await page.getByRole('button', { name: 'Preview join terms', exact: true }).click();
  await expect(page.getByText(/Unranked: 1.0 token units at risk.*1.0 CFC protocol-minted win reward/)).toBeVisible();
  await page.getByRole('button', { name: 'Join funded offer', exact: true }).click();
  await expect(page.getByText(/Joined challenge 7; status active; confirmed transaction/)).toBeVisible();
  await page.getByRole('button', { name: 'Preview join terms', exact: true }).click();
  await expect(page.getByText(/Current session key is already in use/)).toBeVisible();
});

test('funded controls reject a non-local wallet before any transaction', async ({ page }) => {
  const p1 = '0x' + '11'.repeat(20), arena = '0x' + 'aa'.repeat(20);
  await page.goto('/');
  await page.evaluate(({ p1 }) => {
    window.ethereum = { request: async ({ method }) => {
      if (method === 'eth_chainId') return '0x1';
      if (method === 'eth_accounts' || method === 'eth_requestAccounts') return [p1];
      throw new Error(`Funded control unexpectedly requested ${method}`);
    } };
  }, { p1 });
  await page.getByRole('button', { name: 'Connect Wallet', exact: true }).click();
  await page.getByPlaceholder('Arena contract address (0x...)').fill(arena);
  await page.getByRole('button', { name: 'Preview create terms', exact: true }).click();
  await expect(page.getByText(/funded matches require local chain 31337/)).toBeVisible();
});
