// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @notice Escrow, dispute, and reputation skeleton for Crypto Fighter.
/// @dev This intentionally does not replay the whole match on-chain yet.
///      Normal path: both players sign a final result and settle cheaply.
///      Dispute path: one player claims timeout from a transcript head; the other
///      must continue the signed chain before the deadline or forfeit.
contract CryptoFighterArena {
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
        bytes32 rulesHash;
        bytes32 matchContextHash;
        bytes32 p1SessionKeyHash;
        bytes32 p2SessionKeyHash;
        bytes32 latestTranscriptHead;
        MatchStatus status;
        address timeoutClaimant;
        address timeoutAccused;
        uint32 timeoutFrame;
        uint64 timeoutDeadline;
        bytes32 timeoutTranscriptHead;
        bytes32 timeoutPacketHash;
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
        uint256 totalStakePlayed;
        uint64 lastActiveAt;
    }

    uint64 public constant DEFAULT_RESPONSE_WINDOW_SECONDS = 24 hours;

    uint256 public nextChallengeId = 1;
    mapping(uint256 => Challenge) public challenges;
    mapping(address => PlayerStats) public playerStats;

    bool private locked;

    event ChallengeCreated(
        uint256 indexed challengeId,
        address indexed challenger,
        uint256 stake,
        bytes32 rulesHash,
        bytes32 matchContextHash,
        bytes32 p1SessionKeyHash,
        uint64 responseWindowSeconds
    );

    event ChallengeJoined(
        uint256 indexed challengeId,
        address indexed joiner,
        bytes32 p2SessionKeyHash
    );

    event FinalResultSubmitted(
        uint256 indexed challengeId,
        address indexed submitter,
        Outcome outcome,
        uint32 finalFrame,
        bytes32 finalFrameHash,
        bytes32 finalStateHash,
        bytes32 transcriptHead
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

    function challenge(
        bytes32 rulesHash,
        bytes32 p1SessionKeyHash,
        uint64 responseWindowSeconds
    ) external payable returns (uint256 challengeId) {
        require(msg.value > 0, "stake required");
        require(rulesHash != bytes32(0), "rulesHash required");
        require(p1SessionKeyHash != bytes32(0), "session key required");

        challengeId = nextChallengeId++;
        uint64 window = responseWindowSeconds == 0
            ? DEFAULT_RESPONSE_WINDOW_SECONDS
            : responseWindowSeconds;

        bytes32 matchContextHash = keccak256(
            abi.encode(
                block.chainid,
                address(this),
                challengeId,
                msg.sender,
                msg.value,
                rulesHash,
                p1SessionKeyHash,
                window
            )
        );

        challenges[challengeId] = Challenge({
            p1: payable(msg.sender),
            p2: payable(address(0)),
            stake: msg.value,
            createdAt: uint64(block.timestamp),
            joinedAt: 0,
            responseWindowSeconds: window,
            rulesHash: rulesHash,
            matchContextHash: matchContextHash,
            p1SessionKeyHash: p1SessionKeyHash,
            p2SessionKeyHash: bytes32(0),
            latestTranscriptHead: bytes32(0),
            status: MatchStatus.Open,
            timeoutClaimant: address(0),
            timeoutAccused: address(0),
            timeoutFrame: 0,
            timeoutDeadline: 0,
            timeoutTranscriptHead: bytes32(0),
            timeoutPacketHash: bytes32(0)
        });

        PlayerStats storage s = playerStats[msg.sender];
        s.matchesCreated += 1;
        s.lastActiveAt = uint64(block.timestamp);

        emit ChallengeCreated(
            challengeId,
            msg.sender,
            msg.value,
            rulesHash,
            matchContextHash,
            p1SessionKeyHash,
            window
        );
    }

    function join(uint256 challengeId, bytes32 p2SessionKeyHash) external payable {
        Challenge storage c = challenges[challengeId];
        require(c.status == MatchStatus.Open, "not open");
        require(msg.sender != c.p1, "cannot join self");
        require(msg.value == c.stake, "stake mismatch");
        require(p2SessionKeyHash != bytes32(0), "session key required");

        c.p2 = payable(msg.sender);
        c.joinedAt = uint64(block.timestamp);
        c.p2SessionKeyHash = p2SessionKeyHash;
        c.status = MatchStatus.Active;
        c.matchContextHash = keccak256(
            abi.encode(c.matchContextHash, msg.sender, p2SessionKeyHash)
        );

        PlayerStats storage p1Stats = playerStats[c.p1];
        PlayerStats storage p2Stats = playerStats[msg.sender];
        p1Stats.totalStakePlayed += c.stake;
        p2Stats.matchesJoined += 1;
        p2Stats.totalStakePlayed += msg.value;
        p1Stats.lastActiveAt = uint64(block.timestamp);
        p2Stats.lastActiveAt = uint64(block.timestamp);

        emit ChallengeJoined(challengeId, msg.sender, p2SessionKeyHash);
    }

    /// @notice Cheap happy-path settlement.
    /// @dev TODO: verify p1FinalSig and p2FinalSig against player wallet addresses.
    ///      For browser session keys, either use wallet signatures for the final result,
    ///      use secp256k1 session keys, or deploy on a chain with a P-256 verifier/precompile.
    function submitFinalResult(
        uint256 challengeId,
        Outcome outcome,
        uint32 finalFrame,
        bytes32 finalFrameHash,
        bytes32 finalStateHash,
        bytes32 transcriptHead,
        bytes calldata p1FinalSig,
        bytes calldata p2FinalSig
    ) external nonReentrant onlyParticipant(challengeId) {
        Challenge storage c = challenges[challengeId];
        require(c.status == MatchStatus.Active, "not active");
        require(outcome == Outcome.P1 || outcome == Outcome.P2 || outcome == Outcome.Tie, "bad outcome");
        require(finalFrameHash != bytes32(0), "frame hash required");
        require(finalStateHash != bytes32(0), "state hash required");
        require(transcriptHead != bytes32(0), "transcript head required");
        require(p1FinalSig.length > 0 && p2FinalSig.length > 0, "both final sigs required");

        // Placeholder until final result signature format is finalized.
        // bytes32 digest = finalResultDigest(...);
        // require(_recover(digest, p1FinalSig) == c.p1, "bad P1 sig");
        // require(_recover(digest, p2FinalSig) == c.p2, "bad P2 sig");

        c.latestTranscriptHead = transcriptHead;
        emit FinalResultSubmitted(
            challengeId,
            msg.sender,
            outcome,
            finalFrame,
            finalFrameHash,
            finalStateHash,
            transcriptHead
        );

        _finalize(challengeId, outcome);
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
