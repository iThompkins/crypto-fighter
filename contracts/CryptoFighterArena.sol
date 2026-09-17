// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @notice Escrow, dispute, and reputation skeleton for Crypto Fighter.
/// @dev This intentionally does not replay the whole match on-chain yet.
///      Result claims are optimistic and remain experimental until an execution
///      proof can distinguish canonical continuation from delayed pre-signed inputs.
contract CryptoFighterArena {
    /// @notice Identifies the sole canonical game version; never match configuration.
    /// @dev Must equal src/protocol.ts. Deployment tests check byte-for-byte parity.
    bytes32 public constant CANONICAL_RULES_HASH =
        0x1ae89ee81810335d8b8b2ee8d7e9237fef05704a9fae836f3e748fcafdca65cc;
    /// @dev Temporary containment, not a settlement security proof. No override.
    ///      This prototype must only be exercised with valueless local test funds.
    constructor() {
        require(block.chainid == 31337, "prototype: local chain only");
    }

    enum MatchStatus {
        None,
        Open,
        Active,
        Finalized,
        Cancelled
    }

    enum Outcome {
        None,
        P1,
        P2,
        Tie
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
        bytes32 latestTranscriptHead;
        MatchStatus status;
        // Optimistic settlement claim (no opponent co-signature required).
        address resultClaimant;
        Outcome claimedOutcome;
        uint32 claimedFinalFrame;
        bytes32 claimedFinalHead;
        bytes32 claimedP1Head;
        bytes32 claimedP2Head;
        uint64 resultDeadline;
        address timeoutClaimant;
        address timeoutAccused;
        uint32 timeoutFrame;
        uint64 timeoutDeadline;
        bytes32 timeoutTranscriptHead;
        bytes32 timeoutPacketHash;
    }

    /// @notice A per-frame input packet signed by a player's session key.
    /// @dev Digest matches the client/verifier exactly:
    ///      keccak256(abi.encode(matchId, frame, player, inputMask, prevSelfHash, prevOppHash)).
    struct SignedPacket {
        bytes32 matchId;
        uint256 frame;
        uint256 player;
        uint256 inputMask;
        bytes32 prevSelfHash;
        bytes32 prevOppHash;
        bytes signature;
    }

    struct PlayerStats {
        uint64 matchesCreated;
        uint64 matchesJoined;
        uint64 matchesFinalized;
        uint64 wins;
        uint64 losses;
        uint64 ties;
        uint64 timeoutClaimsMade;
        uint64 timeoutClaimsReceived;
        uint64 timeoutResponses;
        uint64 timeoutForfeits;
        uint64 falseResultClaims;
        uint64 resultDisputesWon;
        uint256 totalStakePlayed;
        uint64 lastActiveAt;
    }

    uint64 public constant MIN_RESPONSE_WINDOW_SECONDS = 24 hours;
    uint256 internal constant KNOWN_INPUT_MASK = 0x0f;

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

    event ResultClaimed(
        uint256 indexed challengeId,
        address indexed claimant,
        Outcome outcome,
        uint32 finalFrame,
        bytes32 finalHead,
        uint64 deadline
    );

    event ResultDisputed(
        uint256 indexed challengeId,
        address indexed disputer,
        address indexed slashedClaimant,
        uint32 continuedFrame
    );

    event MatchFinalized(
        uint256 indexed challengeId,
        Outcome outcome,
        address indexed winner,
        uint256 payout
    );

    event TimeoutClaimed(
        uint256 indexed challengeId,
        address indexed claimant,
        address indexed accused,
        uint32 frame,
        bytes32 transcriptHead,
        bytes32 packetHash,
        uint64 deadline
    );

    event TimeoutResponded(
        uint256 indexed challengeId,
        address indexed responder,
        uint32 frame,
        bytes32 transcriptHead,
        bytes32 packetHash
    );

    event TimeoutForfeited(
        uint256 indexed challengeId,
        address indexed forfeiter,
        address indexed beneficiary,
        uint32 frame
    );

    event ChallengeCancelled(uint256 indexed challengeId);

    modifier nonReentrant() {
        require(!locked, "reentrant");
        locked = true;
        _;
        locked = false;
    }

    modifier onlyParticipant(uint256 challengeId) {
        Challenge storage c = challenges[challengeId];
        require(msg.sender == c.p1 || msg.sender == c.p2, "not participant");
        _;
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
        require(rulesHash == CANONICAL_RULES_HASH, "unsupported canonical rules");
        require(p1SessionKey != address(0), "session key required");
        require(
            responseWindowSeconds >= MIN_RESPONSE_WINDOW_SECONDS,
            "response window too short"
        );

        challengeId = nextChallengeId++;
        // A result claim is always challengeable for at least 24 hours. Until
        // the execution-proof protocol is complete, shortening this window
        // would let an unverified claim finalize before an opponent can react.
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
        require(
            c.restrictedOpponent == address(0) || c.restrictedOpponent == msg.sender,
            "opponent locked"
        );

        c.p2 = payable(msg.sender);
        c.joinedAt = uint64(block.timestamp);
        c.p2SessionKey = p2SessionKey;
        c.status = MatchStatus.Active;
        c.matchContextHash = keccak256(
            abi.encode(c.matchContextHash, msg.sender, p2SessionKey)
        );

        PlayerStats storage p1Stats = playerStats[c.p1];
        PlayerStats storage p2Stats = playerStats[msg.sender];
        p1Stats.totalStakePlayed += c.stake;
        p2Stats.matchesJoined += 1;
        p2Stats.totalStakePlayed += msg.value;
        p1Stats.lastActiveAt = uint64(block.timestamp);
        p2Stats.lastActiveAt = uint64(block.timestamp);

        emit ChallengeJoined(challengeId, msg.sender, p2SessionKey);
    }

    /// @notice Optimistically claim the match result without an opponent co-signature
    ///         or proof that the claimed state was executed. The signed packets accepted
    ///         by disputeResult authenticate session keys and chain fields only; delayed
    ///         pre-signed packets can satisfy that check without proving execution.
    /// @param finalHead Canonical frame hash at the claimed final frame.
    /// @param p1Head/p2Head Each player's packet-chain head at the claimed final frame,
    ///        used to bind a continuation disproof.
    function claimResult(
        uint256 challengeId,
        Outcome outcome,
        uint32 finalFrame,
        bytes32 finalHead,
        bytes32 p1Head,
        bytes32 p2Head
    ) external onlyParticipant(challengeId) {
        Challenge storage c = challenges[challengeId];
        require(c.status == MatchStatus.Active, "not active");
        require(c.resultClaimant == address(0), "claim already active");
        require(c.timeoutDeadline == 0, "timeout active");
        require(
            outcome == Outcome.P1 || outcome == Outcome.P2 || outcome == Outcome.Tie,
            "bad outcome"
        );
        require(finalHead != bytes32(0), "final head required");

        c.resultClaimant = msg.sender;
        c.claimedOutcome = outcome;
        c.claimedFinalFrame = finalFrame;
        c.claimedFinalHead = finalHead;
        c.claimedP1Head = p1Head;
        c.claimedP2Head = p2Head;
        c.resultDeadline = uint64(block.timestamp) + c.responseWindowSeconds;
        c.latestTranscriptHead = finalHead;

        playerStats[msg.sender].lastActiveAt = uint64(block.timestamp);

        emit ResultClaimed(challengeId, msg.sender, outcome, finalFrame, finalHead, c.resultDeadline);
    }

    /// @notice Finalize an unchallenged result claim after the inclusive dispute window elapses.
    function finalizeResult(uint256 challengeId) external nonReentrant {
        Challenge storage c = challenges[challengeId];
        require(c.status == MatchStatus.Active, "not active");
        require(c.resultClaimant != address(0), "no claim");
        require(block.timestamp > c.resultDeadline, "window open");

        _finalize(challengeId, c.claimedOutcome);
    }

    /// @notice Challenge a result claim with a packet pair for the frame *after* the
    ///         claimed final frame, signed by the two committed session keys.
    /// @dev Packet existence authenticates the signers and checked chain fields but does
    ///      not prove that the packets were executed or that the claimed state was terminal.
    function disputeResult(
        uint256 challengeId,
        SignedPacket calldata p1Next,
        SignedPacket calldata p2Next
    ) external nonReentrant onlyParticipant(challengeId) {
        Challenge storage c = challenges[challengeId];
        require(c.status == MatchStatus.Active, "not active");
        require(c.resultClaimant != address(0), "no claim");
        require(block.timestamp <= c.resultDeadline, "window closed");
        require(msg.sender != c.resultClaimant, "claimant cannot dispute");

        uint256 nextFrame = uint256(c.claimedFinalFrame) + 1;
        require(p1Next.frame == nextFrame && p2Next.frame == nextFrame, "wrong frame");
        require(p1Next.player == 1 && p2Next.player == 2, "wrong slots");
        require(p1Next.matchId == c.matchId && p2Next.matchId == c.matchId, "wrong match");
        require((p1Next.inputMask & ~KNOWN_INPUT_MASK) == 0, "invalid input mask");
        require((p2Next.inputMask & ~KNOWN_INPUT_MASK) == 0, "invalid input mask");

        // Each revealed packet must self-chain onto the claimant's committed
        // packet head for that player at the final frame. A valid signature over
        // a packet chaining past the claimed end satisfies this narrow dispute
        // condition; it does not prove execution. (Opponent-ack linkage spans
        // INPUT_DELAY frames and isn't checked here.)
        require(p1Next.prevSelfHash == c.claimedP1Head, "p1 self chain");
        require(p2Next.prevSelfHash == c.claimedP2Head, "p2 self chain");

        require(_recoverPacket(p1Next) == c.p1SessionKey, "bad P1 sig");
        require(_recoverPacket(p2Next) == c.p2SessionKey, "bad P2 sig");

        // The claim is disputed under the accepted packet condition; this is not
        // proof that the packets executed or that the claimant's outcome was false.
        address slashed = c.resultClaimant;
        playerStats[slashed].falseResultClaims += 1;
        playerStats[msg.sender].resultDisputesWon += 1;

        emit ResultDisputed(challengeId, msg.sender, slashed, uint32(nextFrame));

        _finalize(challengeId, msg.sender == c.p1 ? Outcome.P1 : Outcome.P2);
    }

    /// @dev Packet digest, byte-identical to the client and off-chain verifier.
    function _packetDigest(SignedPacket calldata p) internal pure returns (bytes32) {
        return keccak256(
            abi.encode(p.matchId, p.frame, p.player, p.inputMask, p.prevSelfHash, p.prevOppHash)
        );
    }

    function _recoverPacket(SignedPacket calldata p) internal pure returns (address) {
        return _recover(_packetDigest(p), p.signature);
    }

    /// @dev Recover the signer of a 65-byte (r||s||v) secp256k1 signature over `digest`.
    function _recover(bytes32 digest, bytes memory sig) internal pure returns (address) {
        require(sig.length == 65, "bad sig len");
        bytes32 r;
        bytes32 s;
        uint8 v;
        assembly ("memory-safe") {
            r := mload(add(sig, 32))
            s := mload(add(sig, 64))
            v := byte(0, mload(add(sig, 96)))
        }
        return ecrecover(digest, v, r, s);
    }

    /// @notice Start an on-chain timeout clock when the opponent stops continuing the packet chain.
    /// @dev The contract does not decide who was laggy. It asks whether the accused can continue
    ///      from the claimed transcript point before the deadline.
    function claimTimeout(
        uint256 challengeId,
        uint32 frame,
        bytes32 transcriptHead,
        bytes32 packetHash
    ) external onlyParticipant(challengeId) {
        Challenge storage c = challenges[challengeId];
        require(c.status == MatchStatus.Active, "not active");
        require(c.timeoutDeadline == 0, "timeout already active");
        require(frame > 0, "frame required");
        require(transcriptHead != bytes32(0), "transcript head required");
        require(packetHash != bytes32(0), "packet hash required");

        address accused = msg.sender == c.p1 ? c.p2 : c.p1;
        require(accused != address(0), "missing opponent");

        c.timeoutClaimant = msg.sender;
        c.timeoutAccused = accused;
        c.timeoutFrame = frame;
        c.timeoutTranscriptHead = transcriptHead;
        c.timeoutPacketHash = packetHash;
        c.timeoutDeadline = uint64(block.timestamp) + c.responseWindowSeconds;
        c.latestTranscriptHead = transcriptHead;

        playerStats[msg.sender].timeoutClaimsMade += 1;
        playerStats[accused].timeoutClaimsReceived += 1;
        playerStats[msg.sender].lastActiveAt = uint64(block.timestamp);

        emit TimeoutClaimed(
            challengeId,
            msg.sender,
            accused,
            frame,
            transcriptHead,
            packetHash,
            c.timeoutDeadline
        );
    }

    /// @notice Accused player proves liveness by continuing from the claimed chain point.
    /// @dev TODO: verify transcriptHead/packetHash relation once packet commitment format is finalized.
    function respondTimeout(
        uint256 challengeId,
        uint32 frame,
        bytes32 transcriptHead,
        bytes32 packetHash
    ) external onlyParticipant(challengeId) {
        Challenge storage c = challenges[challengeId];
        require(c.status == MatchStatus.Active, "not active");
        require(c.timeoutDeadline != 0, "no active timeout");
        require(msg.sender == c.timeoutAccused, "only accused");
        require(block.timestamp <= c.timeoutDeadline, "deadline passed");
        require(frame >= c.timeoutFrame, "frame regressed");
        require(transcriptHead != bytes32(0), "transcript head required");
        require(packetHash != bytes32(0), "packet hash required");

        c.latestTranscriptHead = transcriptHead;
        c.timeoutClaimant = address(0);
        c.timeoutAccused = address(0);
        c.timeoutFrame = 0;
        c.timeoutDeadline = 0;
        c.timeoutTranscriptHead = bytes32(0);
        c.timeoutPacketHash = bytes32(0);

        playerStats[msg.sender].timeoutResponses += 1;
        playerStats[msg.sender].lastActiveAt = uint64(block.timestamp);

        emit TimeoutResponded(challengeId, msg.sender, frame, transcriptHead, packetHash);
    }

    function forfeitTimeout(uint256 challengeId) external nonReentrant {
        Challenge storage c = challenges[challengeId];
        require(c.status == MatchStatus.Active, "not active");
        require(c.timeoutDeadline != 0, "no active timeout");
        require(block.timestamp > c.timeoutDeadline, "deadline not passed");

        address forfeiter = c.timeoutAccused;
        address beneficiary = c.timeoutClaimant;
        require(beneficiary != address(0) && forfeiter != address(0), "bad timeout");

        playerStats[forfeiter].timeoutForfeits += 1;
        emit TimeoutForfeited(challengeId, forfeiter, beneficiary, c.timeoutFrame);

        _finalize(challengeId, beneficiary == c.p1 ? Outcome.P1 : Outcome.P2);
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

    function _finalize(uint256 challengeId, Outcome outcome) internal {
        Challenge storage c = challenges[challengeId];
        require(c.status == MatchStatus.Active, "not active");

        c.status = MatchStatus.Finalized;
        uint256 pot = c.stake * 2;
        c.stake = 0;

        PlayerStats storage p1Stats = playerStats[c.p1];
        PlayerStats storage p2Stats = playerStats[c.p2];
        p1Stats.matchesFinalized += 1;
        p2Stats.matchesFinalized += 1;
        p1Stats.lastActiveAt = uint64(block.timestamp);
        p2Stats.lastActiveAt = uint64(block.timestamp);

        address winner = address(0);
        if (outcome == Outcome.P1) {
            winner = c.p1;
            p1Stats.wins += 1;
            p2Stats.losses += 1;
            _safeTransfer(c.p1, pot);
        } else if (outcome == Outcome.P2) {
            winner = c.p2;
            p2Stats.wins += 1;
            p1Stats.losses += 1;
            _safeTransfer(c.p2, pot);
        } else {
            p1Stats.ties += 1;
            p2Stats.ties += 1;
            _safeTransfer(c.p1, pot / 2);
            _safeTransfer(c.p2, pot - (pot / 2));
        }

        emit MatchFinalized(challengeId, outcome, winner, pot);
    }

    function _safeTransfer(address payable to, uint256 amount) internal {
        if (amount == 0) return;
        (bool ok, ) = to.call{value: amount}("");
        require(ok, "transfer failed");
    }
}
