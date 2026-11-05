// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/// @notice Owner-approved conventional ERC-20 ante custody for Crypto Fighter.
/// @dev Reward CFC remains in CryptoFighterVault. This vault requires exact
///      transfers and therefore rejects fee-on-transfer/rebasing behavior.
contract CryptoFighterTokenEscrow is Ownable2Step, ReentrancyGuard {
    using SafeERC20 for IERC20;

    error InvalidAddress();
    error InvalidAmount();
    error InvalidIdentifier();
    error TokenNotAllowed(address token);
    error UnauthorizedOperator(address caller);
    error UnauthorizedPendingOperator(address caller);
    error IncorrectAnte(uint256 required, uint256 supplied);
    error InsufficientEscrow(address token, bytes32 matchId, address player, uint256 available, uint256 requested);
    error InsufficientCredit(address token, address player, uint256 available, uint256 requested);
    error InsufficientTreasury(address token, uint256 available, uint256 requested);
    error InsufficientExcess(address token, uint256 available, uint256 requested);
    error UnexpectedTransferAmount(uint256 expected, uint256 received);
    error OwnershipRenunciationDisabled();

    struct AssetConfig {
        bool allowed;
        uint248 anteAmount;
    }

    address public operator;
    address public pendingOperator;
    mapping(address => AssetConfig) public assetConfigs;
    mapping(address => mapping(bytes32 => uint256)) public matchAnteAmounts;
    mapping(address => mapping(bytes32 => mapping(address => uint256))) public activeEscrow;
    mapping(address => mapping(address => uint256)) public playerCredits;
    mapping(address => uint256) public totalActiveEscrow;
    mapping(address => uint256) public totalPlayerCredits;
    mapping(address => uint256) public settledTreasury;

    event OperatorTransferStarted(address indexed currentOperator, address indexed pendingOperator);
    event OperatorTransferred(address indexed previousOperator, address indexed newOperator);
    event AssetConfigured(address indexed token, uint256 anteAmount, bool allowed);
    event EscrowDeposited(address indexed token, bytes32 indexed matchId, address indexed player, uint256 amount);
    event EscrowCredited(address indexed token, bytes32 indexed matchId, address indexed player, uint256 amount);
    event EscrowForfeited(address indexed token, bytes32 indexed matchId, address indexed player, uint256 amount);
    event PlayerCreditWithdrawn(address indexed token, address indexed player, address indexed recipient, uint256 amount);
    event TreasuryWithdrawn(address indexed token, address indexed recipient, uint256 amount);
    event ExcessRecovered(address indexed token, address indexed recipient, uint256 amount);

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

    function configureAsset(IERC20 token, uint256 anteAmount, bool allowed) external onlyOwner {
        if (address(token) == address(0) || address(token).code.length == 0) revert InvalidAddress();
        if (allowed && (anteAmount == 0 || anteAmount > type(uint248).max)) revert InvalidAmount();
        assetConfigs[address(token)] = AssetConfig(allowed, uint248(anteAmount));
        emit AssetConfigured(address(token), anteAmount, allowed);
    }

    function requiredAnte(address token) external view returns (uint256) {
        AssetConfig memory config = assetConfigs[token];
        if (!config.allowed) revert TokenNotAllowed(token);
        return config.anteAmount;
    }

    function accountedBalance(address token) public view returns (uint256) {
        return totalActiveEscrow[token] + totalPlayerCredits[token] + settledTreasury[token];
    }

    function excessBalance(IERC20 token) public view returns (uint256) {
        uint256 balance = token.balanceOf(address(this));
        uint256 accounted = accountedBalance(address(token));
        return balance > accounted ? balance - accounted : 0;
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

    function depositEscrow(IERC20 token, bytes32 matchId, address player, uint256 amount)
        external
        onlyOperator
        nonReentrant
    {
        _validate(matchId, player, amount);
        uint256 snapshottedAnte = matchAnteAmounts[address(token)][matchId];
        if (snapshottedAnte == 0) {
            AssetConfig memory config = assetConfigs[address(token)];
            if (!config.allowed) revert TokenNotAllowed(address(token));
            if (amount != config.anteAmount) revert IncorrectAnte(config.anteAmount, amount);
            matchAnteAmounts[address(token)][matchId] = amount;
        } else if (amount != snapshottedAnte) {
            revert IncorrectAnte(snapshottedAnte, amount);
        }
        _pullExact(token, player, amount);
        activeEscrow[address(token)][matchId][player] += amount;
        totalActiveEscrow[address(token)] += amount;
        emit EscrowDeposited(address(token), matchId, player, amount);
    }

    function creditEscrow(IERC20 token, bytes32 matchId, address player, uint256 amount) external onlyOperator {
        _takeEscrow(token, matchId, player, amount);
        playerCredits[address(token)][player] += amount;
        totalPlayerCredits[address(token)] += amount;
        emit EscrowCredited(address(token), matchId, player, amount);
    }

    function forfeitEscrow(IERC20 token, bytes32 matchId, address player, uint256 amount) external onlyOperator {
        _takeEscrow(token, matchId, player, amount);
        settledTreasury[address(token)] += amount;
        emit EscrowForfeited(address(token), matchId, player, amount);
    }

    function withdrawCredit(IERC20 token, address recipient, uint256 amount) external nonReentrant {
        if (recipient == address(0)) revert InvalidAddress();
        if (amount == 0) revert InvalidAmount();
        uint256 available = playerCredits[address(token)][msg.sender];
        if (available < amount) {
            revert InsufficientCredit(address(token), msg.sender, available, amount);
        }
        playerCredits[address(token)][msg.sender] = available - amount;
        totalPlayerCredits[address(token)] -= amount;
        token.safeTransfer(recipient, amount);
        emit PlayerCreditWithdrawn(address(token), msg.sender, recipient, amount);
    }

    function withdrawTreasury(IERC20 token, address recipient, uint256 amount)
        external
        onlyOwner
        nonReentrant
    {
        if (recipient == address(0)) revert InvalidAddress();
        if (amount == 0) revert InvalidAmount();
        uint256 available = settledTreasury[address(token)];
        if (available < amount) revert InsufficientTreasury(address(token), available, amount);
        settledTreasury[address(token)] = available - amount;
        token.safeTransfer(recipient, amount);
        emit TreasuryWithdrawn(address(token), recipient, amount);
    }

    function recoverExcess(IERC20 token, address recipient, uint256 amount)
        external
        onlyOwner
        nonReentrant
    {
        if (recipient == address(0)) revert InvalidAddress();
        if (amount == 0) revert InvalidAmount();
        uint256 available = excessBalance(token);
        if (available < amount) revert InsufficientExcess(address(token), available, amount);
        token.safeTransfer(recipient, amount);
        emit ExcessRecovered(address(token), recipient, amount);
    }

    function renounceOwnership() public view override onlyOwner {
        revert OwnershipRenunciationDisabled();
    }

    function _takeEscrow(IERC20 token, bytes32 matchId, address player, uint256 amount) private {
        _validate(matchId, player, amount);
        uint256 available = activeEscrow[address(token)][matchId][player];
        if (available < amount) {
            revert InsufficientEscrow(address(token), matchId, player, available, amount);
        }
        activeEscrow[address(token)][matchId][player] = available - amount;
        totalActiveEscrow[address(token)] -= amount;
    }

    function _pullExact(IERC20 token, address from, uint256 amount) private {
        uint256 beforeBalance = token.balanceOf(address(this));
        token.safeTransferFrom(from, address(this), amount);
        uint256 received = token.balanceOf(address(this)) - beforeBalance;
        if (received != amount) revert UnexpectedTransferAmount(amount, received);
    }

    function _validate(bytes32 matchId, address player, uint256 amount) private pure {
        if (matchId == bytes32(0)) revert InvalidIdentifier();
        if (player == address(0)) revert InvalidAddress();
        if (amount == 0) revert InvalidAmount();
    }
}
