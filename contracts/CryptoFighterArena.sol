// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @notice Escrow admission and authenticated trace adjudication for Crypto Fighter.
/// @dev Trace verdicts deliberately have no payout effect until funded-state exit
///      semantics are specified and implemented.
import "./TraceDispute.sol";

contract CryptoFighterArena is TraceDispute {
    /// @notice Identifies the sole canonical game version; never match configuration.
    /// @dev Must equal src/protocol.ts. Deployment tests check byte-for-byte parity.
    bytes32 public constant CANONICAL_RULES_HASH =
        0x45e7b6011925954ee1b15160173864f8deea010e005bd0c4dfca5fbc1d503a18;
    /// @dev Temporary containment, not a settlement security proof. No override.
    ///      This prototype must only be exercised with valueless local test funds.
    constructor() {
        require(block.chainid == 31337, "prototype: local chain only");
    }

    enum MatchStatus {
        None,
        Open,
        Active,
        Cancelled
    }

    struct Challenge {
        address payable p1;
        address payable p2;
        uint256 stake;
        uint64 createdAt;
        uint64 joinedAt;
        uint64 responseWindowSeconds;
        bytes32 matchId;
        bytes32 rulesHash;
        bytes32 matchContextHash;
        // Ephemeral secp256k1 session-key addresses each wallet delegated by
        // committing them in its own (wallet-signed) challenge/join tx.
        address p1SessionKey;
        address p2SessionKey;
        // Optional: restrict who may join to a specific opponent main wallet.
        address restrictedOpponent;
        MatchStatus status;
    }

    // Immutable even after stake is refunded. All move packets still sign
    // only their genesis and move-chain fields; authorization happens once here.
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
        uint256 stake;
        uint256 responseWindow;
        address restrictedOpponent;
    }

    bytes32 public constant GENESIS_BINDING_TAG = keccak256("CryptoFighter.GenesisBinding.v1");
    bytes32 public constant GENESIS_AUTHORIZATION_TAG = keccak256("CryptoFighter.GenesisAuthorization.v1");
    mapping(bytes32 => uint256) public challengeForGenesis;
    mapping(uint256 => GenesisBinding) private genesisBindings;
    mapping(uint256 => bool) public genesisAuthorized;
    mapping(uint256 => uint64) public genesisAuthorizationDeadline;

    event GenesisAuthorized(uint256 indexed challengeId, bytes32 indexed genesis, bytes32 bindingHash);
    event UnactivatedMatchRefunded(uint256 indexed challengeId);

    function getGenesisBinding(uint256 challengeId) external view returns (GenesisBinding memory binding, bool authorized) {
        return (genesisBindings[challengeId], genesisAuthorized[challengeId]);
    }

    function genesisAuthorizationDigest(uint256 challengeId, uint256 slot) public view returns (bytes32) {
        require(slot == 1 || slot == 2, "wrong slot");
        require(genesisBindings[challengeId].p2 != address(0), "not joined");
        return keccak256(abi.encode(GENESIS_AUTHORIZATION_TAG, challenges[challengeId].matchContextHash, slot));
    }

    function authorizeGenesis(uint256 challengeId, bytes calldata p1Signature, bytes calldata p2Signature) external {
        Challenge storage c = challenges[challengeId];
        require(c.status == MatchStatus.Active, "not active");
        require(!genesisAuthorized[challengeId], "genesis already authorized");
        require(block.timestamp <= genesisAuthorizationDeadline[challengeId], "authorization expired");
        require(_recover(genesisAuthorizationDigest(challengeId, 1), p1Signature) == c.p1SessionKey, "bad P1 authorization");
        require(_recover(genesisAuthorizationDigest(challengeId, 2), p2Signature) == c.p2SessionKey, "bad P2 authorization");
        genesisAuthorized[challengeId] = true;
        emit GenesisAuthorized(challengeId, c.matchId, c.matchContextHash);
    }

    function refundUnactivatedMatch(uint256 challengeId) external nonReentrant {
        Challenge storage c = challenges[challengeId];
        require(c.status == MatchStatus.Active, "not active");
        require(!genesisAuthorized[challengeId], "genesis already authorized");
        require(block.timestamp > genesisAuthorizationDeadline[challengeId], "authorization window open");
        uint256 refund = c.stake;
        c.stake = 0;
        c.status = MatchStatus.Cancelled;
        emit UnactivatedMatchRefunded(challengeId);
        _safeTransfer(c.p1, refund);
        _safeTransfer(c.p2, refund);
    }

    struct PlayerStats {
        uint64 matchesCreated;
        uint64 matchesJoined;
        uint256 totalStakePlayed;
        uint64 lastActiveAt;
    }

    uint64 public constant MIN_RESPONSE_WINDOW_SECONDS = 24 hours;

    uint256 public nextChallengeId = 1;
    mapping(uint256 => Challenge) internal challenges;
    mapping(address => PlayerStats) public playerStats;

    /// @notice Full challenge record (auto-getter omitted: struct is too large to unpack).
    function getChallenge(uint256 challengeId) external view returns (Challenge memory) {
        return challenges[challengeId];
    }

    bool private locked;

    event ChallengeCreated(
        uint256 indexed challengeId,
        address indexed challenger,
        uint256 stake,
        bytes32 matchId,
        bytes32 rulesHash,
        bytes32 matchContextHash,
        address p1SessionKey,
        address restrictedOpponent,
        uint64 responseWindowSeconds
    );

    event ChallengeJoined(
        uint256 indexed challengeId,
        address indexed joiner,
        address p2SessionKey
    );

    event ChallengeCancelled(uint256 indexed challengeId);

    modifier nonReentrant() {
        require(!locked, "reentrant");
        locked = true;
        _;
        locked = false;
    }

    /// @param matchId Client-generated bytes32 the session keys sign packets against.
    /// @param p1SessionKey Challenger's ephemeral session-key address (delegated by this tx).
    /// @param expectedOpponent Optional P2 main wallet lock; address(0) leaves the match open.
    function challenge(
        bytes32 matchId,
        bytes32 rulesHash,
        address p1SessionKey,
        address expectedOpponent,
        uint64 responseWindowSeconds
    ) external payable returns (uint256 challengeId) {
        require(msg.value > 0, "stake required");
        require(matchId != bytes32(0), "matchId required");
        require(challengeForGenesis[matchId] == 0, "genesis already registered");
        require(rulesHash == CANONICAL_RULES_HASH, "unsupported canonical rules");
        require(p1SessionKey != address(0), "session key required");
        require(
            responseWindowSeconds >= MIN_RESPONSE_WINDOW_SECONDS,
            "response window too short"
        );

        challengeId = nextChallengeId++;
        challengeForGenesis[matchId] = challengeId;
        uint64 window = responseWindowSeconds;

        bytes32 matchContextHash = keccak256(
            abi.encode(
                block.chainid,
                address(this),
                challengeId,
                msg.sender,
                msg.value,
                matchId,
                rulesHash,
                p1SessionKey,
                window
            )
        );

        Challenge storage c = challenges[challengeId];
        c.p1 = payable(msg.sender);
        c.stake = msg.value;
        c.createdAt = uint64(block.timestamp);
        c.responseWindowSeconds = window;
        c.matchId = matchId;
        c.rulesHash = rulesHash;
        c.matchContextHash = matchContextHash;
        c.p1SessionKey = p1SessionKey;
        c.restrictedOpponent = expectedOpponent;
        c.status = MatchStatus.Open;

        PlayerStats storage s = playerStats[msg.sender];
        s.matchesCreated += 1;
        s.lastActiveAt = uint64(block.timestamp);

        emit ChallengeCreated(
            challengeId,
            msg.sender,
            msg.value,
            matchId,
            rulesHash,
            matchContextHash,
            p1SessionKey,
            expectedOpponent,
            window
        );
    }

    /// @param p2SessionKey Joiner's own ephemeral session-key address (delegated by this tx).
    function join(uint256 challengeId, address p2SessionKey) external payable {
        Challenge storage c = challenges[challengeId];
        require(c.status == MatchStatus.Open, "not open");
        require(msg.sender != c.p1, "cannot join self");
        require(msg.value == c.stake, "stake mismatch");
        require(p2SessionKey != address(0), "session key required");
        require(p2SessionKey != c.p1SessionKey, "distinct session keys required");
        require(
            c.restrictedOpponent == address(0) || c.restrictedOpponent == msg.sender,
            "opponent locked"
        );

        c.p2 = payable(msg.sender);
        c.joinedAt = uint64(block.timestamp);
        c.p2SessionKey = p2SessionKey;
        c.status = MatchStatus.Active;
        GenesisBinding memory binding = GenesisBinding(
            block.chainid, address(this), challengeId, c.matchId, c.rulesHash,
            c.p1, c.p2, c.p1SessionKey, c.p2SessionKey, c.stake,
            c.responseWindowSeconds, c.restrictedOpponent
        );
        genesisBindings[challengeId] = binding;
        c.matchContextHash = keccak256(abi.encode(GENESIS_BINDING_TAG, binding));
        genesisAuthorizationDeadline[challengeId] = uint64(block.timestamp) + c.responseWindowSeconds;

        PlayerStats storage p1Stats = playerStats[c.p1];
        PlayerStats storage p2Stats = playerStats[msg.sender];
        p1Stats.totalStakePlayed += c.stake;
        p2Stats.matchesJoined += 1;
        p2Stats.totalStakePlayed += msg.value;
        p1Stats.lastActiveAt = uint64(block.timestamp);
        p2Stats.lastActiveAt = uint64(block.timestamp);

        emit ChallengeJoined(challengeId, msg.sender, p2SessionKey);
    }

    function cancelOpenChallenge(uint256 challengeId) external nonReentrant {
        Challenge storage c = challenges[challengeId];
        require(c.status == MatchStatus.Open, "not open");
        require(msg.sender == c.p1, "only challenger");

        c.status = MatchStatus.Cancelled;
        uint256 refund = c.stake;
        c.stake = 0;

        emit ChallengeCancelled(challengeId);
        _safeTransfer(c.p1, refund);
    }

    function _traceContext(uint256 id) internal view override returns (address, address, bytes32, uint256) {
        Challenge storage c = challenges[id];
        require(c.status == MatchStatus.Active, "not active");
        require(genesisAuthorized[id], "genesis not authorized");
        return (c.p1, c.p2, c.matchContextHash, c.responseWindowSeconds);
    }

    function _traceEvidence(uint256 id) internal view override returns (bytes32, address, address) {
        Challenge storage c = challenges[id];
        require(c.status == MatchStatus.Active && genesisAuthorized[id], "inactive evidence context");
        return (c.matchId, c.p1SessionKey, c.p2SessionKey);
    }

    function _safeTransfer(address payable to, uint256 amount) internal {
        if (amount == 0) return;
        (bool ok, ) = to.call{value: amount}("");
        require(ok, "transfer failed");
    }
}
