require("@nomicfoundation/hardhat-ethers");
const path = require("path");
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
