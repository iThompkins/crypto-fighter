const assert = require("node:assert/strict");
const { ethers } = require("hardhat");

const CFC = ethers.parseEther("1");

function errorData(error) {
  let data = error?.data ?? error?.error?.data ?? error?.info?.error?.data;
  while (data && typeof data === "object") data = data.data ?? data.result ?? data.reason?.Revert;
  return data;
}

async function rejected(promise, contract, expectedName) {
  await assert.rejects(promise, (error) => {
    assert.equal(contract.interface.parseError(errorData(error)).name, expectedName);
    return true;
  });
}

async function deploy() {
  const [owner, operator, nextOwner, nextOperator, p1, p2, outsider, recipient] =
    await ethers.getSigners();
  const coin = await (await ethers.getContractFactory("CryptoFighterCoin")).deploy(owner.address);
  const vault = await (await ethers.getContractFactory("CryptoFighterVault"))
    .deploy(await coin.getAddress(), owner.address, operator.address);
  await coin.beginGameplayAuthorityTransfer(await vault.getAddress());
  await vault.acceptGameplayAuthority();
  return { owner, operator, nextOwner, nextOperator, p1, p2, outsider, recipient, coin, vault };
}

async function mintAndApprove(m, signer, amount) {
  await m.coin.connect(m.owner).mintAdministrative(signer.address, amount);
  await m.coin.connect(signer).approve(await m.vault.getAddress(), amount);
}

describe("Crypto Fighter Coin and segregated CFC vault", function () {
  it("separates administrative issuance from protocol gameplay issuance", async function () {
    const m = await deploy();
    assert.equal(await m.coin.name(), "Crypto Fighter Coin");
    assert.equal(await m.coin.symbol(), "CFC");
    assert.equal(await m.coin.decimals(), 18n);
    assert.equal(await m.coin.gameplayAuthority(), await m.vault.getAddress());

    await rejected(
      m.coin.connect(m.outsider).mintAdministrative(m.p1.address, CFC), m.coin, "OwnableUnauthorizedAccount",
    );
    await rejected(
      m.coin.connect(m.owner).mintAdministrative(m.p1.address, 0), m.coin, "InvalidMintAmount",
    );
    await m.coin.connect(m.owner).mintAdministrative(m.p1.address, 10n * CFC);
    assert.equal(await m.coin.totalAdministrativeMinted(), 10n * CFC);
    assert.equal(await m.coin.totalGameplayMinted(), 0n);
    const administrativeEvents = await m.coin.queryFilter(m.coin.filters.AdministrativeMinted());
    assert.equal(administrativeEvents.length, 1);
    assert.equal(administrativeEvents[0].args.recipient, m.p1.address);
    assert.equal(administrativeEvents[0].args.amount, 10n * CFC);

    const matchId = ethers.id("authorized gameplay reward");
    await rejected(
      m.coin.connect(m.owner).mintGameplayReward(matchId, m.p1.address, CFC),
      m.coin,
      "UnauthorizedGameplayAuthority",
    );
    await rejected(
      m.vault.connect(m.outsider).mintGameplayReward(matchId, m.p1.address, CFC),
      m.vault,
      "UnauthorizedOperator",
    );
    await m.vault.connect(m.operator).mintGameplayReward(matchId, m.p1.address, 3n * CFC);
    assert.equal(await m.coin.totalSupply(), 13n * CFC);
    assert.equal(await m.coin.totalGameplayMinted(), 3n * CFC);
    assert.equal(await m.vault.totalGameplayRewardsCredited(), 3n * CFC);
    assert.equal(await m.vault.playerCredits(m.p1.address), 3n * CFC);
    assert.equal(await m.coin.balanceOf(await m.vault.getAddress()), 3n * CFC);
    assert.equal(await m.coin.gameplayRewardIssued(matchId), true);
    assert.equal(
      await m.coin.totalSupply(),
      await m.coin.totalAdministrativeMinted() + await m.coin.totalGameplayMinted(),
    );
    const gameplayEvents = await m.coin.queryFilter(m.coin.filters.GameplayRewardMinted());
    assert.equal(gameplayEvents.length, 1);
    assert.equal(gameplayEvents[0].args.matchId, matchId);
    assert.equal(gameplayEvents[0].args.beneficiary, m.p1.address);
    assert.equal(gameplayEvents[0].args.creditVault, await m.vault.getAddress());
    assert.equal(gameplayEvents[0].args.amount, 3n * CFC);
    await rejected(
      m.vault.connect(m.operator).mintGameplayReward(matchId, m.p2.address, CFC),
      m.vault,
      "GameplayRewardAlreadyCredited",
    );
  });

  it("rotates ownership, vault operator, and gameplay authority through separate acceptance steps", async function () {
    const m = await deploy();
    await m.vault.connect(m.owner).beginOperatorTransfer(m.nextOperator.address);
    await rejected(m.vault.connect(m.outsider).acceptOperator(), m.vault, "UnauthorizedPendingOperator");
    await m.vault.connect(m.nextOperator).acceptOperator();
    assert.equal(await m.vault.operator(), m.nextOperator.address);

    await m.coin.connect(m.owner).beginGameplayAuthorityTransfer(m.outsider.address);
    assert.equal(await m.coin.gameplayAuthority(), await m.vault.getAddress());
    await rejected(
      m.coin.connect(m.p1).acceptGameplayAuthority(), m.coin, "UnauthorizedPendingGameplayAuthority",
    );
    await m.coin.connect(m.outsider).acceptGameplayAuthority();
    await rejected(
      m.vault.connect(m.nextOperator).mintGameplayReward(ethers.id("stranded"), m.p1.address, CFC),
      m.coin,
      "UnauthorizedGameplayAuthority",
    );

    await m.coin.connect(m.owner).transferOwnership(m.nextOwner.address);
    await m.coin.connect(m.nextOwner).acceptOwnership();
    await rejected(
      m.coin.connect(m.owner).mintAdministrative(m.p2.address, CFC), m.coin, "OwnableUnauthorizedAccount",
    );
    await m.coin.connect(m.nextOwner).mintAdministrative(m.p2.address, CFC);
    await rejected(m.coin.connect(m.nextOwner).renounceOwnership(), m.coin, "OwnershipRenunciationDisabled");

    await m.vault.connect(m.owner).transferOwnership(m.nextOwner.address);
    await m.vault.connect(m.nextOwner).acceptOwnership();
    await rejected(m.vault.connect(m.nextOwner).renounceOwnership(), m.vault, "OwnershipRenunciationDisabled");
  });

  it("moves CFC escrow only into the original player's credit or settled treasury", async function () {
    const m = await deploy();
    await mintAndApprove(m, m.p1, CFC);
    await mintAndApprove(m, m.p2, CFC);
    const matchId = ethers.id("ranked match");

    await m.vault.connect(m.operator).depositEscrow(matchId, m.p1.address, CFC);
    await m.vault.connect(m.operator).depositEscrow(matchId, m.p2.address, CFC);
    await m.vault.connect(m.operator).creditEscrow(matchId, m.p1.address, CFC);
    await m.vault.connect(m.operator).forfeitEscrow(matchId, m.p2.address, CFC);
    assert.equal(await m.vault.totalActiveEscrow(), 0n);
    assert.equal(await m.vault.playerCredits(m.p1.address), CFC);
    assert.equal(await m.vault.settledTreasury(), CFC);

    await rejected(
      m.vault.connect(m.outsider).withdrawTreasury(m.recipient.address, CFC),
      m.vault,
      "OwnableUnauthorizedAccount",
    );
    await m.vault.connect(m.owner).withdrawTreasury(m.recipient.address, CFC);
    await m.vault.connect(m.p1).withdrawCredit(m.p1.address, CFC);
    assert.equal(await m.coin.balanceOf(m.recipient.address), CFC);
    assert.equal(await m.coin.balanceOf(await m.vault.getAddress()), 0n);
  });

  it("protects active escrow, player credits, and treasury while recovering only excess", async function () {
    const m = await deploy();
    await mintAndApprove(m, m.owner, 5n * CFC);
    await mintAndApprove(m, m.p1, CFC);
    const matchId = ethers.id("protected escrow");
    await m.vault.connect(m.operator).depositEscrow(matchId, m.p1.address, CFC);
    await m.vault.connect(m.owner).depositTreasury(3n * CFC);
    await m.vault.connect(m.operator).mintGameplayReward(ethers.id("protected credit"), m.p2.address, 2n * CFC);

    assert.equal(await m.vault.totalActiveEscrow(), CFC);
    assert.equal(await m.vault.totalPlayerCredits(), 2n * CFC);
    assert.equal(await m.vault.settledTreasury(), 3n * CFC);
    assert.equal(await m.vault.accountedBalance(), 6n * CFC);
    assert.equal(await m.vault.accountingSolvent(), true);
    await rejected(
      m.vault.connect(m.owner).withdrawTreasury(m.recipient.address, 4n * CFC),
      m.vault,
      "InsufficientTreasury",
    );
    await rejected(
      m.vault.connect(m.owner).recoverExcess(m.recipient.address, CFC),
      m.vault,
      "InsufficientExcess",
    );

    await m.coin.connect(m.owner).mintAdministrative(m.owner.address, 2n * CFC);
    await m.coin.connect(m.owner).transfer(await m.vault.getAddress(), 2n * CFC);
    assert.equal(await m.vault.excessBalance(), 2n * CFC);
    await m.vault.connect(m.owner).recoverExcess(m.recipient.address, 2n * CFC);
    assert.equal(await m.vault.excessBalance(), 0n);
    assert.equal(await m.vault.accountingSolvent(), true);
  });
});
