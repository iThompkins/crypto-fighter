// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";

/// @notice Uncapped game token with separate administrative and protocol-gameplay issuance.
contract CryptoFighterCoin is ERC20, Ownable2Step {
    error InvalidMintAmount();
    error InvalidGameplayIdentifier();
    error UnauthorizedGameplayAuthority(address caller);
    error UnauthorizedPendingGameplayAuthority(address caller);
    error GameplayRewardAlreadyMinted(bytes32 matchId);
    error OwnershipRenunciationDisabled();

    address public gameplayAuthority;
    address public pendingGameplayAuthority;
    uint256 public totalAdministrativeMinted;
    uint256 public totalGameplayMinted;
    mapping(bytes32 => bool) public gameplayRewardIssued;

    event AdministrativeMinted(address indexed recipient, uint256 amount);
    event GameplayAuthorityTransferStarted(address indexed currentAuthority, address indexed pendingAuthority);
    event GameplayAuthorityTransferred(address indexed previousAuthority, address indexed newAuthority);
    event GameplayRewardMinted(
        bytes32 indexed matchId, address indexed beneficiary, address indexed creditVault, uint256 amount
    );

    constructor(address initialOwner)
        ERC20("Crypto Fighter Coin", "CFC")
        Ownable(initialOwner)
    {
        require(block.chainid == 31337, "prototype: local chain only");
        gameplayAuthority = initialOwner;
        emit GameplayAuthorityTransferred(address(0), initialOwner);
    }

    /// @notice Discretionary issuance for disclosed allocations, liquidity, and governance purposes.
    function mintAdministrative(address recipient, uint256 amount) external onlyOwner {
        if (recipient == address(0)) revert ERC20InvalidReceiver(address(0));
        if (amount == 0) revert InvalidMintAmount();
        totalAdministrativeMinted += amount;
        _mint(recipient, amount);
        emit AdministrativeMinted(recipient, amount);
    }

    function beginGameplayAuthorityTransfer(address newAuthority) external onlyOwner {
        if (newAuthority == address(0)) revert ERC20InvalidReceiver(address(0));
        pendingGameplayAuthority = newAuthority;
        emit GameplayAuthorityTransferStarted(gameplayAuthority, newAuthority);
    }

    function cancelGameplayAuthorityTransfer() external onlyOwner {
        pendingGameplayAuthority = address(0);
        emit GameplayAuthorityTransferStarted(gameplayAuthority, address(0));
    }

    function acceptGameplayAuthority() external {
        if (msg.sender != pendingGameplayAuthority) {
            revert UnauthorizedPendingGameplayAuthority(msg.sender);
        }
        address previous = gameplayAuthority;
        gameplayAuthority = msg.sender;
        pendingGameplayAuthority = address(0);
        emit GameplayAuthorityTransferred(previous, msg.sender);
    }

    /// @notice Mint one immutable match reward into the authorized credit vault.
    /// @dev The authority is always the token recipient. The beneficiary is an
    ///      audited event field and is credited atomically by that authority.
    function mintGameplayReward(bytes32 matchId, address beneficiary, uint256 amount) external {
        if (msg.sender != gameplayAuthority) revert UnauthorizedGameplayAuthority(msg.sender);
        if (matchId == bytes32(0)) revert InvalidGameplayIdentifier();
        if (beneficiary == address(0)) revert ERC20InvalidReceiver(address(0));
        if (amount == 0) revert InvalidMintAmount();
        if (gameplayRewardIssued[matchId]) revert GameplayRewardAlreadyMinted(matchId);
        gameplayRewardIssued[matchId] = true;
        totalGameplayMinted += amount;
        _mint(msg.sender, amount);
        emit GameplayRewardMinted(matchId, beneficiary, msg.sender, amount);
    }

    /// @dev Prevent accidentally making future issuance and administration
    ///      unreachable. Transfer ownership to a DAO/timelock instead.
    function renounceOwnership() public view override onlyOwner {
        revert OwnershipRenunciationDisabled();
    }
}
