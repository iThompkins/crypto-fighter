// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "./TraceCommitmentVerifier.sol";

abstract contract GameTypes {
    uint256 internal constant KNOWN_INPUT_MASK = 0x0f;
    struct FighterState {
        int32 x;
        int32 y;
        int32 vy;
        uint8 hp;
        int8 facing;
        uint8 attackCooldown;
        uint8 attackActive;
    }

    struct TraceState {
        uint16 frame;
        uint16 timer;
        bool terminal;
        uint8 outcome;
        FighterState p1;
        FighterState p2;
    }

    struct SignedPacket {
        bytes32 matchId;
        uint256 frame;
        uint256 player;
        uint256 inputMask;
        bytes32 prevSelfHash;
        bytes32 prevOppHash;
        bytes signature;
    }
}

/// @notice Canonical one-step rules and authenticated packet primitives.
/// @dev This contract assigns no payout, penalty, or match winner. Its only
///      result is the checkpoint implied by one pre-state and packet pair.
contract GameTransitionVerifier is TraceCommitmentVerifier, GameTypes {

    struct Rect {
        int256 x;
        int256 y;
        int256 w;
        int256 h;
    }

    bytes32 internal constant STATE_TAG = keccak256("CryptoFighter:fixed-point-trace-v2:state");
    bytes32 internal constant CHECKPOINT_TAG = keccak256("CryptoFighter:fixed-point-trace-v2:checkpoint");
    int256 internal constant WIDTH = 184320;
    int256 internal constant FIGHTER_W = 7168;
    int256 internal constant FIGHTER_H = 14336;
    int256 internal constant GROUND_Y = 52224;
    int256 internal constant MOVE_SPEED = 1280;
    int256 internal constant JUMP_VELOCITY = 5632;
    int256 internal constant GRAVITY = 512;
    int256 internal constant ATTACK_W = 4608;
    int256 internal constant ATTACK_H = 3584;
    int256 internal constant ATTACK_REACH = 5632;

    function hashTraceState(TraceState memory s) public pure returns (bytes32) {
        return keccak256(abi.encode(STATE_TAG, s));
    }

    function packetDigest(SignedPacket memory p) public pure returns (bytes32) {
        return keccak256(abi.encode(p.matchId, p.frame, p.player, p.inputMask, p.prevSelfHash, p.prevOppHash));
    }

    function recoverDigest(bytes32 digest, bytes calldata signature) external pure returns (address) {
        return _recover(digest, signature);
    }

    function recoverPacket(SignedPacket calldata packet) external pure returns (address) {
        return _recoverPacket(packet);
    }

    function assertState(TraceState calldata state) external pure {
        _assertState(state);
    }

    function executeTransition(TraceState calldata state, uint256 p1Mask, uint256 p2Mask)
        external pure returns (TraceState memory)
    {
        return _transition(state, p1Mask, p2Mask);
    }

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
        require(v == 27 || v == 28, "bad recovery id");
        require(
            uint256(s) > 0 &&
                uint256(s) <= 0x7fffffffffffffffffffffffffffffff5d576e7357a4501ddfe92f46681b20a0,
            "noncanonical signature"
        );
        return ecrecover(digest, v, r, s);
    }

    function _recoverPacket(SignedPacket memory p) internal pure returns (address) {
        return _recover(packetDigest(p), p.signature);
    }

    function _assertState(TraceState memory s) internal pure {
        require(s.frame <= 300 && s.timer == 300 - s.frame, "invalid state clock");
        _assertFighter(s.p1);
        _assertFighter(s.p2);
        bool terminal = s.p1.hp == 0 || s.p2.hp == 0 || s.timer == 0;
        uint8 outcome = !terminal ? 0 : s.p1.hp == s.p2.hp ? 3 : s.p1.hp > s.p2.hp ? 1 : 2;
        require(s.terminal == terminal && s.outcome == outcome, "invalid state outcome");
        if (s.frame == 0) {
            require(
                s.p1.x == 30720 && s.p1.y == GROUND_Y && s.p1.vy == 0 && s.p1.hp == 7 &&
                    s.p1.facing == 1 && s.p1.attackCooldown == 0 && s.p1.attackActive == 0 &&
                s.p2.x == 146432 && s.p2.y == GROUND_Y && s.p2.vy == 0 && s.p2.hp == 7 &&
                    s.p2.facing == -1 && s.p2.attackCooldown == 0 && s.p2.attackActive == 0,
                "invalid genesis state"
            );
        }
    }

    function _assertFighter(FighterState memory f) private pure {
        require(f.x >= 0 && int256(f.x) <= WIDTH - FIGHTER_W, "invalid fighter x");
        require(f.y >= 24064 && int256(f.y) <= GROUND_Y, "invalid fighter y");
        require(f.vy >= -5120 && f.vy <= 5120, "invalid fighter vy");
        require(int256(f.y) % GRAVITY == 0 && int256(f.vy) % GRAVITY == 0, "invalid vertical lattice");
        require(f.hp <= 7 && (f.facing == 1 || f.facing == -1), "invalid fighter identity");
        require(f.attackCooldown <= 10 && f.attackActive <= 4, "invalid attack counters");
        require(
            f.attackActive > 0
                ? f.attackCooldown == f.attackActive + 6
                : f.attackCooldown <= 6,
            "invalid attack relation"
        );
    }

    function _clampX(int256 x) private pure returns (int32) {
        if (x < 0) return 0;
        int256 maxX = WIDTH - FIGHTER_W;
        if (x > maxX) return int32(maxX);
        return int32(x);
    }

    function _roundHalfToEven(uint256 n) private pure returns (int32) {
        require(n <= uint256(2 * WIDTH), "midpoint overflow");
        uint256 q = n / 2;
        return int32(int256(q + (n % 2) * (q % 2)));
    }

    function _moveVertical(FighterState memory f, bool jump) private pure returns (FighterState memory) {
        if (jump && int256(f.y) >= GROUND_Y) f.vy = int32(-JUMP_VELOCITY);
        f.vy = int32(int256(f.vy) + GRAVITY);
        f.y = int32(int256(f.y) + int256(f.vy));
        if (int256(f.y) >= GROUND_Y) {
            f.y = int32(GROUND_Y);
            f.vy = 0;
        }
        return f;
    }

    function _separate(TraceState memory s) private pure returns (TraceState memory) {
        bool vertical = int256(s.p1.y) < int256(s.p2.y) + FIGHTER_H &&
            int256(s.p1.y) + FIGHTER_H > int256(s.p2.y);
        bool p1Left = s.p1.x <= s.p2.x;
        FighterState memory left = p1Left ? s.p1 : s.p2;
        FighterState memory right = p1Left ? s.p2 : s.p1;
        if (vertical && int256(right.x) < int256(left.x) + FIGHTER_W) {
            int32 center = _roundHalfToEven(uint256(int256(left.x) + int256(right.x) + FIGHTER_W));
            right.x = center;
            left.x = int32(int256(center) - FIGHTER_W);
            if (left.x < 0) {
                left.x = 0;
                right.x = int32(FIGHTER_W);
            }
            int32 maxRight = int32(WIDTH - FIGHTER_W);
            if (right.x > maxRight) {
                right.x = maxRight;
                left.x = int32(int256(maxRight) - FIGHTER_W);
            }
            if (p1Left) { s.p1 = left; s.p2 = right; }
            else { s.p2 = left; s.p1 = right; }
        }
        return s;
    }

    function _attackRect(FighterState memory f) private pure returns (Rect memory r, bool active) {
        if (f.attackActive == 0) return (r, false);
        r.y = int256(f.y) + FIGHTER_H / 2 - ATTACK_H / 2;
        r.w = ATTACK_W + ATTACK_REACH;
        r.h = ATTACK_H;
        r.x = f.facing == 1 ? int256(f.x) + FIGHTER_W : int256(f.x) - r.w;
        return (r, true);
    }

    function _overlap(Rect memory a, FighterState memory f) private pure returns (bool) {
        return a.x < int256(f.x) + FIGHTER_W && a.x + a.w > int256(f.x) &&
            a.y < int256(f.y) + FIGHTER_H && a.y + a.h > int256(f.y);
    }

    function _transition(TraceState memory previous, uint256 p1Mask, uint256 p2Mask)
        internal pure returns (TraceState memory s)
    {
        _assertState(previous);
        require((p1Mask & ~KNOWN_INPUT_MASK) == 0 && (p2Mask & ~KNOWN_INPUT_MASK) == 0, "invalid input mask");
        if (previous.terminal) return previous;
        s = previous;
        s.frame += 1;
        s.timer -= 1;
        if (s.p1.attackCooldown > 0) s.p1.attackCooldown -= 1;
        if (s.p2.attackCooldown > 0) s.p2.attackCooldown -= 1;
        if (s.p1.attackActive > 0) s.p1.attackActive -= 1;
        if (s.p2.attackActive > 0) s.p2.attackActive -= 1;

        int256 p1Move = (p1Mask & 1 != 0 ? -MOVE_SPEED : int256(0)) + (p1Mask & 2 != 0 ? MOVE_SPEED : int256(0));
        int256 p2Move = (p2Mask & 1 != 0 ? -MOVE_SPEED : int256(0)) + (p2Mask & 2 != 0 ? MOVE_SPEED : int256(0));
        s.p1.x = _clampX(int256(s.p1.x) + p1Move);
        s.p2.x = _clampX(int256(s.p2.x) + p2Move);
        s.p1 = _moveVertical(s.p1, p1Mask & 8 != 0);
        s.p2 = _moveVertical(s.p2, p2Mask & 8 != 0);
        s = _separate(s);
        if (p1Move > 0) s.p1.facing = 1;
        else if (p1Move < 0) s.p1.facing = -1;
        if (p2Move > 0) s.p2.facing = 1;
        else if (p2Move < 0) s.p2.facing = -1;

        if (p1Mask & 4 != 0 && s.p1.attackCooldown == 0 && s.p1.attackActive == 0) {
            s.p1.attackActive = 4;
            s.p1.attackCooldown = 10;
        }
        if (p2Mask & 4 != 0 && s.p2.attackCooldown == 0 && s.p2.attackActive == 0) {
            s.p2.attackActive = 4;
            s.p2.attackCooldown = 10;
        }
        (Rect memory p1Attack, bool p1Active) = _attackRect(s.p1);
        (Rect memory p2Attack, bool p2Active) = _attackRect(s.p2);
        bool p1Hits = p1Active && _overlap(p1Attack, s.p2);
        bool p2Hits = p2Active && _overlap(p2Attack, s.p1);
        if (p1Hits && s.p2.hp > 0) s.p2.hp -= 1;
        if (p2Hits && s.p1.hp > 0) s.p1.hp -= 1;

        if (s.p1.hp == 0 && s.p2.hp == 0) { s.terminal = true; s.outcome = 3; }
        else if (s.p1.hp == 0) { s.terminal = true; s.outcome = 2; }
        else if (s.p2.hp == 0) { s.terminal = true; s.outcome = 1; }
        else if (s.timer == 0) {
            s.terminal = true;
            s.outcome = s.p1.hp == s.p2.hp ? 3 : s.p1.hp > s.p2.hp ? 1 : 2;
        }
        _assertState(s);
    }

    function _executionCheckpoint(
        bytes32 matchId,
        Checkpoint memory beforeCheckpoint,
        TraceState memory beforeState,
        SignedPacket memory p1,
        SignedPacket memory p2,
        address p1Signer,
        address p2Signer,
        uint256 frame
    ) internal pure returns (Checkpoint memory afterCheckpoint, bytes32 stateHash) {
        require(p1.matchId == matchId && p2.matchId == matchId, "wrong match");
        require(p1.frame == frame && p2.frame == frame, "wrong frame");
        require(p1.player == 1 && p2.player == 2, "wrong slots");
        require((p1.inputMask & ~KNOWN_INPUT_MASK) == 0 && (p2.inputMask & ~KNOWN_INPUT_MASK) == 0, "invalid input mask");
        require(p1.prevSelfHash == beforeCheckpoint.p1Head && p2.prevSelfHash == beforeCheckpoint.p2Head, "broken self chain");
        require(p1.prevOppHash == beforeCheckpoint.p2PreviousHead && p2.prevOppHash == beforeCheckpoint.p1PreviousHead, "broken acknowledgement chain");
        require(_recoverPacket(p1) == p1Signer, "bad P1 sig");
        require(_recoverPacket(p2) == p2Signer, "bad P2 sig");
        TraceState memory afterState = _transition(beforeState, p1.inputMask, p2.inputMask);
        stateHash = hashTraceState(afterState);
        bytes32 p1Hash = packetDigest(p1);
        bytes32 p2Hash = packetDigest(p2);
        afterCheckpoint = Checkpoint({
            stateHash: stateHash,
            frameHead: keccak256(abi.encode(matchId, frame, p1.inputMask, p2.inputMask, beforeCheckpoint.frameHead)),
            p1Head: p1Hash,
            p2Head: p2Hash,
            p1PreviousHead: beforeCheckpoint.p1Head,
            p2PreviousHead: beforeCheckpoint.p2Head
        });
    }

    function executionCheckpoint(
        bytes32 matchId,
        Checkpoint calldata beforeCheckpoint,
        TraceState calldata beforeState,
        SignedPacket calldata p1,
        SignedPacket calldata p2,
        address p1Signer,
        address p2Signer,
        uint256 frame
    ) external pure returns (Checkpoint memory afterCheckpoint, bytes32 stateHash) {
        return _executionCheckpoint(matchId, beforeCheckpoint, beforeState, p1, p2, p1Signer, p2Signer, frame);
    }
}
