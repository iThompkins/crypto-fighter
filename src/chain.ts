import { BrowserProvider, Contract, parseEther, type Eip1193Provider, type Signer } from "ethers";
import { hashJson } from "./crypto";
import type { GameState } from "./types";

// Minimal human-readable ABI for the settlement calls the UI needs.
export const ARENA_ABI = [
  "function nextChallengeId() view returns (uint256)",
  "function challenge(bytes32 matchId, bytes32 rulesHash, address p1SessionKey, address expectedOpponent, uint64 responseWindowSeconds) payable returns (uint256)",
  "function join(uint256 challengeId, address p2SessionKey) payable",
  "function claimResult(uint256 challengeId, uint8 outcome, uint32 finalFrame, bytes32 finalHead, bytes32 p1Head, bytes32 p2Head)",
  "function finalizeResult(uint256 challengeId)",
  "event ChallengeCreated(uint256 indexed challengeId, address indexed challenger, uint256 stake, bytes32 matchId, bytes32 rulesHash, bytes32 matchContextHash, address p1SessionKey, address restrictedOpponent, uint64 responseWindowSeconds)",
  "event ChallengeJoined(uint256 indexed challengeId, address indexed joiner, address p2SessionKey)",
  "event ResultClaimed(uint256 indexed challengeId, address indexed claimant, uint8 outcome, uint32 finalFrame, bytes32 finalHead, uint64 deadline)",
  "event MatchFinalized(uint256 indexed challengeId, uint8 outcome, address indexed winner, uint256 payout)",
] as const;

// Contract Outcome enum: None, P1, P2, Tie.
export const Outcome = { None: 0, P1: 1, P2: 2, Tie: 3 } as const;

export function outcomeFromWinner(winner: GameState["winner"]): number {
  if (winner === "P1") return Outcome.P1;
  if (winner === "P2") return Outcome.P2;
  if (winner === "TIE_BOTH_LOSE") return Outcome.Tie;
  return Outcome.None;
}

// Stable rules hash committed on-chain and referenced by the transcript.
export function rulesHash(rules: unknown): string {
  return hashJson(rules);
}

function injected(): Eip1193Provider {
  const eth = (window as unknown as { ethereum?: Eip1193Provider }).ethereum;
  if (!eth) throw new Error("No injected wallet (install MetaMask).");
  return eth;
}

export type WalletConnection = {
  provider: BrowserProvider;
  signer: Signer;
  address: string;
  chainId: bigint;
};

export async function connectWallet(): Promise<WalletConnection> {
  const provider = new BrowserProvider(injected());
  await provider.send("eth_requestAccounts", []);
  const signer = await provider.getSigner();
  const address = await signer.getAddress();
  const net = await provider.getNetwork();
  return { provider, signer, address, chainId: net.chainId };
}

export function arena(address: string, signer: Signer): Contract {
  return new Contract(address, ARENA_ABI, signer);
}

export function stakeWei(stakeEth: string): bigint {
  return parseEther(stakeEth || "0");
}
