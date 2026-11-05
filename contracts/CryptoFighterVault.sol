// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/// @notice Segregated CFC accounting for rewards, escrow, player credits, and
///         owner-controlled settled treasury funds.
/// @dev The operator is intended to become the arena. This increment exposes
///      the accounting interface without enabling settlement in the arena.
contract CryptoFighterVault is Ownable2Step, ReentrancyGuard {
    using SafeERC20 for IERC20;

    error InvalidAddress();
    error InvalidAmount();
    error InvalidIdentifier();
    error UnauthorizedOperator(address caller);
    error UnauthorizedPendingOperator(address caller);
    error RewardAlreadyReserved(bytes32 reservationId);
    error RewardNotReserved(bytes32 reservationId);
    error InsufficientAvailableRewards(uint256 available, uint256 requested);
    error InsufficientEscrow(bytes32 matchId, address player, uint256 available, uint256 requested);
    error InsufficientPlayerCredit(address player, uint256 available, uint256 requested);
    error InsufficientTreasury(uint256 available, uint256 requested);
    error InsufficientExcess(uint256 available, uint256 requested);
    error UnexpectedTransferAmount(uint256 expected, uint256 received);
    error OwnershipRenunciationDisabled();

    IERC20 public immutable cfc;

    address public operator;
    address public pendingOperator;

    uint256 public availableRewards;
    uint256 public totalReservedRewards;
    uint256 public totalActiveEscrow;
    uint256 public settledTreasury;
    uint256 public totalPlayerCredits;

    mapping(bytes32 => uint256) public rewardReservations;
    mapping(bytes32 => mapping(address => uint256)) public activeEscrow;
    mapping(address => uint256) public playerCredits;

    event OperatorTransferStarted(address indexed currentOperator, address indexed pendingOperator);
    event OperatorTransferred(address indexed previousOperator, address indexed newOperator);
    event RewardFunded(address indexed funder, uint256 amount);
    event RewardReserved(bytes32 indexed reservationId, uint256 amount);
    event RewardReleased(bytes32 indexed reservationId, uint256 amount);
    event RewardCredited(bytes32 indexed reservationId, address indexed player, uint256 amount);
    event EscrowDeposited(bytes32 indexed matchId, address indexed player, uint256 amount);
    event EscrowCredited(bytes32 indexed matchId, address indexed player, uint256 amount);
    event EscrowForfeited(bytes32 indexed matchId, address indexed player, uint256 amount);
    event TreasuryDeposited(address indexed depositor, uint256 amount);
    event TreasuryWithdrawn(address indexed recipient, uint256 amount);
    event AvailableRewardsWithdrawn(address indexed recipient, uint256 amount);
    event PlayerCreditWithdrawn(address indexed player, address indexed recipient, uint256 amount);
    event ExcessRecovered(address indexed recipient, uint256 amount);

    modifier onlyOperator() {
        if (msg.sender != operator) revert UnauthorizedOperator(msg.sender);
        _;
    }

    constructor(IERC20 cfcToken, address initialOwner, address initialOperator)
        Ownable(initialOwner)
    {
        require(block.chainid == 31337, "prototype: local chain only");
        if (address(cfcToken) == address(0) || address(cfcToken).code.length == 0) {
            revert InvalidAddress();
        }
        if (initialOperator == address(0)) revert InvalidAddress();
        cfc = cfcToken;
        operator = initialOperator;
        emit OperatorTransferred(address(0), initialOperator);
    }

    function accountedBalance() public view returns (uint256) {
        return availableRewards
            + totalReservedRewards
            + totalActiveEscrow
            + settledTreasury
            + totalPlayerCredits;
    }

    function excessBalance() public view returns (uint256) {
        uint256 balance = cfc.balanceOf(address(this));
        uint256 accounted = accountedBalance();
        return balance > accounted ? balance - accounted : 0;
    }

    function accountingSolvent() external view returns (bool) {
        return cfc.balanceOf(address(this)) >= accountedBalance();
    }

    function beginOperatorTransfer(address newOperator) external onlyOwner {
        if (newOperator == address(0)) revert InvalidAddress();
        pendingOperator = newOperator;
        emit OperatorTransferStarted(operator, newOperator);
    }

    function cancelOperatorTransfer() external onlyOwner {
        pendingOperator = address(0);
        emit OperatorTransferStarted(operator, address(0));
    }

    function acceptOperator() external {
        if (msg.sender != pendingOperator) revert UnauthorizedPendingOperator(msg.sender);
        address previous = operator;
        operator = msg.sender;
        pendingOperator = address(0);
        emit OperatorTransferred(previous, msg.sender);
    }

    function fundRewards(uint256 amount) external nonReentrant {
        _requireAmount(amount);
        _pullExact(msg.sender, amount);
        availableRewards += amount;
        emit RewardFunded(msg.sender, amount);
    }

    function reserveReward(bytes32 reservationId, uint256 amount) external onlyOperator {
        _requireIdentifier(reservationId);
        _requireAmount(amount);
        if (rewardReservations[reservationId] != 0) {
            revert RewardAlreadyReserved(reservationId);
        }
        if (availableRewards < amount) {
            revert InsufficientAvailableRewards(availableRewards, amount);
        }
        availableRewards -= amount;
        totalReservedRewards += amount;
        rewardReservations[reservationId] = amount;
        emit RewardReserved(reservationId, amount);
    }

    function releaseReward(bytes32 reservationId) external onlyOperator returns (uint256 amount) {
        amount = _takeReservation(reservationId);
        availableRewards += amount;
        emit RewardReleased(reservationId, amount);
    }

    function creditReward(bytes32 reservationId, address player) external onlyOperator returns (uint256 amount) {
        _requireAddress(player);
        amount = _takeReservation(reservationId);
        playerCredits[player] += amount;
        totalPlayerCredits += amount;
        emit RewardCredited(reservationId, player, amount);
    }

    function depositEscrow(bytes32 matchId, address player, uint256 amount)
        external
        onlyOperator
        nonReentrant
    {
        _requireIdentifier(matchId);
        _requireAddress(player);
        _requireAmount(amount);
        _pullExact(player, amount);
        activeEscrow[matchId][player] += amount;
        totalActiveEscrow += amount;
        emit EscrowDeposited(matchId, player, amount);
    }

    function creditEscrow(bytes32 matchId, address player, uint256 amount) external onlyOperator {
        _takeEscrow(matchId, player, amount);
        playerCredits[player] += amount;
        totalPlayerCredits += amount;
        emit EscrowCredited(matchId, player, amount);
    }

    function forfeitEscrow(bytes32 matchId, address player, uint256 amount) external onlyOperator {
        _takeEscrow(matchId, player, amount);
        settledTreasury += amount;
        emit EscrowForfeited(matchId, player, amount);
    }

    function depositTreasury(uint256 amount) external nonReentrant {
        _requireAmount(amount);
        _pullExact(msg.sender, amount);
        settledTreasury += amount;
        emit TreasuryDeposited(msg.sender, amount);
    }

    function withdrawCredit(address recipient, uint256 amount) external nonReentrant {
        _requireAddress(recipient);
        _requireAmount(amount);
        uint256 available = playerCredits[msg.sender];
        if (available < amount) {
            revert InsufficientPlayerCredit(msg.sender, available, amount);
        }
        playerCredits[msg.sender] = available - amount;
        totalPlayerCredits -= amount;
        cfc.safeTransfer(recipient, amount);
        emit PlayerCreditWithdrawn(msg.sender, recipient, amount);
    }

    function withdrawTreasury(address recipient, uint256 amount) external onlyOwner nonReentrant {
        _requireAddress(recipient);
        _requireAmount(amount);
        if (settledTreasury < amount) {
            revert InsufficientTreasury(settledTreasury, amount);
        }
        settledTreasury -= amount;
        cfc.safeTransfer(recipient, amount);
        emit TreasuryWithdrawn(recipient, amount);
    }

    function withdrawAvailableRewards(address recipient, uint256 amount) external onlyOwner nonReentrant {
        _requireAddress(recipient);
        _requireAmount(amount);
        if (availableRewards < amount) {
            revert InsufficientAvailableRewards(availableRewards, amount);
        }
        availableRewards -= amount;
        cfc.safeTransfer(recipient, amount);
        emit AvailableRewardsWithdrawn(recipient, amount);
    }

    function recoverExcess(address recipient, uint256 amount) external onlyOwner nonReentrant {
        _requireAddress(recipient);
        _requireAmount(amount);
        uint256 available = excessBalance();
        if (available < amount) revert InsufficientExcess(available, amount);
        cfc.safeTransfer(recipient, amount);
        emit ExcessRecovered(recipient, amount);
    }

    /// @dev Prevent accidentally locking treasury and reward administration.
    ///      Transfer ownership to a DAO/timelock instead.
    function renounceOwnership() public view override onlyOwner {
        revert OwnershipRenunciationDisabled();
    }

    function _takeReservation(bytes32 reservationId) private returns (uint256 amount) {
        amount = rewardReservations[reservationId];
        if (amount == 0) revert RewardNotReserved(reservationId);
        delete rewardReservations[reservationId];
        totalReservedRewards -= amount;
    }

    function _takeEscrow(bytes32 matchId, address player, uint256 amount) private {
        _requireIdentifier(matchId);
        _requireAddress(player);
        _requireAmount(amount);
        uint256 available = activeEscrow[matchId][player];
        if (available < amount) {
            revert InsufficientEscrow(matchId, player, available, amount);
        }
        activeEscrow[matchId][player] = available - amount;
        totalActiveEscrow -= amount;
    }

    function _pullExact(address from, uint256 amount) private {
        uint256 beforeBalance = cfc.balanceOf(address(this));
        cfc.safeTransferFrom(from, address(this), amount);
        uint256 received = cfc.balanceOf(address(this)) - beforeBalance;
        if (received != amount) revert UnexpectedTransferAmount(amount, received);
    }

    function _requireAddress(address value) private pure {
        if (value == address(0)) revert InvalidAddress();
    }

    function _requireAmount(uint256 value) private pure {
        if (value == 0) revert InvalidAmount();
    }

    function _requireIdentifier(bytes32 value) private pure {
        if (value == bytes32(0)) revert InvalidIdentifier();
    }
}
