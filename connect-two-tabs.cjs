// Compatibility entry point; the maintained harness owns server/browser cleanup.
const { spawnSync } = require("node:child_process");
const result = spawnSync(process.execPath, [require.resolve("@playwright/test/cli"), "test", "--grep", 'two real browser'], { cwd: __dirname, stdio: "inherit" });
if (result.error) console.error(result.error);
process.exitCode = result.status ?? 1;
