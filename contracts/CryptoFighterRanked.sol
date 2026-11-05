// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";

/// @notice Ranked CFC streak state and Fibonacci reward policy.
/// @dev The arena is the sole operator; ownership controls only future offers.
contract CryptoFighterRanked is Ownable2Step {
    error InvalidAddress();
    error UnauthorizedOperator(address caller);
    error UnauthorizedPendingOperator(address caller);
    error RankedCreationPaused();
    error IneligibleOpponent(address p1, address p2);
    error PlayerAlreadyRanked(address player, uint256 challengeId);
    error StaleRankedOffer(uint256 expectedStreak, uint256 p1Streak, uint256 p2Streak);
    error WrongActiveMatch(address player, uint256 expected, uint256 actual);
    error RewardOverflow(uint256 streak);
    error InvalidResult(uint8 result);
    error OwnershipRenunciationDisabled();

    uint256 public constant CFC_UNIT = 1 ether;
    uint256 public constant MAX_REWARD_STREAK = 283;

    enum OfferStatus { None, Open, Active, Cancelled, Settled }
    struct RankedOffer {
        address p1;
        address p2;
        uint256 startingStreak;
        uint256 rewardAmount;
        uint64 policyVersion;
        OfferStatus status;
        uint8 result;
    }

    address public operator;
    address public pendingOperator;
    uint64 public currentPolicyVersion = 1;
    bool public creationPaused;

    mapping(address => uint256) public rankedStreak;
    mapping(address => uint256) public activeRankedMatch;
    mapping(uint256 => RankedOffer) public rankedOffers;

    event OperatorTransferStarted(address indexed currentOperator, address indexed pendingOperator);
    event OperatorTransferred(address indexed previousOperator, address indexed newOperator);
    event PolicyVersionPublished(uint64 indexed policyVersion);
    event RankedCreationPauseChanged(bool paused);
    event RankedOfferPrepared(
        uint256 indexed challengeId, address indexed p1, address indexed p2,
        uint256 startingStreak, uint256 rewardAmount, uint64 policyVersion
    );
    event RankedOfferJoined(uint256 indexed challengeId, address indexed p2);
    event RankedOfferReleased(uint256 indexed challengeId);
    event RankedSettled(
        uint256 indexed challengeId, uint8 result,
        address indexed p1, uint256 p1Streak, address indexed p2, uint256 p2Streak
    );

    modifier onlyOperator() {
        if (msg.sender != operator) revert UnauthorizedOperator(msg.sender);
        _;
    }

    constructor(address initialOwner, address initialOperator) Ownable(initialOwner) {
        require(block.chainid == 31337, "prototype: local chain only");
        if (initialOperator == address(0)) revert InvalidAddress();
        operator = initialOperator;
        emit OperatorTransferred(address(0), initialOperator);
    }

    function beginOperatorTransfer(address newOperator) external onlyOwner {
        if (newOperator == address(0)) revert InvalidAddress();
        pendingOperator = newOperator;
        emit OperatorTransferStarted(operator, newOperator);
    }

    function acceptOperator() external {
        if (msg.sender != pendingOperator) revert UnauthorizedPendingOperator(msg.sender);
        address previous = operator;
        operator = msg.sender;
        pendingOperator = address(0);
        emit OperatorTransferred(previous, msg.sender);
    }

    function setCreationPaused(bool paused) external onlyOwner {
        creationPaused = paused;
        emit RankedCreationPauseChanged(paused);
    }

    function publishPolicyVersion() external onlyOwner returns (uint64 version) {
        version = currentPolicyVersion + 1;
        currentPolicyVersion = version;
        emit PolicyVersionPublished(version);
    }

    function fibonacciReward(uint256 startingStreak) public pure returns (uint256) {
        if (startingStreak > MAX_REWARD_STREAK) revert RewardOverflow(startingStreak);
        uint256 previous = 1;
        uint256 current = 1;
        for (uint256 streak = 2; streak <= startingStreak; ++streak) {
            uint256 next = previous + current;
            previous = current;
            current = next;
        }
        if (current > type(uint256).max / CFC_UNIT) revert RewardOverflow(startingStreak);
        return current * CFC_UNIT;
    }

    function nextReward(address player) external view returns (uint256) {
        return fibonacciReward(rankedStreak[player]);
    }

    function eligibility(address p1, address p2)
        external
        view
        returns (bool eligible, uint256 startingStreak, uint256 rewardAmount, uint64 policyVersion)
    {
        startingStreak = rankedStreak[p1];
        policyVersion = currentPolicyVersion;
        if (
            creationPaused || p1 == address(0) || p2 == address(0) || p1 == p2
                || activeRankedMatch[p1] != 0 || activeRankedMatch[p2] != 0
                || rankedStreak[p2] != startingStreak || startingStreak > MAX_REWARD_STREAK
        ) return (false, startingStreak, 0, policyVersion);
        return (true, startingStreak, fibonacciReward(startingStreak), policyVersion);
    }

    function prepareOffer(uint256 challengeId, address p1, address p2)
        external
        onlyOperator
        returns (uint256 startingStreak, uint256 rewardAmount, uint64 policyVersion)
    {
        if (creationPaused) revert RankedCreationPaused();
        if (p1 == address(0) || p2 == address(0) || p1 == p2) revert IneligibleOpponent(p1, p2);
        if (activeRankedMatch[p1] != 0) revert PlayerAlreadyRanked(p1, activeRankedMatch[p1]);
        if (activeRankedMatch[p2] != 0) revert PlayerAlreadyRanked(p2, activeRankedMatch[p2]);
        startingStreak = rankedStreak[p1];
        if (rankedStreak[p2] != startingStreak) {
            revert StaleRankedOffer(startingStreak, startingStreak, rankedStreak[p2]);
        }
        rewardAmount = fibonacciReward(startingStreak);
        policyVersion = currentPolicyVersion;
        activeRankedMatch[p1] = challengeId;
        rankedOffers[challengeId] = RankedOffer(
            p1, p2, startingStreak, rewardAmount, policyVersion, OfferStatus.Open, 0
        );
        emit RankedOfferPrepared(challengeId, p1, p2, startingStreak, rewardAmount, policyVersion);
    }

    function joinOffer(uint256 challengeId, address p1, address p2) external onlyOperator {
        RankedOffer storage offer = rankedOffers[challengeId];
        uint256 startingStreak = offer.startingStreak;
        if (offer.status != OfferStatus.Open || offer.p1 != p1 || offer.p2 != p2) {
            revert IneligibleOpponent(p1, p2);
        }
        _requireActive(p1, challengeId);
        if (activeRankedMatch[p2] != 0) revert PlayerAlreadyRanked(p2, activeRankedMatch[p2]);
        uint256 p1Streak = rankedStreak[p1];
        uint256 p2Streak = rankedStreak[p2];
        if (p1Streak != startingStreak || p2Streak != startingStreak) {
            revert StaleRankedOffer(startingStreak, p1Streak, p2Streak);
        }
        activeRankedMatch[p2] = challengeId;
        offer.status = OfferStatus.Active;
        emit RankedOfferJoined(challengeId, p2);
    }

    function releaseOpenOffer(uint256 challengeId, address p1) external onlyOperator {
        _requireActive(p1, challengeId);
        activeRankedMatch[p1] = 0;
        rankedOffers[challengeId].status = OfferStatus.Cancelled;
        emit RankedOfferReleased(challengeId);
    }

    function releaseJoinedMatch(uint256 challengeId, address p1, address p2) external onlyOperator {
        _requireActive(p1, challengeId);
        _requireActive(p2, challengeId);
        activeRankedMatch[p1] = 0;
        activeRankedMatch[p2] = 0;
        rankedOffers[challengeId].status = OfferStatus.Cancelled;
        emit RankedOfferReleased(challengeId);
    }

    /// @param result 1=P1 win, 2=P2 win, 3=verified draw, 4=no established result.
    function settle(uint256 challengeId, address p1, address p2, uint8 result)
        external
        onlyOperator
    {
        RankedOffer storage offer = rankedOffers[challengeId];
        if (offer.status != OfferStatus.Active || offer.p1 != p1 || offer.p2 != p2) {
            revert IneligibleOpponent(p1, p2);
        }
        uint256 startingStreak = offer.startingStreak;
        _requireActive(p1, challengeId);
        _requireActive(p2, challengeId);
        activeRankedMatch[p1] = 0;
        activeRankedMatch[p2] = 0;
        if (result == 1) {
            rankedStreak[p1] = startingStreak + 1;
            rankedStreak[p2] = 0;
        } else if (result == 2) {
            rankedStreak[p1] = 0;
            rankedStreak[p2] = startingStreak + 1;
        } else if (result == 4) {
            rankedStreak[p1] = 0;
            rankedStreak[p2] = 0;
        } else if (result != 3) {
            revert InvalidResult(result);
        }
        offer.status = OfferStatus.Settled;
        offer.result = result;
        emit RankedSettled(challengeId, result, p1, rankedStreak[p1], p2, rankedStreak[p2]);
    }

    function renounceOwnership() public view override onlyOwner {
        revert OwnershipRenunciationDisabled();
    }

    function _requireActive(address player, uint256 challengeId) private view {
        uint256 actual = activeRankedMatch[player];
        if (actual != challengeId) revert WrongActiveMatch(player, challengeId, actual);
    }
}
