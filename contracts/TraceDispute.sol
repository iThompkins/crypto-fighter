// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "./GameTransitionVerifier.sol";

/// @notice Authenticated bisection only; no payout or replacement-result authority.
abstract contract TraceDispute is TraceCommitmentVerifier, GameTypes {
    struct Opening { Checkpoint checkpoint; bytes32[] siblings; }
    enum TracePhase { None, Claimed, Bisecting, Adjacent, Resolved }
    enum StepVerdict { None, Claimant, Challenger, Neither }
    enum EvidenceFaultKind { None, InvalidInput, Equivocation }
    struct TraceGame {
        TracePhase phase;
        address claimant;
        address challenger;
        bytes32 claimantRoot;
        bytes32 challengerRoot;
        bytes32 contextHash;
        uint256 deadline;
        uint256 window;
        uint256 low;
        uint256 high;
        uint256 round;
        bytes32 agreed;
        bytes32 claimantUpper;
        bytes32 challengerUpper;
        bytes32 claimantMid;
        bytes32 challengerMid;
        uint8 responded;
        uint256 finalFrame;
        uint8 outcome;
        StepVerdict verdict;
        bytes32 canonicalPost;
    }
    mapping(uint256 => TraceGame) internal traceGames;
    GameTransitionVerifier public immutable transitionVerifier;
    mapping(bytes32 => bool) public provenEvidenceFaults;
    mapping(uint256 => mapping(address => mapping(bytes32 => bytes32))) public traceArchiveHashes;
    event TraceClaimed(uint256 indexed id, address indexed claimant, bytes32 root, uint256 deadline);
    event TraceChallenged(uint256 indexed id, address indexed challenger, bytes32 root, uint256 deadline);
    event TraceMidpoint(uint256 indexed id, uint256 round, address indexed participant, bytes32 checkpointHash);
    event TraceBracket(uint256 indexed id, uint256 low, uint256 high, bytes32 agreed, bytes32 claimantUpper, bytes32 challengerUpper, uint256 deadline);
    event TraceAdjudicated(uint256 indexed id, uint256 frame, StepVerdict verdict, bytes32 canonicalPost, bytes32 canonicalStateHash);
    event EvidenceFaultProven(uint256 indexed id, bytes32 indexed faultId, EvidenceFaultKind kind, uint256 player, uint256 frame, bytes32 packetA, bytes32 packetB);
    event TraceArchivePublished(uint256 indexed id, address indexed participant, bytes32 indexed root, bytes32 journalHash);

    constructor() {
        transitionVerifier = new GameTransitionVerifier();
    }

    function getTraceGame(uint256 id) external view returns (TraceGame memory) { return traceGames[id]; }
    function hashTraceState(TraceState memory s) public view returns (bytes32) {
        return transitionVerifier.hashTraceState(s);
    }
    function genesisCheckpointHash() public view returns (bytes32) {
        TraceState memory s;
        s.timer = 300;
        s.p1 = FighterState(30720,52224,0,7,1,0,0);
        s.p2 = FighterState(146432,52224,0,7,-1,0,0);
        return keccak256(abi.encode(
            keccak256("CryptoFighter:fixed-point-trace-v2:checkpoint"),
            hashTraceState(s), bytes32(0), bytes32(0), bytes32(0), bytes32(0), bytes32(0)
        ));
    }
    // Hook authenticates the active escrow, activation, participants and exclusivity.
    function _traceContext(uint256 id) internal view virtual returns (address p1, address p2, bytes32 context, uint256 window);
    function _traceEvidence(uint256 id) internal view virtual returns (bytes32 matchId, address p1Signer, address p2Signer);

    function _recover(bytes32 digest, bytes memory signature) internal view returns (address) {
        return transitionVerifier.recoverDigest(digest, signature);
    }

    function _recoverPacket(SignedPacket memory packet) internal view returns (address) {
        return transitionVerifier.recoverPacket(packet);
    }

    function _packetDigest(SignedPacket memory packet) internal view returns (bytes32) {
        return transitionVerifier.packetDigest(packet);
    }

    function _opening(bytes32 root, bytes32 context, uint256 index, Opening calldata o) internal pure returns (bytes32) {
        require(verifyOpening(root, context, index, o.checkpoint, o.siblings), "invalid trace opening");
        return hashCheckpoint(o.checkpoint);
    }

    /// @notice Bind a trace root to the exact retained Phase C journal archive.
    /// @dev This is an integrity locator only; it does not prove delivery or availability.
    function publishTraceArchive(uint256 id, bytes32 root, bytes32 journalHash) external {
        (address p1, address p2,,) = _traceContext(id);
        require(msg.sender == p1 || msg.sender == p2, "not participant");
        require(root != bytes32(0) && journalHash != bytes32(0), "empty archive commitment");
        bytes32 existing = traceArchiveHashes[id][msg.sender][root];
        require(existing == bytes32(0) || existing == journalHash, "archive commitment conflict");
        if (existing == bytes32(0)) {
            traceArchiveHashes[id][msg.sender][root] = journalHash;
            emit TraceArchivePublished(id, msg.sender, root, journalHash);
        }
    }
    function claimTrace(uint256 id, bytes32 root, Opening calldata genesis, Opening calldata endpoint, TraceState calldata terminalState) external {
        (address p1, address p2, bytes32 context, uint256 window) = _traceContext(id);
        require(msg.sender == p1 || msg.sender == p2, "not participant");
        TraceGame storage g = traceGames[id];
        require(g.phase == TracePhase.None, "trace already claimed");
        require(_opening(root, context, 0, genesis) == genesisCheckpointHash(), "wrong genesis checkpoint");
        bytes32 upper = _opening(root, context, 300, endpoint);
        require(terminalState.terminal && terminalState.frame > 0 && terminalState.frame <= 300, "invalid terminal frame");
        require(terminalState.outcome > 0 && terminalState.outcome <= 3, "invalid terminal outcome");
        require(hashTraceState(terminalState) == endpoint.checkpoint.stateHash, "terminal state mismatch");
        // Execution/normalization is still optimistic; opening the endpoint alone
        // does not prove the terminal state was reached by the claimed frame.
        g.phase = TracePhase.Claimed;
        g.claimant = msg.sender;
        g.contextHash = context;
        g.claimantRoot = root;
        g.window = window;
        g.deadline = block.timestamp + window;
        g.high = 300;
        g.agreed = genesisCheckpointHash();
        g.claimantUpper = upper;
        g.finalFrame = terminalState.frame;
        g.outcome = terminalState.outcome;
        emit TraceClaimed(id, msg.sender, root, g.deadline);
    }
    function challengeTrace(uint256 id, bytes32 root, Opening calldata genesis, Opening calldata endpoint) external {
        (address p1, address p2,,) = _traceContext(id);
        TraceGame storage g = traceGames[id];
        require(g.phase == TracePhase.Claimed, "trace not challengeable");
        require(msg.sender == (g.claimant == p1 ? p2 : p1), "only trace opponent");
        require(block.timestamp <= g.deadline, "trace deadline passed");
        require(_opening(root, g.contextHash, 0, genesis) == g.agreed, "wrong genesis checkpoint");
        bytes32 upper = _opening(root, g.contextHash, 300, endpoint);
        require(upper != g.claimantUpper, "trace endpoints equal");
        g.phase = TracePhase.Bisecting;
        g.challenger = msg.sender;
        g.challengerRoot = root;
        g.challengerUpper = upper;
        g.deadline = block.timestamp + g.window;
        emit TraceChallenged(id, msg.sender, root, g.deadline);
    }
    function revealMidpoint(uint256 id, uint256 round, Opening calldata midpoint) external {
        TraceGame storage g = traceGames[id];
        require(g.phase == TracePhase.Bisecting, "not bisecting");
        require(round == g.round, "wrong trace round");
        require(block.timestamp <= g.deadline, "trace deadline passed");
        bool claimant = msg.sender == g.claimant;
        require(claimant || msg.sender == g.challenger, "not trace participant");
        uint8 bit = claimant ? 1 : 2;
        require(g.responded & bit == 0, "already revealed");
        uint256 mid = (g.low + g.high) / 2;
        bytes32 h = _opening(claimant ? g.claimantRoot : g.challengerRoot, g.contextHash, mid, midpoint);
        if (claimant) g.claimantMid = h; else g.challengerMid = h;
        g.responded |= bit;
        emit TraceMidpoint(id, g.round, msg.sender, h);
        // One round has one shared clock: the first response cannot extend it.
        if (g.responded != 3) return;
        if (g.claimantMid == g.challengerMid) {
            g.low = mid;
            g.agreed = g.claimantMid;
        } else {
            g.high = mid;
            g.claimantUpper = g.claimantMid;
            g.challengerUpper = g.challengerMid;
        }
        g.round++;
        g.responded = 0;
        g.claimantMid = bytes32(0);
        g.challengerMid = bytes32(0);
        g.deadline = block.timestamp + g.window;
        if (g.high == g.low + 1) g.phase = TracePhase.Adjacent;
        emit TraceBracket(id, g.low, g.high, g.agreed, g.claimantUpper, g.challengerUpper, g.deadline);
    }

    /// @notice Resolve the isolated transition without assigning funds or a match winner.
    function adjudicateStep(
        uint256 id,
        Opening calldata beforeOpening,
        TraceState calldata beforeState,
        SignedPacket calldata p1,
        SignedPacket calldata p2,
        Opening calldata claimantAfter,
        Opening calldata challengerAfter
    ) external {
        TraceGame storage g = traceGames[id];
        require(g.phase == TracePhase.Adjacent, "transition not isolated");
        require(msg.sender == g.claimant || msg.sender == g.challenger, "not trace participant");
        require(block.timestamp <= g.deadline, "trace deadline passed");
        require(beforeState.frame == g.low, "wrong pre-state frame");
        bytes32 beforeHash = _opening(g.claimantRoot, g.contextHash, g.low, beforeOpening);
        require(beforeHash == g.agreed, "wrong agreed checkpoint");
        require(hashTraceState(beforeState) == beforeOpening.checkpoint.stateHash, "pre-state mismatch");
        transitionVerifier.assertState(beforeState);
        require(_opening(g.claimantRoot, g.contextHash, g.high, claimantAfter) == g.claimantUpper, "wrong claimant checkpoint");
        require(_opening(g.challengerRoot, g.contextHash, g.high, challengerAfter) == g.challengerUpper, "wrong challenger checkpoint");

        bytes32 canonicalStateHash;
        bytes32 canonicalPost;
        if (beforeState.terminal) {
            canonicalStateHash = hashTraceState(beforeState);
            canonicalPost = hashCheckpoint(beforeOpening.checkpoint);
        } else {
            (bytes32 matchId, address p1Signer, address p2Signer) = _traceEvidence(id);
            (Checkpoint memory checkpoint, bytes32 stateHash) = transitionVerifier.executionCheckpoint(
                matchId, beforeOpening.checkpoint, beforeState, p1, p2, p1Signer, p2Signer, g.high
            );
            canonicalStateHash = stateHash;
            canonicalPost = hashCheckpoint(checkpoint);
        }
        bool claimantValid = canonicalPost == g.claimantUpper;
        bool challengerValid = canonicalPost == g.challengerUpper;
        StepVerdict verdict = claimantValid ? StepVerdict.Claimant : challengerValid ? StepVerdict.Challenger : StepVerdict.Neither;
        g.phase = TracePhase.Resolved;
        g.verdict = verdict;
        g.canonicalPost = canonicalPost;
        emit TraceAdjudicated(id, g.high, verdict, canonicalPost, canonicalStateHash);
    }

    function proveInvalidInput(uint256 id, SignedPacket calldata packet) external returns (bytes32 faultId) {
        (bytes32 matchId, address p1Signer, address p2Signer) = _traceEvidence(id);
        require(packet.matchId == matchId, "wrong match");
        require(packet.player == 1 || packet.player == 2, "wrong slot");
        require(packet.frame > 0 && packet.frame <= 302, "wrong frame");
        require((packet.inputMask & ~KNOWN_INPUT_MASK) != 0, "input is valid");
        require(_recoverPacket(packet) == (packet.player == 1 ? p1Signer : p2Signer), "bad packet sig");
        bytes32 packetHash = _packetDigest(packet);
        faultId = keccak256(abi.encode(id, EvidenceFaultKind.InvalidInput, packetHash));
        require(!provenEvidenceFaults[faultId], "fault already proven");
        provenEvidenceFaults[faultId] = true;
        emit EvidenceFaultProven(id, faultId, EvidenceFaultKind.InvalidInput, packet.player, packet.frame, packetHash, bytes32(0));
    }

    function proveEquivocation(uint256 id, SignedPacket calldata a, SignedPacket calldata b) external returns (bytes32 faultId) {
        (bytes32 matchId, address p1Signer, address p2Signer) = _traceEvidence(id);
        require(a.matchId == matchId && b.matchId == matchId, "wrong match");
        require(a.player == b.player && (a.player == 1 || a.player == 2), "wrong slot");
        require(a.frame == b.frame && a.frame > 0 && a.frame <= 302, "wrong frame");
        bytes32 aHash = _packetDigest(a);
        bytes32 bHash = _packetDigest(b);
        require(aHash != bHash, "duplicate packet");
        address signer = a.player == 1 ? p1Signer : p2Signer;
        require(_recoverPacket(a) == signer && _recoverPacket(b) == signer, "bad packet sig");
        (bytes32 low, bytes32 high) = aHash < bHash ? (aHash, bHash) : (bHash, aHash);
        faultId = keccak256(abi.encode(id, EvidenceFaultKind.Equivocation, low, high));
        require(!provenEvidenceFaults[faultId], "fault already proven");
        provenEvidenceFaults[faultId] = true;
        emit EvidenceFaultProven(id, faultId, EvidenceFaultKind.Equivocation, a.player, a.frame, low, high);
    }
}
