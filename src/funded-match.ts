import { Contract, Interface, formatUnits, getAddress, type LogDescription, type Provider, type Signer, ZeroAddress } from "ethers";
import { CANONICAL_RULES_HASH } from "./protocol.ts";
import { readRankedPreview, type RankedPreview } from "./ranked.ts";

const LOCAL_CHAIN_ID = 31337n;
const CFC = 10n ** 18n;

export const FUNDED_ARENA_ABI = [
  "function cfc() view returns (address)",
  "function cfcVault() view returns (address)",
  "function tokenEscrow() view returns (address)",
  "function getChallenge(uint256 challengeId) view returns (tuple(address p1,address p2,address anteToken,uint256 anteAmount,uint256 rewardAmount,bytes32 rewardReservationId,uint64 createdAt,uint64 joinedAt,uint64 gameDeadline,bytes32 matchId,bytes32 rulesHash,bytes32 matchContextHash,address p1SessionKey,address p2SessionKey,address restrictedOpponent,bool ranked,uint8 status,uint8 result))",
  "function challenge(bytes32 matchId,bytes32 rulesHash,address p1SessionKey,address expectedOpponent,address anteToken,bool ranked) returns (uint256)",
  "function join(uint256 challengeId,address p2SessionKey)",
  "event ChallengeCreated(uint256 indexed challengeId,address indexed challenger,address indexed anteToken,uint256 anteAmount,uint256 rewardAmount,bool ranked,bytes32 matchId)",
] as const;

const TOKEN_ESCROW_ABI = ["function requiredAnte(address token) view returns (uint256)"] as const;
const ERC20_ABI = [
  "function decimals() view returns (uint8)",
  "function allowance(address owner,address spender) view returns (uint256)",
  "function approve(address spender,uint256 amount) returns (bool)",
] as const;

export type FundedOfferPlan = {
  arena: string;
  player: string;
  opponent: string;
  restrictedOpponent: string;
  anteToken: string;
  spender: string;
  anteAmount: string;
  anteDisplay: string;
  rewardCfc: string;
  ranked: boolean;
  allowanceRequired: boolean;
  rankedPreview?: RankedPreview;
};

export type FundedSubmission = { challengeId: string; transactionHash: string; approvalHash?: string };

export function requireLocalFundedChain(chainId: bigint): void {
  if (chainId !== LOCAL_CHAIN_ID) throw new Error("funded matches require local chain 31337");
}

async function assertLocal(provider: Provider): Promise<void> {
  requireLocalFundedChain((await provider.getNetwork()).chainId);
}

export async function readFundedOfferPlan(
  provider: Provider,
  arenaAddress: string,
  playerAddress: string,
  opponentAddress: string,
  tokenAddress: string | undefined,
  ranked: boolean,
): Promise<FundedOfferPlan> {
  await assertLocal(provider);
  const arenaAddressChecked = getAddress(arenaAddress);
  const player = getAddress(playerAddress);
  const opponent = opponentAddress ? getAddress(opponentAddress) : ZeroAddress;
  const arena = new Contract(arenaAddressChecked, FUNDED_ARENA_ABI, provider);
  const blockTag = await provider.getBlockNumber();
  const [cfcAddress, cfcVault, tokenEscrow] = await Promise.all([
    arena.cfc({ blockTag }), arena.cfcVault({ blockTag }), arena.tokenEscrow({ blockTag }),
  ]);
  const cfc = getAddress(cfcAddress);
  const anteToken = tokenAddress ? getAddress(tokenAddress) : cfc;
  let anteAmount: bigint, rewardCfc = "1.0", rankedPreview: RankedPreview | undefined;
  if (ranked) {
    if (anteToken !== cfc) throw new Error("ranked offers require CFC");
    if (opponent === ZeroAddress) throw new Error("ranked offers require a named opponent");
    rankedPreview = await readRankedPreview(provider, arenaAddressChecked, player, opponent);
    if (!rankedPreview.eligible) throw new Error("ranked opponent is not currently eligible");
    if (!rankedPreview.rewardFunded) throw new Error("ranked reward reserve is insufficient");
    anteAmount = CFC;
    rewardCfc = rankedPreview.nextWinRewardCfc;
  } else if (anteToken === cfc) {
    anteAmount = CFC;
  } else {
    const escrow = new Contract(getAddress(tokenEscrow), TOKEN_ESCROW_ABI, provider);
    anteAmount = BigInt(await escrow.requiredAnte(anteToken, { blockTag }));
  }
  const spender = anteToken === cfc ? getAddress(cfcVault) : getAddress(tokenEscrow);
  const token = new Contract(anteToken, ERC20_ABI, provider);
  const [allowanceValue, decimals] = await Promise.all([
    token.allowance(player, spender, { blockTag }), token.decimals({ blockTag }),
  ]);
  const allowance = BigInt(allowanceValue);
  return {
    arena: arenaAddressChecked, player, opponent, restrictedOpponent: opponent, anteToken, spender,
    anteAmount: anteAmount.toString(), anteDisplay: formatUnits(anteAmount, Number(decimals)),
    rewardCfc, ranked, allowanceRequired: allowance < anteAmount, rankedPreview,
  };
}

async function approveIfRequired(signer: Signer, plan: FundedOfferPlan): Promise<string | undefined> {
  if (!plan.allowanceRequired) return undefined;
  const token = new Contract(plan.anteToken, ERC20_ABI, signer);
  const transaction = await token.approve(plan.spender, BigInt(plan.anteAmount));
  const receipt = await transaction.wait();
  if (!receipt || receipt.status !== 1) throw new Error("ante approval failed");
  return transaction.hash;
}

export async function createFundedOffer(
  signer: Signer,
  args: { arena: string; matchId: string; sessionKey: string; opponent: string; anteToken?: string; ranked: boolean },
): Promise<FundedSubmission> {
  if (!signer.provider) throw new Error("wallet provider required");
  const player = await signer.getAddress();
  const plan = await readFundedOfferPlan(signer.provider, args.arena, player, args.opponent, args.anteToken, args.ranked);
  const approvalHash = await approveIfRequired(signer, plan);
  const arena = new Contract(plan.arena, FUNDED_ARENA_ABI, signer);
  const transaction = await arena.challenge(
    args.matchId, CANONICAL_RULES_HASH, getAddress(args.sessionKey), plan.opponent, plan.anteToken, plan.ranked,
  );
  const receipt = await transaction.wait();
  if (!receipt || receipt.status !== 1) throw new Error("challenge transaction failed");
  const iface = new Interface(FUNDED_ARENA_ABI);
  const event = receipt.logs.map((log: { topics: readonly string[]; data: string }) => {
    try { return iface.parseLog(log); } catch { return null; }
  }).find((value: LogDescription | null) => value?.name === "ChallengeCreated");
  if (!event) throw new Error("challenge receipt missing ChallengeCreated");
  return { challengeId: event.args.challengeId.toString(), transactionHash: transaction.hash, approvalHash };
}

export async function joinFundedOffer(
  signer: Signer,
  args: { arena: string; challengeId: string; sessionKey: string },
): Promise<FundedSubmission> {
  if (!signer.provider) throw new Error("wallet provider required");
  const plan = await readFundedJoinPlan(signer.provider, args.arena, args.challengeId, await signer.getAddress());
  const approvalHash = await approveIfRequired(signer, plan);
  const arena = new Contract(plan.arena, FUNDED_ARENA_ABI, signer);
  const transaction = await arena.join(BigInt(args.challengeId), getAddress(args.sessionKey));
  const receipt = await transaction.wait();
  if (!receipt || receipt.status !== 1) throw new Error("join transaction failed");
  return { challengeId: args.challengeId, transactionHash: transaction.hash, approvalHash };
}

export async function readFundedJoinPlan(
  provider: Provider,
  arenaInput: string,
  challengeId: string,
  playerInput: string,
): Promise<FundedOfferPlan> {
  await assertLocal(provider);
  if (!/^[1-9][0-9]*$/.test(challengeId)) throw new Error("positive challenge id required");
  const arenaAddress = getAddress(arenaInput), player = getAddress(playerInput);
  const arena = new Contract(arenaAddress, FUNDED_ARENA_ABI, provider);
  const blockTag = await provider.getBlockNumber();
  const [challenge, cfcAddress, cfcVault, tokenEscrow] = await Promise.all([
    arena.getChallenge(BigInt(challengeId), { blockTag }), arena.cfc({ blockTag }),
    arena.cfcVault({ blockTag }), arena.tokenEscrow({ blockTag }),
  ]);
  if (challenge.status !== 1n) throw new Error("challenge is not open");
  if (getAddress(challenge.p1) === player) throw new Error("challenger cannot join their own offer");
  const restrictedOpponent = getAddress(challenge.restrictedOpponent);
  if (restrictedOpponent !== ZeroAddress && restrictedOpponent !== player) throw new Error("offer is restricted to another opponent");
  const anteToken = getAddress(challenge.anteToken);
  const spender = anteToken === getAddress(cfcAddress) ? getAddress(cfcVault) : getAddress(tokenEscrow);
  const token = new Contract(anteToken, ERC20_ABI, provider);
  const [allowanceValue, decimals] = await Promise.all([
    token.allowance(player, spender, { blockTag }), token.decimals({ blockTag }),
  ]);
  const allowance = BigInt(allowanceValue);
  const plan: FundedOfferPlan = {
    arena: arenaAddress, player, opponent: getAddress(challenge.p1),
    restrictedOpponent, anteToken, spender,
    anteAmount: challenge.anteAmount.toString(), anteDisplay: formatUnits(challenge.anteAmount, Number(decimals)),
    rewardCfc: formatUnits(challenge.rewardAmount, 18), ranked: challenge.ranked,
    allowanceRequired: allowance < challenge.anteAmount,
  };
  return plan;
}
