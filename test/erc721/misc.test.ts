import { defaultAbiCoder } from "@ethersproject/abi";
import { AddressZero } from "@ethersproject/constants";
import { Contract } from "@ethersproject/contracts";
import { SignerWithAddress } from "@nomiclabs/hardhat-ethers/signers";
import { expect } from "chai";
import { ethers } from "hardhat";

import { Intent, Side, getIntentHash, signIntent } from "./utils";
import { bn, getCurrentTimestamp } from "../utils";

describe("[ERC721] Misc", async () => {
  let deployer: SignerWithAddress;
  let alice: SignerWithAddress;
  let bob: SignerWithAddress;

  let memswap: Contract;

  let solutionProxy: Contract;
  let token0: Contract;
  let token1: Contract;

  beforeEach(async () => {
    [deployer, alice, bob] = await ethers.getSigners();

    memswap = await ethers
      .getContractFactory("MemswapERC721")
      .then((factory) => factory.deploy());

    solutionProxy = await ethers
      .getContractFactory("MockSolutionProxyERC721")
      .then((factory) => factory.deploy(memswap.address));
    token0 = await ethers
      .getContractFactory("MockERC20")
      .then((factory) => factory.deploy());
    token1 = await ethers
      .getContractFactory("MockERC721")
      .then((factory) => factory.deploy());

    // Send some ETH to solution proxy contract for the tests where `tokenOut` is ETH
    await deployer.sendTransaction({
      to: solutionProxy.address,
      value: ethers.utils.parseEther("10"),
    });
  });

  it("Prevalidation", async () => {
    const currentTime = await getCurrentTimestamp();

    // Generate intent
    const intent: Intent = {
      side: Side.BUY,
      tokenIn: token0.address,
      tokenOut: token1.address,
      maker: alice.address,
      matchmaker: AddressZero,
      source: AddressZero,
      feeBps: 0,
      surplusBps: 0,
      startTime: currentTime,
      endTime: currentTime + 60,
      nonce: 0,
      isPartiallyFillable: true,
      amount: 2,
      endAmount: ethers.utils.parseEther("0.3"),
      startAmountBps: 0,
      expectedAmountBps: 0,
      hasDynamicSignature: false,
      signature: "0x",
    };

    // Mint and approve
    await token0.connect(alice).mint(intent.endAmount);
    await token0.connect(alice).approve(memswap.address, intent.endAmount);

    const tokenIdsToFill = [...Array(Number(intent.amount)).keys()];

    // Only the maker can prevalidate
    await expect(memswap.connect(bob).prevalidate([intent])).to.be.revertedWith(
      "InvalidSignature"
    );

    // Cannot prevalidate dynamic signature intents
    intent.hasDynamicSignature = true;
    await expect(
      memswap.connect(alice).prevalidate([intent])
    ).to.be.revertedWith("IntentCannotBePrevalidated");

    // Prevalidate
    intent.hasDynamicSignature = false;
    await expect(memswap.connect(alice).prevalidate([intent]))
      .to.emit(memswap, "IntentPrevalidated")
      .withArgs(getIntentHash(intent));

    // Once prevalidated, solving can be done without a maker signature
    await solutionProxy.connect(bob).solve([intent], {
      data: defaultAbiCoder.encode(
        ["address", "uint256[]"],
        [intent.tokenOut, tokenIdsToFill]
      ),
      fillTokenIds: [tokenIdsToFill],
      executeAmounts: [intent.endAmount],
    });
  });

  it("Cancellation", async () => {
    const currentTime = await getCurrentTimestamp();

    // Generate intent
    const intent: Intent = {
      side: Side.BUY,
      tokenIn: token0.address,
      tokenOut: token1.address,
      maker: alice.address,
      matchmaker: AddressZero,
      source: AddressZero,
      feeBps: 0,
      surplusBps: 0,
      startTime: currentTime,
      endTime: currentTime + 60,
      nonce: 0,
      isPartiallyFillable: true,
      amount: 2,
      endAmount: ethers.utils.parseEther("0.3"),
      startAmountBps: 0,
      expectedAmountBps: 0,
      hasDynamicSignature: false,
      signature: "0x",
    };

    // Mint and approve
    await token0.connect(alice).mint(intent.endAmount);
    await token0.connect(alice).approve(memswap.address, intent.endAmount);

    const tokenIdsToFill = [...Array(Number(intent.amount)).keys()];

    // Only the maker can cancel
    await expect(memswap.connect(bob).cancel([intent])).to.be.revertedWith(
      "Unauthorized"
    );

    // Cancel
    await expect(memswap.connect(alice).cancel([intent]))
      .to.emit(memswap, "IntentCancelled")
      .withArgs(getIntentHash(intent));

    // Once cancelled, intent cannot be solved
    await expect(
      solutionProxy.connect(bob).solve([intent], {
        data: defaultAbiCoder.encode(
          ["address", "uint256[]"],
          [intent.tokenOut, tokenIdsToFill]
        ),
        fillTokenIds: [tokenIdsToFill],
        executeAmounts: [intent.endAmount],
      })
    ).to.be.revertedWith("IntentIsCancelled");
  });

  it("Increment nonce", async () => {
    const currentTime = await getCurrentTimestamp();

    // Generate intent
    const intent: Intent = {
      side: Side.BUY,
      tokenIn: token0.address,
      tokenOut: token1.address,
      maker: alice.address,
      matchmaker: AddressZero,
      source: AddressZero,
      feeBps: 0,
      surplusBps: 0,
      startTime: currentTime,
      endTime: currentTime + 60,
      nonce: 0,
      isPartiallyFillable: true,
      amount: 2,
      endAmount: ethers.utils.parseEther("0.3"),
      startAmountBps: 0,
      expectedAmountBps: 0,
      hasDynamicSignature: false,
      signature: "0x",
    };

    // Mint and approve
    await token0.connect(alice).mint(intent.endAmount);
    await token0.connect(alice).approve(memswap.address, intent.endAmount);

    const tokenIdsToFill = [...Array(Number(intent.amount)).keys()];

    // Increment nonce
    await expect(memswap.connect(alice).incrementNonce())
      .to.emit(memswap, "NonceIncremented")
      .withArgs(alice.address, 1);

    // Once the nonce was incremented, intents signed on old nonces cannot be solved anymore
    // (the signature check will fail since the intent hash will be computed on latest nonce
    // value, and not on the nonce value the intent was signed with)
    await expect(
      solutionProxy.connect(bob).solve([intent], {
        data: defaultAbiCoder.encode(
          ["address", "uint256[]"],
          [intent.tokenOut, tokenIdsToFill]
        ),
        fillTokenIds: [tokenIdsToFill],
        executeAmounts: [intent.endAmount],
      })
    ).to.be.revertedWith("InvalidSignature");
  });
});
