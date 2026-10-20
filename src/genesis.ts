import { AbiCoder, Contract, getAddress, getBytes, id, keccak256, recoverAddress, type Provider } from "ethers";
import { CANONICAL_RULES_HASH } from "./protocol.ts";
import { INPUT_DELAY, ROUND_FRAMES } from "./game.ts";
import { isValidV1InputMask } from "./input-mask.ts";
import { addressFromPublicKey, hashPacketFields, signDigest, ZERO32 } from "./crypto.ts";
import type { PlayerSlot, SessionWallet, SignedInputPacket } from "./types.ts";

export type GenesisBinding = {
  chainId: string; arena: string; challengeId: string; genesis: string; rulesHash: string;
  p1: string; p2: string; p1Session: string; p2Session: string; stake: string;
  responseWindow: string; restrictedOpponent: string;
};
export type GenesisRecord = { binding: GenesisBinding; authorized: boolean; registrationChallengeId: string; lookup?: { chainId: string; arena: string; challengeId: string; blockNumber: number } };
export type GenesisAuthorization = { binding: GenesisBinding; p1Signature: string; p2Signature: string };
export const GENESIS_BINDING_TAG = id("CryptoFighter.GenesisBinding.v1");
export const GENESIS_AUTHORIZATION_TAG = id("CryptoFighter.GenesisAuthorization.v1");
export const GENESIS_BINDING_TUPLE = "tuple(uint256 chainId,address arena,uint256 challengeId,bytes32 genesis,bytes32 rulesHash,address p1,address p2,address p1Session,address p2Session,uint256 stake,uint256 responseWindow,address restrictedOpponent)";
export const GENESIS_ABI = [
  `function getGenesisBinding(uint256 challengeId) view returns (${GENESIS_BINDING_TUPLE} binding,bool authorized)`,
  "function challengeForGenesis(bytes32 genesis) view returns (uint256)",
  "function authorizeGenesis(uint256 challengeId,bytes p1Signature,bytes p2Signature)",
  "function refundUnactivatedMatch(uint256 challengeId)",
] as const;
const abi = AbiCoder.defaultAbiCoder();
const ZERO_ADDRESS = "0x" + "00".repeat(20);
const bytes32 = (v: unknown): v is string => typeof v === "string" && /^0x[0-9a-fA-F]{64}$/.test(v);
function unsigned(value: string): bigint {
  if (typeof value !== "string" || !/^(0|[1-9][0-9]*)$/.test(value)) throw new Error("uint fields require canonical decimal strings");
  const n = BigInt(value);
  if (n >= 1n << 256n) throw new Error("uint overflow");
  return n;
}

export function hashGenesisBinding(binding: GenesisBinding): string {
  if (unsigned(binding.chainId) === 0n || unsigned(binding.challengeId) === 0n || unsigned(binding.stake) === 0n) throw new Error("positive chain, challenge and stake required");
  const window = unsigned(binding.responseWindow);
  if (window < 86400n || window >= 1n << 64n) throw new Error("invalid response window");
  if (!bytes32(binding.genesis) || /^0x0{64}$/.test(binding.genesis)) throw new Error("invalid genesis");
  if (binding.rulesHash !== CANONICAL_RULES_HASH) throw new Error("unsupported canonical rules");
  for (const field of ["arena", "p1", "p2", "p1Session", "p2Session"] as const) {
    if (getAddress(binding[field]) === ZERO_ADDRESS) throw new Error("nonzero binding addresses required");
  }
  if (getAddress(binding.p1) === getAddress(binding.p2) || getAddress(binding.p1Session) === getAddress(binding.p2Session)) throw new Error("distinct participants and session keys required");
  const opponent = getAddress(binding.restrictedOpponent);
  if (opponent !== ZERO_ADDRESS && opponent !== getAddress(binding.p2)) throw new Error("restricted opponent mismatch");
  return keccak256(abi.encode(["bytes32", GENESIS_BINDING_TUPLE], [GENESIS_BINDING_TAG, binding]));
}

export function genesisAuthorizationDigest(binding: GenesisBinding, slot: PlayerSlot): string {
  if (slot !== 1 && slot !== 2) throw new Error("invalid slot");
  return keccak256(abi.encode(["bytes32", "bytes32", "uint256"], [GENESIS_AUTHORIZATION_TAG, hashGenesisBinding(binding), slot]));
}
function canonicalSigner(digest: string, signature: string): string {
  const bytes = getBytes(signature);
  if (bytes.length !== 65 || (bytes[64] !== 27 && bytes[64] !== 28)) throw new Error("invalid authorization signature");
  // ethers rejects noncanonical high-S signatures, matching Solidity.
  return recoverAddress(digest, signature);
}
function matchesRecord(binding: GenesisBinding, record: GenesisRecord): boolean {
  return record.registrationChallengeId === binding.challengeId && hashGenesisBinding(binding) === hashGenesisBinding(record.binding);
}

// `record` must come from the caller's pinned trusted chain/arena lookup. The
// authorization's self-declared binding is never accepted as its own authority.
export function verifyGenesisAuthorization(authorization: GenesisAuthorization, record: GenesisRecord): boolean {
  try {
    if (!record.authorized || !matchesRecord(authorization.binding, record)) return false;
    return canonicalSigner(genesisAuthorizationDigest(authorization.binding, 1), authorization.p1Signature) === getAddress(record.binding.p1Session) &&
      canonicalSigner(genesisAuthorizationDigest(authorization.binding, 2), authorization.p2Signature) === getAddress(record.binding.p2Session);
  } catch { return false; }
}

export async function readGenesisRecord(provider: Provider, locator: { chainId: string; arena: string; challengeId: string }, blockNumber?: number): Promise<GenesisRecord> {
  if ((await provider.getNetwork()).chainId !== unsigned(locator.chainId)) throw new Error("unexpected chain");
  const blockTag = blockNumber ?? await provider.getBlockNumber();
  const arena = new Contract(getAddress(locator.arena), GENESIS_ABI, provider);
  const result = await arena.getGenesisBinding(unsigned(locator.challengeId), { blockTag });
  const b = result.binding;
  const binding: GenesisBinding = {
    chainId: b.chainId.toString(), arena: b.arena, challengeId: b.challengeId.toString(), genesis: b.genesis,
    rulesHash: b.rulesHash, p1: b.p1, p2: b.p2, p1Session: b.p1Session, p2Session: b.p2Session,
    stake: b.stake.toString(), responseWindow: b.responseWindow.toString(), restrictedOpponent: b.restrictedOpponent,
  };
  hashGenesisBinding(binding);
  if (binding.chainId !== locator.chainId || binding.challengeId !== locator.challengeId || getAddress(binding.arena) !== getAddress(locator.arena)) throw new Error("unexpected genesis record domain");
  const registrationChallengeId = (await arena.challengeForGenesis(binding.genesis, { blockTag })).toString();
  if (registrationChallengeId !== locator.challengeId) throw new Error("genesis registration mismatch");
  return { binding, authorized: result.authorized, registrationChallengeId, lookup: { ...locator, blockNumber: blockTag } };
}

// One ephemeral session adopts one immutable escrow binding. Callers must use a
// fresh session for a new match and must not expose the private key to other signers.
export function createGenesisSession(wallet: SessionWallet, slot: PlayerSlot, expectedPlayer: string) {
  if (slot !== 1 && slot !== 2) throw new Error("invalid slot");
  const player = getAddress(expectedPlayer);
  const key = structuredClone(wallet);
  let adopted: GenesisBinding | undefined;
  let activated = false;
  const signed = new Map<number, { hash: string; packet: Promise<SignedInputPacket> }>();
  return {
    async authorize(record: GenesisRecord): Promise<string> {
      const binding = structuredClone(record.binding);
      if (getAddress(slot === 1 ? binding.p1 : binding.p2) !== player) throw new Error("unexpected main-wallet participant");
      if (!matchesRecord(binding, record)) throw new Error("genesis registration mismatch");
      if (getAddress(slot === 1 ? binding.p1Session : binding.p2Session) !== getAddress(key.address)) throw new Error("session key not delegated");
      if (adopted && hashGenesisBinding(adopted) !== hashGenesisBinding(binding)) throw new Error("session already adopted another genesis binding");
      adopted = binding;
      return signDigest(key.privateKey, genesisAuthorizationDigest(binding, slot));
    },
    activate(authorization: GenesisAuthorization, record: GenesisRecord): void {
      if (!adopted || !verifyGenesisAuthorization(authorization, record) || hashGenesisBinding(adopted) !== hashGenesisBinding(record.binding)) throw new Error("genesis not authoritatively authorized");
      activated = true;
    },
    async signMove(frame: number, inputMask: number, prevSelfHash: string, prevOppHash: string): Promise<SignedInputPacket> {
      if (!adopted || !activated) throw new Error("authorize and activate genesis before signing moves");
      if (!Number.isSafeInteger(frame) || frame < 1 || frame > ROUND_FRAMES + INPUT_DELAY || !isValidV1InputMask(inputMask) || !bytes32(prevSelfHash) || !bytes32(prevOppHash)) throw new Error("invalid move fields");
      const matchId = adopted.genesis;
      const hash = hashPacketFields(matchId, frame, slot, inputMask, prevSelfHash, prevOppHash);
      const existing = signed.get(frame);
      if (existing) {
        if (existing.hash !== hash) throw new Error("refusing conflicting move");
        return existing.packet;
      }
      if (frame !== signed.size + 1 || prevSelfHash !== (frame === 1 ? ZERO32 : signed.get(frame - 1)?.hash)) throw new Error("move must continue the adopted self chain");
      const packet = signDigest(key.privateKey, hash).then((signature) => ({ matchId, frame, player: slot, inputMask, prevSelfHash, prevOppHash, hash, publicKey: key.publicKey, signature }));
      signed.set(frame, { hash, packet });
      return packet;
    },
  };
}

// Public preparation evidence can be inspected after key loss without granting
// fresh signing or chain authority.
export function verifyGenesisConsent(value: unknown): boolean {
  try {
    if (!value || typeof value !== "object") return false;
    const consent = value as { binding: GenesisBinding; slot: PlayerSlot; publicKey: string; signature: string };
    if (Object.keys(consent).sort().join() !== "binding,publicKey,signature,slot") return false;
    const expected = consent.slot === 1 ? consent.binding.p1Session : consent.binding.p2Session;
    return canonicalSigner(genesisAuthorizationDigest(consent.binding, consent.slot), consent.signature) === getAddress(expected) &&
      getAddress(addressFromPublicKey(consent.publicKey)) === getAddress(expected);
  } catch { return false; }
}
