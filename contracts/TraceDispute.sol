// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "./TraceCommitmentVerifier.sol";

/// @notice Authenticated bisection only; no payout or replacement-result authority.
abstract contract TraceDispute is TraceCommitmentVerifier {
    struct TraceState {
        uint256 frame;
        uint256 timer;
        bool terminal;
        uint8 outcome;
        int256[9] p1;
        int256[9] p2;
    }
    struct Opening { Checkpoint checkpoint; bytes32[] siblings; }
    enum TracePhase { None, Claimed, Bisecting, Adjacent }
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
    }
    mapping(uint256 => TraceGame) internal traceGames;
    bytes32 internal constant STATE_TAG = keccak256("CryptoFighter:experimental-offchain-trace-v1:state");
    event TraceClaimed(uint256 indexed id, address indexed claimant, bytes32 root, uint256 deadline);
    event TraceChallenged(uint256 indexed id, address indexed challenger, bytes32 root, uint256 deadline);
    event TraceMidpoint(uint256 indexed id, uint256 round, address indexed participant, bytes32 checkpointHash);
    event TraceBracket(uint256 indexed id, uint256 low, uint256 high, bytes32 agreed, bytes32 claimantUpper, bytes32 challengerUpper, uint256 deadline);

    function getTraceGame(uint256 id) external view returns (TraceGame memory) { return traceGames[id]; }
    function hashTraceState(TraceState memory s) public pure returns (bytes32) {
        return keccak256(abi.encode(STATE_TAG, s));
    }
    function genesisCheckpointHash() public pure returns (bytes32) {
        TraceState memory s;
        s.timer = 300;
        s.p1 = [int256(240),408,56,112,7,1,0,0,0];
        s.p2 = [int256(1144),408,56,112,7,-1,0,0,0];
        return keccak256(abi.encode(
            keccak256("CryptoFighter:experimental-offchain-trace-v1:checkpoint"),
            hashTraceState(s), bytes32(0), bytes32(0), bytes32(0), bytes32(0), bytes32(0)
        ));
    }
    // Hook authenticates the active escrow, activation, participants and exclusivity.
    function _traceContext(uint256 id) internal view virtual returns (address p1, address p2, bytes32 context, uint256 window);

    function _opening(bytes32 root, bytes32 context, uint256 index, Opening calldata o) internal pure returns (bytes32) {
        require(verifyOpening(root, context, index, o.checkpoint, o.siblings), "invalid trace opening");
        return hashCheckpoint(o.checkpoint);
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
}
