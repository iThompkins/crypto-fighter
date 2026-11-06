import { Contract, formatUnits, getAddress, type Provider } from "ethers";

export const RANKED_ARENA_ABI = [
  "function rankedPolicy() view returns (address)",
] as const;

export const RANKED_POLICY_ABI = [
  "function eligibility(address p1,address p2) view returns (bool eligible,uint256 startingStreak,uint256 rewardAmount,uint64 policyVersion)",
  "function rankedOffers(uint256 challengeId) view returns (address p1,address p2,uint256 startingStreak,uint256 rewardAmount,uint64 policyVersion,uint8 status,uint8 result)",
] as const;

export type RankedPreview = {
  eligible: boolean;
  startingStreak: string;
  anteCfc: "1";
  nextWinRewardCfc: string;
  policyVersion: string;
};
export type RankedOutcome = {
  p1: string; p2: string; startingStreak: string; rewardCfc: string;
  policyVersion: string; status: "open" | "active" | "cancelled" | "settled"; result: "none" | "p1" | "p2" | "draw" | "no-result";
};

export function rankedPreviewText(preview: RankedPreview): string {
  const opponent = preview.eligible ? "same-rank opponent eligible" : "opponent not currently eligible";
  return `Ranked: exactly 1 CFC at risk; streak ${preview.startingStreak}; next accepted win mints ${preview.nextWinRewardCfc} CFC; ${opponent}; protocol-issued reward; policy v${preview.policyVersion}.`;
}

export async function readRankedPreview(
  provider: Provider,
  arenaAddress: string,
  p1: string,
  p2: string,
): Promise<RankedPreview> {
  const arena = new Contract(getAddress(arenaAddress), RANKED_ARENA_ABI, provider);
  const blockTag = await provider.getBlockNumber();
  const rankedAddress = await arena.rankedPolicy({ blockTag });
  const ranked = new Contract(getAddress(rankedAddress), RANKED_POLICY_ABI, provider);
  const eligibility = await ranked.eligibility(getAddress(p1), getAddress(p2), { blockTag });
  const reward = BigInt(eligibility.rewardAmount);
  return {
    eligible: eligibility.eligible,
    startingStreak: eligibility.startingStreak.toString(),
    anteCfc: "1",
    nextWinRewardCfc: formatUnits(reward, 18),
    policyVersion: eligibility.policyVersion.toString(),
  };
}

export async function readRankedOutcome(provider: Provider, arenaAddress: string, challengeId: string): Promise<RankedOutcome> {
  if (!/^[1-9][0-9]*$/.test(challengeId)) throw new Error("positive challenge id required");
  const blockTag = await provider.getBlockNumber();
  const arena = new Contract(getAddress(arenaAddress), RANKED_ARENA_ABI, provider);
  const rankedAddress = await arena.rankedPolicy({ blockTag });
  const ranked = new Contract(getAddress(rankedAddress), RANKED_POLICY_ABI, provider);
  const offer = await ranked.rankedOffers(BigInt(challengeId), { blockTag });
  const statuses = ["none", "open", "active", "cancelled", "settled"] as const;
  const results = ["none", "p1", "p2", "draw", "no-result"] as const;
  const status = statuses[Number(offer.status)], result = results[Number(offer.result)];
  if (!status || !result || status === "none") throw new Error("ranked offer not found");
  return {
    p1: getAddress(offer.p1), p2: getAddress(offer.p2), startingStreak: offer.startingStreak.toString(),
    rewardCfc: formatUnits(offer.rewardAmount, 18), policyVersion: offer.policyVersion.toString(), status, result,
  };
}
