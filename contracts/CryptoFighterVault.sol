// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {CryptoFighterCoin} from "./CryptoFighterCoin.sol";

/// @notice Segregated CFC accounting for gameplay credits, escrow, and treasury.
contract CryptoFighterVault is Ownable2Step, ReentrancyGuard {
    using SafeERC20 for IERC20;

    error InvalidAddress();
    error InvalidAmount();
    error InvalidIdentifier();
    error UnauthorizedOperator(address caller);
    error UnauthorizedPendingOperator(address caller);
    error GameplayRewardAlreadyCredited(bytes32 matchId);
    error InsufficientEscrow(bytes32 matchId, address player, uint256 available, uint256 requested);
    error InsufficientPlayerCredit(address player, uint256 available, uint256 requested);
    error InsufficientTreasury(uint256 available, uint256 requested);
    error InsufficientExcess(uint256 available, uint256 requested);
    error UnexpectedTransferAmount(uint256 expected, uint256 received);
    error OwnershipRenunciationDisabled();

    CryptoFighterCoin public immutable cfc;

    address public operator;
    address public pendingOperator;

    uint256 public totalActiveEscrow;
    uint256 public settledTreasury;
    uint256 public totalPlayerCredits;
    uint256 public totalGameplayRewardsCredited;

    mapping(bytes32 => uint256) public gameplayRewards;
    mapping(bytes32 => mapping(address => uint256)) public activeEscrow;
    mapping(address => uint256) public playerCredits;

    event OperatorTransferStarted(address indexed currentOperator, address indexed pendingOperator);
    event OperatorTransferred(address indexed previousOperator, address indexed newOperator);
    event GameplayRewardCredited(bytes32 indexed matchId, address indexed player, uint256 amount);
    event EscrowDeposited(bytes32 indexed matchId, address indexed player, uint256 amount);
    event EscrowCredited(bytes32 indexed matchId, address indexed player, uint256 amount);
    event EscrowForfeited(bytes32 indexed matchId, address indexed player, uint256 amount);
    event TreasuryDeposited(address indexed depositor, uint256 amount);
    event TreasuryWithdrawn(address indexed recipient, uint256 amount);
    event PlayerCreditWithdrawn(address indexed player, address indexed recipient, uint256 amount);
    event ExcessRecovered(address indexed recipient, uint256 amount);

    modifier onlyOperator() {
        if (msg.sender != operator) revert UnauthorizedOperator(msg.sender);
        _;
    }

    constructor(CryptoFighterCoin cfcToken, address initialOwner, address initialOperator)
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
        return totalActiveEscrow + settledTreasury + totalPlayerCredits;
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

    /// @notice Accept the token owner's pending two-step gameplay-authority handoff.
    function acceptGameplayAuthority() external {
        cfc.acceptGameplayAuthority();
    }

    /// @notice Mint and credit the arena-derived reward as one atomic operation.
    function mintGameplayReward(bytes32 matchId, address player, uint256 amount)
        external
        onlyOperator
        nonReentrant
    {
        _requireIdentifier(matchId);
        _requireAddress(player);
        _requireAmount(amount);
        if (gameplayRewards[matchId] != 0) revert GameplayRewardAlreadyCredited(matchId);
        gameplayRewards[matchId] = amount;
        totalGameplayRewardsCredited += amount;
        cfc.mintGameplayReward(matchId, player, amount);
        playerCredits[player] += amount;
        totalPlayerCredits += amount;
        emit GameplayRewardCredited(matchId, player, amount);
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
        IERC20(address(cfc)).safeTransfer(recipient, amount);
        emit PlayerCreditWithdrawn(msg.sender, recipient, amount);
    }

    function withdrawTreasury(address recipient, uint256 amount) external onlyOwner nonReentrant {
        _requireAddress(recipient);
        _requireAmount(amount);
        if (settledTreasury < amount) {
            revert InsufficientTreasury(settledTreasury, amount);
        }
        settledTreasury -= amount;
        IERC20(address(cfc)).safeTransfer(recipient, amount);
        emit TreasuryWithdrawn(recipient, amount);
    }

    function recoverExcess(address recipient, uint256 amount) external onlyOwner nonReentrant {
        _requireAddress(recipient);
        _requireAmount(amount);
        uint256 available = excessBalance();
        if (available < amount) revert InsufficientExcess(available, amount);
        IERC20(address(cfc)).safeTransfer(recipient, amount);
        emit ExcessRecovered(recipient, amount);
    }

    /// @dev Prevent accidentally locking treasury and reward administration.
    ///      Transfer ownership to a DAO/timelock instead.
    function renounceOwnership() public view override onlyOwner {
        revert OwnershipRenunciationDisabled();
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
        IERC20(address(cfc)).safeTransferFrom(from, address(this), amount);
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
