const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const path = require("node:path");
const { assertLocalDeployment } = require("../scripts/deploy.cjs");

describe("Prototype deployment boundary", function () {
  it("rejects direct contract creation on a simulated foreign chain", function () {
    execFileSync(process.execPath, [
      require.resolve("hardhat/internal/cli/cli"), "run", "--no-compile",
      "--config", "foreign-chain.config.cjs", "scripts/check-deployment-boundary.cjs",
    ], { cwd: path.resolve(__dirname, ".."), stdio: "pipe" });
  });
  it("permits only the in-process local Hardhat network", function () {
    assert.doesNotThrow(() => assertLocalDeployment("hardhat", 31337n));
    for (const [name, chainId] of [["mainnet", 1n], ["sepolia", 11155111n], ["localhost", 31337n], ["hardhat", 1n]]) {
      assert.throws(() => assertLocalDeployment(name, chainId), /deployment disabled/);
    }
  });
});
