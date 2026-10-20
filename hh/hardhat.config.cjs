require("@nomicfoundation/hardhat-ethers");
const path = require("path");
const { subtask } = require("hardhat/config");
const { TASK_COMPILE_SOLIDITY_GET_SOLC_BUILD } = require("hardhat/builtin-tasks/task-names");

// Resolve the lockfile-pinned compiler without Hardhat's network downloader.
subtask(TASK_COMPILE_SOLIDITY_GET_SOLC_BUILD).setAction(async ({ solcVersion }) => {
  const longVersion = require("solc").version();
  if (solcVersion !== "0.8.26" || !longVersion.startsWith("0.8.26+")) {
    throw new Error(`Unexpected Solidity compiler: ${solcVersion} / ${longVersion}`);
  }
  return { compilerPath: require.resolve("solc/soljson.js"), isSolcJs: true, version: solcVersion, longVersion };
});
module.exports = {
  solidity: {
    version: "0.8.26",
    settings: { viaIR: true, optimizer: { enabled: true, runs: 200 } },
  },
  paths: {
    sources: path.join(__dirname, "contracts"),
    tests: path.join(__dirname, "test"),
    cache: path.join(__dirname, ".hhcache"),
    artifacts: path.join(__dirname, ".hhartifacts"),
  },
  mocha: { spec: "test/**/*.cjs", timeout: 120000 },
};
