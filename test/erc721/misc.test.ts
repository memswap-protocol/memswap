import { defaultAbiCoder } from "@ethersproject/abi";
import { AddressZero } from "@ethersproject/constants";
import { Contract } from "@ethersproject/contracts";
import { SignerWithAddress } from "@nomiclabs/hardhat-ethers/signers";
import { expect } from "chai";
import { ethers } from "hardhat";

import { Intent, getIntentHash, signIntent } from "./utils";
import { PermitKind, getCurrentTimestamp, signPermit } from "../utils";
import { PERMIT2, USDC } from "../../src/common/addresses";

describe("[ERC721] Misc", async () => {
  let chainId: number;

  let deployer: SignerWithAddress;
  let alice: SignerWithAddress;
  let bob: SignerWithAddress;

  let memswap: Contract;

  let solutionProxy: Contract;
  let token0: Contract;
  let token1: Contract;

  beforeEach(async () => {
    chainId = await ethers.provider.getNetwork().then((n) => n.chainId);

    [deployer, alice, bob] = await ethers.getSigners();

    memswap = await ethers
      .getContractFactory("MemswapERC721")
      .then((factory) => factory.deploy(PERMIT2[chainId], USDC[chainId]));

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
      isBuy: true,
      buyToken: token1.address,
      sellToken: token0.address,
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
    await solutionProxy.connect(bob).solve(
      [intent],
      {
        data: defaultAbiCoder.encode(
          ["address", "uint256[]"],
          [intent.buyToken, tokenIdsToFill]
        ),
        fillTokenIds: [tokenIdsToFill],
        executeAmounts: [intent.endAmount],
      },
      []
    );
  });

  it("Cancellation", async () => {
    const currentTime = await getCurrentTimestamp();

    // Generate intent
    const intent: Intent = {
      isBuy: true,
      buyToken: token1.address,
      sellToken: token0.address,
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
    };
    intent.signature = await signIntent(alice, memswap.address, intent);

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
      solutionProxy.connect(bob).solve(
        [intent],
        {
          data: defaultAbiCoder.encode(
            ["address", "uint256[]"],
            [intent.buyToken, tokenIdsToFill]
          ),
          fillTokenIds: [tokenIdsToFill],
          executeAmounts: [intent.endAmount],
        },
        []
      )
    ).to.be.revertedWith("IntentIsCancelled");
  });

  it("Increment nonce", async () => {
    const currentTime = await getCurrentTimestamp();

    // Generate intent
    const intent: Intent = {
      isBuy: true,
      buyToken: token1.address,
      sellToken: token0.address,
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
    };
    intent.signature = await signIntent(alice, memswap.address, intent);

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
      solutionProxy.connect(bob).solve(
        [intent],
        {
          data: defaultAbiCoder.encode(
            ["address", "uint256[]"],
            [intent.buyToken, tokenIdsToFill]
          ),
          fillTokenIds: [tokenIdsToFill],
          executeAmounts: [intent.endAmount],
        },
        []
      )
    ).to.be.revertedWith("InvalidSignature");
  });

  it("Permit", async () => {
    const currentTime = await getCurrentTimestamp();

    // Generate intent
    const intent: Intent = {
      isBuy: true,
      buyToken: token1.address,
      sellToken: token0.address,
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
    };
    intent.signature = await signIntent(alice, memswap.address, intent);

    // Mint and approve Permit2
    await token0.connect(alice).mint(intent.endAmount);
    await token0.connect(alice).approve(PERMIT2[chainId], intent.endAmount);

    const tokenIdsToFill = [...Array(Number(intent.amount)).keys()];

    // If not permit was passed, the solution transaction will revert
    await expect(
      solutionProxy.connect(bob).solve(
        [intent],
        {
          data: defaultAbiCoder.encode(
            ["address", "uint256[]"],
            [intent.buyToken, tokenIdsToFill]
          ),
          fillTokenIds: [tokenIdsToFill],
          executeAmounts: [intent.endAmount],
        },
        []
      )
    ).to.be.reverted;

    // Build and sign permit
    const permit = {
      details: {
        token: intent.sellToken,
        amount: intent.endAmount,
        expiration: currentTime + 3600,
        nonce: 0,
      },
      spender: memswap.address,
      sigDeadline: currentTime + 3600,
    };
    const permitSignature = await signPermit(alice, PERMIT2[chainId], permit);

    await solutionProxy.connect(bob).solve(
      [intent],
      {
        data: defaultAbiCoder.encode(
          ["address", "uint256[]"],
          [intent.buyToken, tokenIdsToFill]
        ),
        fillTokenIds: [tokenIdsToFill],
        executeAmounts: [intent.endAmount],
      },
      [
        {
          kind: PermitKind.PERMIT2,
          data: defaultAbiCoder.encode(
            [
              "address",
              "((address token, uint160 amount, uint48 expiration, uint48 nonce) details, address spender, uint256 sigDeadline)",
              "bytes",
            ],
            [alice.address, permit, permitSignature]
          ),
        },
      ]
    );
  });
});
