// Browser escrow is intentionally unavailable until settlement proofs exist.
console.error("On-chain UI testing is disabled. Run npm run test:contract for valueless in-process EVM tests, or npm run test:browser for gameplay and settlement containment.");
process.exitCode = 1;
