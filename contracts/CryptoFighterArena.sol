// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {CryptoFighterVault} from "./CryptoFighterVault.sol";
import {CryptoFighterTokenEscrow} from "./CryptoFighterTokenEscrow.sol";
import {CryptoFighterRanked} from "./CryptoFighterRanked.sol";
import {TraceDispute} from "./TraceDispute.sol";

/// @notice Funded match admission, trace adjudication, and pull-based settlement.
/// @dev Every financial term is snapshotted before either player can join.
contract CryptoFighterArena is TraceDispute, ReentrancyGuard {
    error InvalidModule();
    error RankedRequiresCfc();
    bytes32 public constant CANONICAL_RULES_HASH =
        0x45e7b6011925954ee1b15160173864f8deea010e005bd0c4dfca5fbc1d503a18;
    bytes32 private constant GENESIS_BINDING_TAG = keccak256("CryptoFighter.GenesisBinding.v2");
    bytes32 private constant GENESIS_AUTHORIZATION_TAG = keccak256("CryptoFighter.GenesisAuthorization.v1");
    uint64 private constant RESPONSE_WINDOW_SECONDS = 24 hours;
    uint256 private constant BASE_REWARD = 1 ether;

    enum MatchStatus { None, Open, Active, Cancelled, Settled }
    enum SettlementResult { None, P1Win, P2Win, Draw, NoResult }

    struct Challenge {
        address p1;
        address p2;
        address anteToken;
        uint256 anteAmount;
        uint256 rewardAmount;
        uint64 createdAt;
        uint64 joinedAt;
        uint64 gameDeadline;
        bytes32 matchId;
        bytes32 rulesHash;
        bytes32 matchContextHash;
        address p1SessionKey;
        address p2SessionKey;
        address restrictedOpponent;
        bool ranked;
        MatchStatus status;
        SettlementResult result;
    }

    struct GenesisBinding {
        uint256 chainId;
        address arena;
        uint256 challengeId;
        bytes32 genesis;
        bytes32 rulesHash;
        address p1;
        address p2;
        address p1Session;
        address p2Session;
        address anteToken;
        uint256 stake;
        uint256 rewardAmount;
        uint256 responseWindow;
        address restrictedOpponent;
    }

    CryptoFighterVault public immutable cfcVault;
    CryptoFighterTokenEscrow public immutable tokenEscrow;
    CryptoFighterRanked public immutable rankedPolicy;
    IERC20 public immutable cfc;

    uint256 public nextChallengeId = 1;
    mapping(uint256 => Challenge) internal challenges;
    mapping(bytes32 => uint256) public challengeForGenesis;
    mapping(uint256 => GenesisBinding) private genesisBindings;
    mapping(uint256 => bool) public genesisAuthorized;
    mapping(uint256 => uint64) public genesisAuthorizationDeadline;

    event ChallengeCreated(
        uint256 indexed challengeId,
        address indexed challenger,
        address indexed anteToken,
        uint256 anteAmount,
        uint256 rewardAmount,
        bool ranked,
        bytes32 matchId
    );
    event ChallengeJoined(uint256 indexed challengeId, address indexed joiner, address p2SessionKey);
    event ChallengeCancelled(uint256 indexed challengeId);
    event GenesisAuthorized(uint256 indexed challengeId, bytes32 indexed genesis, bytes32 bindingHash, uint256 gameDeadline);
    event UnactivatedMatchRefunded(uint256 indexed challengeId);
    event MatchSettled(uint256 indexed challengeId, SettlementResult result, address indexed winner);

    constructor(
        CryptoFighterVault cfcVault_,
        CryptoFighterTokenEscrow tokenEscrow_,
        CryptoFighterRanked rankedPolicy_
    ) {
        require(block.chainid == 31337, "prototype: local chain only");
        if (
            address(cfcVault_).code.length == 0 || address(tokenEscrow_).code.length == 0
                || address(rankedPolicy_).code.length == 0
        ) revert InvalidModule();
        cfcVault = cfcVault_;
        tokenEscrow = tokenEscrow_;
        rankedPolicy = rankedPolicy_;
        cfc = cfcVault_.cfc();
    }

    /// @notice Complete operator handoff after the three module owners nominate this arena.
    function acceptOperatorRoles() external {
        cfcVault.acceptOperator();
        tokenEscrow.acceptOperator();
        rankedPolicy.acceptOperator();
    }

    function getChallenge(uint256 challengeId) external view returns (Challenge memory) {
        return challenges[challengeId];
    }

    function getGenesisBinding(uint256 challengeId) external view returns (GenesisBinding memory binding, bool authorized) {
        return (genesisBindings[challengeId], genesisAuthorized[challengeId]);
    }

    function genesisAuthorizationDigest(uint256 challengeId, uint256 slot) public view returns (bytes32) {
        require(slot == 1 || slot == 2, "wrong slot");
        require(genesisBindings[challengeId].p2 != address(0), "not joined");
        return keccak256(abi.encode(GENESIS_AUTHORIZATION_TAG, challenges[challengeId].matchContextHash, slot));
    }

    function challenge(
        bytes32 matchId,
        bytes32 rulesHash,
        address p1SessionKey,
        address expectedOpponent,
        address anteToken,
        bool ranked
    ) external nonReentrant returns (uint256 challengeId) {
        require(matchId != bytes32(0), "matchId required");
        require(challengeForGenesis[matchId] == 0, "genesis already registered");
        require(rulesHash == CANONICAL_RULES_HASH, "unsupported canonical rules");
        require(p1SessionKey != address(0), "session key required");
        if (ranked && anteToken != address(cfc)) revert RankedRequiresCfc();

        uint256 anteAmount = anteToken == address(cfc) ? BASE_REWARD : tokenEscrow.requiredAnte(anteToken);
        challengeId = nextChallengeId++;
        uint256 rewardAmount = BASE_REWARD;
        if (ranked) (, rewardAmount,) = rankedPolicy.prepareOffer(challengeId, msg.sender, expectedOpponent);
        challengeForGenesis[matchId] = challengeId;
        challenges[challengeId] = Challenge({
            p1: msg.sender,
            p2: address(0),
            anteToken: anteToken,
            anteAmount: anteAmount,
            rewardAmount: rewardAmount,
            createdAt: uint64(block.timestamp),
            joinedAt: 0,
            gameDeadline: 0,
            matchId: matchId,
            rulesHash: rulesHash,
            matchContextHash: bytes32(0),
            p1SessionKey: p1SessionKey,
            p2SessionKey: address(0),
            restrictedOpponent: expectedOpponent,
            ranked: ranked,
            status: MatchStatus.Open,
            result: SettlementResult.None
        });

        _depositAnte(anteToken, matchId, msg.sender, anteAmount);

        emit ChallengeCreated(
            challengeId, msg.sender, anteToken, anteAmount, rewardAmount, ranked, matchId
        );
    }

    function join(uint256 challengeId, address p2SessionKey) external nonReentrant {
        Challenge storage c = challenges[challengeId];
        require(c.status == MatchStatus.Open, "not open");
        require(msg.sender != c.p1, "cannot join self");
        require(p2SessionKey != address(0), "session key required");
        require(p2SessionKey != c.p1SessionKey, "distinct session keys required");
        require(c.restrictedOpponent == address(0) || c.restrictedOpponent == msg.sender, "opponent locked");

        if (c.ranked) rankedPolicy.joinOffer(challengeId, c.p1, msg.sender);
        _depositAnte(c.anteToken, c.matchId, msg.sender, c.anteAmount);
        c.p2 = msg.sender;
        c.joinedAt = uint64(block.timestamp);
        c.p2SessionKey = p2SessionKey;
        c.status = MatchStatus.Active;
        GenesisBinding memory binding = GenesisBinding(
            block.chainid, address(this), challengeId, c.matchId, c.rulesHash,
            c.p1, c.p2, c.p1SessionKey, c.p2SessionKey, c.anteToken,
            c.anteAmount, c.rewardAmount, RESPONSE_WINDOW_SECONDS, c.restrictedOpponent
        );
        genesisBindings[challengeId] = binding;
        c.matchContextHash = keccak256(abi.encode(GENESIS_BINDING_TAG, binding));
        genesisAuthorizationDeadline[challengeId] = uint64(block.timestamp) + RESPONSE_WINDOW_SECONDS;

        emit ChallengeJoined(challengeId, msg.sender, p2SessionKey);
    }

    function authorizeGenesis(uint256 challengeId, bytes calldata p1Signature, bytes calldata p2Signature) external {
        Challenge storage c = challenges[challengeId];
        require(c.status == MatchStatus.Active, "not active");
        require(!genesisAuthorized[challengeId], "genesis already authorized");
        require(block.timestamp <= genesisAuthorizationDeadline[challengeId], "authorization expired");
        require(_recover(genesisAuthorizationDigest(challengeId, 1), p1Signature) == c.p1SessionKey, "bad P1 authorization");
        require(_recover(genesisAuthorizationDigest(challengeId, 2), p2Signature) == c.p2SessionKey, "bad P2 authorization");
        genesisAuthorized[challengeId] = true;
        c.gameDeadline = uint64(block.timestamp) + RESPONSE_WINDOW_SECONDS;
        emit GenesisAuthorized(challengeId, c.matchId, c.matchContextHash, c.gameDeadline);
    }

    function cancelOpenChallenge(uint256 challengeId) external nonReentrant {
        Challenge storage c = challenges[challengeId];
        require(c.status == MatchStatus.Open, "not open");
        require(msg.sender == c.p1, "only challenger");
        c.status = MatchStatus.Cancelled;
        if (c.ranked) rankedPolicy.releaseOpenOffer(challengeId, c.p1);
        _creditAnte(c, c.p1);
        emit ChallengeCancelled(challengeId);
    }

    function refundUnactivatedMatch(uint256 challengeId) external nonReentrant {
        Challenge storage c = challenges[challengeId];
        require(c.status == MatchStatus.Active, "not active");
        require(!genesisAuthorized[challengeId], "genesis already authorized");
        require(block.timestamp > genesisAuthorizationDeadline[challengeId], "authorization window open");
        c.status = MatchStatus.Cancelled;
        if (c.ranked) rankedPolicy.releaseJoinedMatch(challengeId, c.p1, c.p2);
        _creditAnte(c, c.p1);
        _creditAnte(c, c.p2);
        emit UnactivatedMatchRefunded(challengeId);
    }

    function expireUnclaimedMatch(uint256 challengeId) external {
        Challenge storage c = challenges[challengeId];
        require(c.status == MatchStatus.Active && genesisAuthorized[challengeId], "not active");
        require(traceGames[challengeId].phase == TracePhase.None, "trace already claimed");
        require(block.timestamp > c.gameDeadline, "game window open");
        _settle(challengeId, SettlementResult.NoResult);
    }

    function _traceContext(uint256 id) internal view override returns (address, address, bytes32, uint256) {
        Challenge storage c = challenges[id];
        require(c.status == MatchStatus.Active, "not active");
        require(genesisAuthorized[id], "genesis not authorized");
        return (c.p1, c.p2, c.matchContextHash, RESPONSE_WINDOW_SECONDS);
    }

    function _traceEvidence(uint256 id) internal view override returns (bytes32, address, address) {
        Challenge storage c = challenges[id];
        require(c.status == MatchStatus.Active && genesisAuthorized[id], "inactive evidence context");
        return (c.matchId, c.p1SessionKey, c.p2SessionKey);
    }

    function _beforeTraceClaim(uint256 id) internal view override {
        Challenge storage c = challenges[id];
        require(c.status == MatchStatus.Active && genesisAuthorized[id], "not claimable");
        require(block.timestamp <= c.gameDeadline, "game deadline passed");
    }

    function _onTraceOutcome(uint256 id, uint8 outcome) internal override {
        require(outcome > 0 && outcome <= 3, "unsupported outcome");
        _settle(id, SettlementResult(outcome));
    }

    function _onTraceNoResult(uint256 id) internal override {
        _settle(id, SettlementResult.NoResult);
    }

    function _settle(uint256 id, SettlementResult result) private {
        Challenge storage c = challenges[id];
        require(c.status == MatchStatus.Active, "not active");
        require(result != SettlementResult.None, "missing result");
        c.status = MatchStatus.Settled;
        c.result = result;
        if (c.ranked) rankedPolicy.settle(id, c.p1, c.p2, uint8(result));

        address winner;
        if (result == SettlementResult.P1Win) {
            winner = c.p1;
            _creditAnte(c, c.p1);
            _forfeitAnte(c, c.p2);
            cfcVault.mintGameplayReward(c.matchId, c.p1, c.rewardAmount);
        } else if (result == SettlementResult.P2Win) {
            winner = c.p2;
            _forfeitAnte(c, c.p1);
            _creditAnte(c, c.p2);
            cfcVault.mintGameplayReward(c.matchId, c.p2, c.rewardAmount);
        } else {
            _forfeitAnte(c, c.p1);
            _forfeitAnte(c, c.p2);
        }
        emit MatchSettled(id, result, winner);
    }

    function _depositAnte(address token, bytes32 matchId, address player, uint256 amount) private {
        if (token == address(cfc)) {
            cfcVault.depositEscrow(matchId, player, amount);
        } else {
            tokenEscrow.depositEscrow(IERC20(token), matchId, player, amount);
        }
    }

    function _creditAnte(Challenge storage c, address player) private {
        if (c.anteToken == address(cfc)) {
            cfcVault.creditEscrow(c.matchId, player, c.anteAmount);
        } else {
            tokenEscrow.creditEscrow(IERC20(c.anteToken), c.matchId, player, c.anteAmount);
        }
    }

    function _forfeitAnte(Challenge storage c, address player) private {
        if (c.anteToken == address(cfc)) {
            cfcVault.forfeitEscrow(c.matchId, player, c.anteAmount);
        } else {
            tokenEscrow.forfeitEscrow(IERC20(c.anteToken), c.matchId, player, c.anteAmount);
        }
    }

}
