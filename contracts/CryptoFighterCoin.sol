// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";

/// @notice Owner-issued game and ranked-match token for Crypto Fighter.
/// @dev Supply has no automatic match hook or immutable cap. The current owner
///      makes every issuance explicitly and can later transfer ownership to a
///      DAO/timelock through Ownable2Step.
contract CryptoFighterCoin is ERC20, Ownable2Step {
    error InvalidMintAmount();
    error OwnershipRenunciationDisabled();

    event CFCMinted(address indexed recipient, uint256 amount);

    constructor(address initialOwner)
        ERC20("Crypto Fighter Coin", "CFC")
        Ownable(initialOwner)
    {
        require(block.chainid == 31337, "prototype: local chain only");
    }

    function mint(address recipient, uint256 amount) external onlyOwner {
        if (recipient == address(0)) revert ERC20InvalidReceiver(address(0));
        if (amount == 0) revert InvalidMintAmount();
        _mint(recipient, amount);
        emit CFCMinted(recipient, amount);
    }

    /// @dev Prevent accidentally making future issuance and administration
    ///      unreachable. Transfer ownership to a DAO/timelock instead.
    function renounceOwnership() public view override onlyOwner {
        revert OwnershipRenunciationDisabled();
    }
}
