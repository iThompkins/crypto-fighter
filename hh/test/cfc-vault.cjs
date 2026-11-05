const assert = require("node:assert/strict");
const { ethers } = require("hardhat");

const CFC = ethers.parseEther("1");

function errorData(error) {
  let data = error?.data ?? error?.error?.data ?? error?.info?.error?.data;
  while (data && typeof data === "object") {
    data = data.data ?? data.result ?? data.reason?.Revert;
  }
  return data;
}

async function rejected(promise, contract, expectedName) {
  await assert.rejects(promise, (error) => {
    const parsed = contract.interface.parseError(errorData(error));
    assert.equal(parsed.name, expectedName);
    return true;
  });
}

async function deploy() {
  const [owner, operator, nextOwner, nextOperator, p1, p2, outsider, recipient] =
    await ethers.getSigners();
  const coin = await (await ethers.getContractFactory("CryptoFighterCoin"))
    .deploy(owner.address);
  await coin.waitForDeployment();
  const vault = await (await ethers.getContractFactory("CryptoFighterVault"))
    .deploy(await coin.getAddress(), owner.address, operator.address);
  await vault.waitForDeployment();
  return { owner, operator, nextOwner, nextOperator, p1, p2, outsider, recipient, coin, vault };
}

async function mintAndApprove(m, signer, amount) {
  await (await m.coin.connect(m.owner).mint(signer.address, amount)).wait();
  await (await m.coin.connect(signer).approve(await m.vault.getAddress(), amount)).wait();
}

describe("Crypto Fighter Coin and segregated CFC vault", function () {
  it("mints only through the visible two-step owner and disables renunciation", async function () {
    const m = await deploy();
    assert.equal(await m.coin.name(), "Crypto Fighter Coin");
    assert.equal(await m.coin.symbol(), "CFC");
    assert.equal(await m.coin.decimals(), 18n);
    assert.equal(await m.coin.owner(), m.owner.address);
    assert.equal(await m.coin.pendingOwner(), ethers.ZeroAddress);

    await rejected(m.coin.connect(m.outsider).mint(m.p1.address, CFC), m.coin, "OwnableUnauthorizedAccount");
    await rejected(m.coin.connect(m.owner).mint(m.p1.address, 0), m.coin, "InvalidMintAmount");
    await (await m.coin.connect(m.owner).mint(m.p1.address, 10n * CFC)).wait();
    assert.equal(await m.coin.totalSupply(), 10n * CFC);
    assert.equal(await m.coin.balanceOf(m.p1.address), 10n * CFC);

    await (await m.coin.connect(m.owner).transferOwnership(m.nextOwner.address)).wait();
    assert.equal(await m.coin.owner(), m.owner.address);
    assert.equal(await m.coin.pendingOwner(), m.nextOwner.address);
    await rejected(m.coin.connect(m.outsider).acceptOwnership(), m.coin, "OwnableUnauthorizedAccount");
    await (await m.coin.connect(m.nextOwner).acceptOwnership()).wait();
    assert.equal(await m.coin.owner(), m.nextOwner.address);
    assert.equal(await m.coin.pendingOwner(), ethers.ZeroAddress);
    await rejected(m.coin.connect(m.owner).mint(m.p2.address, CFC), m.coin, "OwnableUnauthorizedAccount");
    await (await m.coin.connect(m.nextOwner).mint(m.p2.address, CFC)).wait();
    await rejected(m.coin.connect(m.nextOwner).renounceOwnership(), m.coin, "OwnershipRenunciationDisabled");
  });

  it("rotates owner and settlement operator through separate acceptance steps", async function () {
    const m = await deploy();
    assert.equal(await m.vault.owner(), m.owner.address);
    assert.equal(await m.vault.operator(), m.operator.address);
    assert.equal(await m.vault.pendingOperator(), ethers.ZeroAddress);

    const id = ethers.id("operator rotation");
    await rejected(m.vault.connect(m.outsider).reserveReward(id, CFC), m.vault, "UnauthorizedOperator");
    await rejected(
      m.vault.connect(m.outsider).beginOperatorTransfer(m.nextOperator.address),
      m.vault,
      "OwnableUnauthorizedAccount"
    );
    await (await m.vault.connect(m.owner).beginOperatorTransfer(m.nextOperator.address)).wait();
    assert.equal(await m.vault.operator(), m.operator.address);
    assert.equal(await m.vault.pendingOperator(), m.nextOperator.address);
    await rejected(m.vault.connect(m.outsider).acceptOperator(), m.vault, "UnauthorizedPendingOperator");
    await (await m.vault.connect(m.nextOperator).acceptOperator()).wait();
    assert.equal(await m.vault.operator(), m.nextOperator.address);
    assert.equal(await m.vault.pendingOperator(), ethers.ZeroAddress);

    await (await m.vault.connect(m.owner).transferOwnership(m.nextOwner.address)).wait();
    assert.equal(await m.vault.owner(), m.owner.address);
    await (await m.vault.connect(m.nextOwner).acceptOwnership()).wait();
    assert.equal(await m.vault.owner(), m.nextOwner.address);
    await rejected(m.vault.connect(m.nextOwner).renounceOwnership(), m.vault, "OwnershipRenunciationDisabled");
  });

  it("reserves each reward once, releases it, or credits exactly one player", async function () {
    const m = await deploy();
    await mintAndApprove(m, m.owner, 100n * CFC);
    await (await m.vault.connect(m.owner).fundRewards(100n * CFC)).wait();
    assert.equal(await m.vault.availableRewards(), 100n * CFC);
    assert.equal(await m.vault.accountedBalance(), 100n * CFC);

    const released = ethers.id("released reward");
    await (await m.vault.connect(m.operator).reserveReward(released, 40n * CFC)).wait();
    assert.equal(await m.vault.availableRewards(), 60n * CFC);
    assert.equal(await m.vault.totalReservedRewards(), 40n * CFC);
    assert.equal(await m.vault.rewardReservations(released), 40n * CFC);
    await rejected(
      m.vault.connect(m.operator).reserveReward(released, CFC),
      m.vault,
      "RewardAlreadyReserved"
    );
    await (await m.vault.connect(m.operator).releaseReward(released)).wait();
    assert.equal(await m.vault.availableRewards(), 100n * CFC);
    assert.equal(await m.vault.totalReservedRewards(), 0n);

    const credited = ethers.id("credited reward");
    await (await m.vault.connect(m.operator).reserveReward(credited, 25n * CFC)).wait();
    await (await m.vault.connect(m.operator).creditReward(credited, m.p1.address)).wait();
    assert.equal(await m.vault.rewardReservations(credited), 0n);
    assert.equal(await m.vault.totalReservedRewards(), 0n);
    assert.equal(await m.vault.playerCredits(m.p1.address), 25n * CFC);
    assert.equal(await m.vault.totalPlayerCredits(), 25n * CFC);
    await rejected(m.vault.connect(m.operator).creditReward(credited, m.p1.address), m.vault, "RewardNotReserved");

    const p2Before = await m.coin.balanceOf(m.p2.address);
    await (await m.vault.connect(m.p1).withdrawCredit(m.p2.address, 10n * CFC)).wait();
    assert.equal(await m.coin.balanceOf(m.p2.address) - p2Before, 10n * CFC);
    assert.equal(await m.vault.playerCredits(m.p1.address), 15n * CFC);
    await rejected(
      m.vault.connect(m.p2).withdrawCredit(m.p2.address, CFC),
      m.vault,
      "InsufficientPlayerCredit"
    );
  });

  it("moves CFC escrow only into its original player's credit or settled treasury", async function () {
    const m = await deploy();
    await mintAndApprove(m, m.p1, CFC);
    await mintAndApprove(m, m.p2, CFC);
    const matchId = ethers.id("ranked match");

    await (await m.vault.connect(m.operator).depositEscrow(matchId, m.p1.address, CFC)).wait();
    await (await m.vault.connect(m.operator).depositEscrow(matchId, m.p2.address, CFC)).wait();
    assert.equal(await m.vault.activeEscrow(matchId, m.p1.address), CFC);
    assert.equal(await m.vault.activeEscrow(matchId, m.p2.address), CFC);
    assert.equal(await m.vault.totalActiveEscrow(), 2n * CFC);

    await rejected(
      m.vault.connect(m.outsider).forfeitEscrow(matchId, m.p2.address, CFC),
      m.vault,
      "UnauthorizedOperator"
    );
    await (await m.vault.connect(m.operator).creditEscrow(matchId, m.p1.address, CFC)).wait();
    await (await m.vault.connect(m.operator).forfeitEscrow(matchId, m.p2.address, CFC)).wait();
    assert.equal(await m.vault.totalActiveEscrow(), 0n);
    assert.equal(await m.vault.playerCredits(m.p1.address), CFC);
    assert.equal(await m.vault.settledTreasury(), CFC);
    await rejected(
      m.vault.connect(m.operator).forfeitEscrow(matchId, m.p2.address, CFC),
      m.vault,
      "InsufficientEscrow"
    );

    await rejected(
      m.vault.connect(m.outsider).withdrawTreasury(m.recipient.address, CFC),
      m.vault,
      "OwnableUnauthorizedAccount"
    );
    await (await m.vault.connect(m.owner).withdrawTreasury(m.recipient.address, CFC)).wait();
    assert.equal(await m.coin.balanceOf(m.recipient.address), CFC);
    assert.equal(await m.vault.settledTreasury(), 0n);
    await (await m.vault.connect(m.p1).withdrawCredit(m.p1.address, CFC)).wait();
    assert.equal(await m.coin.balanceOf(await m.vault.getAddress()), 0n);
  });

  it("protects reserved rewards, active escrow, and player credits from owner withdrawal", async function () {
    const m = await deploy();
    await mintAndApprove(m, m.owner, 20n * CFC);
    await mintAndApprove(m, m.p1, CFC);
    await (await m.vault.connect(m.owner).fundRewards(10n * CFC)).wait();
    const rewardId = ethers.id("protected reward");
    const matchId = ethers.id("protected escrow");
    await (await m.vault.connect(m.operator).reserveReward(rewardId, 4n * CFC)).wait();
    await (await m.vault.connect(m.operator).depositEscrow(matchId, m.p1.address, CFC)).wait();
    await (await m.vault.connect(m.owner).depositTreasury(3n * CFC)).wait();

    assert.equal(await m.vault.availableRewards(), 6n * CFC);
    assert.equal(await m.vault.totalReservedRewards(), 4n * CFC);
    assert.equal(await m.vault.totalActiveEscrow(), CFC);
    assert.equal(await m.vault.settledTreasury(), 3n * CFC);
    assert.equal(await m.vault.accountedBalance(), 14n * CFC);
    assert.equal(await m.vault.accountingSolvent(), true);

    await (await m.vault.connect(m.owner).withdrawAvailableRewards(m.recipient.address, 6n * CFC)).wait();
    await (await m.vault.connect(m.owner).withdrawTreasury(m.recipient.address, 3n * CFC)).wait();
    await rejected(
      m.vault.connect(m.owner).withdrawAvailableRewards(m.recipient.address, CFC),
      m.vault,
      "InsufficientAvailableRewards"
    );
    await rejected(
      m.vault.connect(m.owner).withdrawTreasury(m.recipient.address, CFC),
      m.vault,
      "InsufficientTreasury"
    );
    await rejected(m.vault.connect(m.owner).recoverExcess(m.recipient.address, CFC), m.vault, "InsufficientExcess");
    assert.equal(await m.coin.balanceOf(await m.vault.getAddress()), 5n * CFC);
    assert.equal(await m.vault.accountedBalance(), 5n * CFC);

    await (await m.coin.connect(m.owner).transfer(await m.vault.getAddress(), 2n * CFC)).wait();
    assert.equal(await m.vault.excessBalance(), 2n * CFC);
    await (await m.vault.connect(m.owner).recoverExcess(m.recipient.address, 2n * CFC)).wait();
    assert.equal(await m.vault.excessBalance(), 0n);
    assert.equal(await m.vault.accountingSolvent(), true);
  });
});
