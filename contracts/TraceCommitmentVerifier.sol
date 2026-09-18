// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @notice Pure membership primitive for the fixed 301-checkpoint trace format.
/// @dev Membership is not execution validity or payout authorization. The calling
///      arena must supply its frozen genesis binding hash and committed root.
contract TraceCommitmentVerifier {
    struct Checkpoint {
        bytes32 stateHash;
        bytes32 frameHead;
        bytes32 p1Head;
        bytes32 p2Head;
        bytes32 p1PreviousHead;
        bytes32 p2PreviousHead;
    }
    bytes32 private constant CHECKPOINT_TAG = keccak256("CryptoFighter:experimental-offchain-trace-v1:checkpoint");
    bytes32 private constant LEAF_TAG = keccak256("CryptoFighter:experimental-offchain-trace-v1:leaf");
    bytes32 private constant NODE_TAG = keccak256("CryptoFighter:experimental-offchain-trace-v1:node");

    function hashCheckpoint(Checkpoint calldata checkpoint) public pure returns (bytes32) {
        return keccak256(abi.encode(CHECKPOINT_TAG, checkpoint));
    }

    function verifyOpening(
        bytes32 root,
        bytes32 contextHash,
        uint256 index,
        Checkpoint calldata checkpoint,
        bytes32[] calldata siblings
    ) public pure returns (bool) {
        if (index > 300 || siblings.length != 9) return false;
        bytes32 current = keccak256(abi.encode(LEAF_TAG, contextHash, index, hashCheckpoint(checkpoint)));
        for (uint256 depth = 0; depth < 9; depth++) {
            current = index % 2 == 0
                ? keccak256(abi.encode(NODE_TAG, current, siblings[depth]))
                : keccak256(abi.encode(NODE_TAG, siblings[depth], current));
            index /= 2;
        }
        return current == root;
    }
}
