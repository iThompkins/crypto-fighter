import { Wallet } from "ethers";
import { CANONICAL_RULES_HASH } from "../../src/protocol.ts";
import { genesisAuthorizationDigest } from "../../src/genesis.ts";
const w1 = new Wallet("0x" + "1".padStart(64, "0")), w2 = new Wallet("0x" + "2".padStart(64, "0"));
const binding = {
  chainId: "31337", arena: "0x" + "aa".repeat(20), challengeId: "1", genesis: "0x" + "11".repeat(32), rulesHash: CANONICAL_RULES_HASH,
  p1: "0x" + "bb".repeat(20), p2: "0x" + "cc".repeat(20), p1Session: w1.address, p2Session: w2.address,
  stake: "1000", responseWindow: "86400", restrictedOpponent: "0x" + "00".repeat(20),
};
const record = { binding, authorized: true, registrationChallengeId: "1" };
const auth = {
  binding,
  p1Signature: w1.signingKey.sign(genesisAuthorizationDigest(binding, 1)).serialized,
  p2Signature: w2.signingKey.sign(genesisAuthorizationDigest(binding, 2)).serialized,
};

export { w1, w2, binding, record, auth };
