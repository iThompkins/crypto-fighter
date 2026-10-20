// In-process negative test only: simulate a production chain ID without an RPC.
module.exports = {
  ...require("./hardhat.config.cjs"),
  networks: { hardhat: { chainId: 1 } },
};
