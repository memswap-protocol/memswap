import { defaultAbiCoder } from "@ethersproject/abi";
import { splitSignature } from "@ethersproject/bytes";
import { AddressZero } from "@ethersproject/constants";
import { Contract } from "@ethersproject/contracts";
import { time } from "@nomicfoundation/hardhat-network-helpers";
import { SignerWithAddress } from "@nomiclabs/hardhat-ethers/signers";
import { expect } from "chai";
import { ethers } from "hardhat";

import { Intent, getIntentHash, signIntent } from "./utils";
import {
  PermitKind,
  bn,
  getCurrentTimestamp,
  getRandomInteger,
  getRandomFloat,
  signPermit2,
  signPermitEIP2612,
} from "../utils";
import { PERMIT2 } from "../../src/common/addresses";

describe("[ERC20] Misc", async () => {
  let chainId: number;

  let deployer: SignerWithAddress;
  let alice: SignerWithAddress;
  let bob: SignerWithAddress;
  let carol: SignerWithAddress;

  let memswap: Contract;

  let solutionProxy: Contract;
  let token0: Contract;
  let token1: Contract;

  beforeEach(async () => {
    chainId = await ethers.provider.getNetwork().then((n) => n.chainId);

    [deployer, alice, bob, carol] = await ethers.getSigners();

    memswap = await ethers
      .getContractFactory("MemswapERC20")
      .then((factory) => factory.deploy());

    solutionProxy = await ethers
      .getContractFactory("MockSolutionProxy")
      .then((factory) => factory.deploy(memswap.address));
    token0 = await ethers
      .getContractFactory("MockERC20")
      .then((factory) => factory.deploy());
    token1 = await ethers
      .getContractFactory("MockERC20")
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
      isBuy: false,
      buyToken: token0.address,
      sellToken: token1.address,
      maker: alice.address,
      solver: AddressZero,
      source: AddressZero,
      feeBps: 0,
      surplusBps: 0,
      startTime: currentTime,
      endTime: currentTime + 60,
      nonce: 0,
      isPartiallyFillable: true,
      isSmartOrder: false,
      isIncentivized: false,
      amount: ethers.utils.parseEther("0.5"),
      endAmount: ethers.utils.parseEther("0.3"),
      startAmountBps: 0,
      expectedAmountBps: 0,
      signature: "0x",
    };

    // Mint and approve
    await token1.connect(alice).mint(intent.amount);
    await token1.connect(alice).approve(memswap.address, intent.amount);

    // Only the maker can prevalidate
    await expect(memswap.connect(bob).prevalidate([intent])).to.be.revertedWith(
      "InvalidSignature"
    );

    // Cannot prevalidate smart order intents
    intent.isSmartOrder = true;
    await expect(
      memswap.connect(alice).prevalidate([intent])
    ).to.be.revertedWith("IntentCannotBePrevalidated");

    // Prevalidate
    intent.isSmartOrder = false;
    await expect(memswap.connect(alice).prevalidate([intent]))
      .to.emit(memswap, "IntentPrevalidated")
      .withArgs(getIntentHash(intent));

    // Once prevalidated, solving can be done without a maker signature
    await solutionProxy.connect(bob).solveERC20(
      intent,
      {
        data: defaultAbiCoder.encode(["uint128"], [0]),
        fillAmount: intent.amount,
      },
      []
    );
  });

  it("Cancellation", async () => {
    const currentTime = await getCurrentTimestamp();

    // Generate intent
    const intent: Intent = {
      isBuy: false,
      buyToken: token1.address,
      sellToken: token0.address,
      maker: alice.address,
      solver: AddressZero,
      source: AddressZero,
      feeBps: 0,
      surplusBps: 0,
      startTime: currentTime,
      endTime: currentTime + 60,
      nonce: 0,
      isPartiallyFillable: true,
      isSmartOrder: false,
      isIncentivized: false,
      amount: ethers.utils.parseEther("0.5"),
      endAmount: ethers.utils.parseEther("0.3"),
      startAmountBps: 0,
      expectedAmountBps: 0,
    };
    intent.signature = await signIntent(alice, memswap.address, intent);

    // Mint and approve
    await token0.connect(alice).mint(intent.amount);
    await token0.connect(alice).approve(memswap.address, intent.amount);

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
      solutionProxy.connect(bob).solveERC20(
        intent,
        {
          data: defaultAbiCoder.encode(["uint128"], [0]),
          fillAmount: intent.amount,
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
      solver: AddressZero,
      source: AddressZero,
      feeBps: 0,
      surplusBps: 0,
      startTime: currentTime,
      endTime: currentTime + 60,
      nonce: 0,
      isPartiallyFillable: true,
      isSmartOrder: false,
      isIncentivized: false,
      amount: ethers.utils.parseEther("0.5"),
      endAmount: ethers.utils.parseEther("0.3"),
      startAmountBps: 0,
      expectedAmountBps: 0,
    };
    intent.signature = await signIntent(alice, memswap.address, intent);

    // Mint and approve
    await token1.connect(alice).mint(intent.amount);
    await token1.connect(alice).approve(memswap.address, intent.amount);

    // Increment nonce
    await expect(memswap.connect(alice).incrementNonce())
      .to.emit(memswap, "NonceIncremented")
      .withArgs(alice.address, 1);

    // Once the nonce was incremented, intents signed on old nonces cannot be solved anymore
    // (the signature check will fail since the intent hash will be computed on latest nonce
    // value, and not on the nonce value the intent was signed with)
    await expect(
      solutionProxy.connect(bob).solveERC20(
        intent,
        {
          data: defaultAbiCoder.encode(["uint128"], [0]),
          fillAmount: intent.amount,
        },
        []
      )
    ).to.be.revertedWith("InvalidSignature");
  });

  it("Permit2 permit", async () => {
    const currentTime = await getCurrentTimestamp();

    // Generate intent
    const intent: Intent = {
      isBuy: true,
      buyToken: token1.address,
      sellToken: token0.address,
      maker: alice.address,
      solver: AddressZero,
      source: AddressZero,
      feeBps: 0,
      surplusBps: 0,
      startTime: currentTime,
      endTime: currentTime + 60,
      nonce: 0,
      isPartiallyFillable: true,
      isSmartOrder: false,
      isIncentivized: false,
      amount: ethers.utils.parseEther("0.5"),
      endAmount: ethers.utils.parseEther("0.3"),
      startAmountBps: 0,
      expectedAmountBps: 0,
    };
    intent.signature = await signIntent(alice, memswap.address, intent);

    // Mint and approve Permit2
    await token0.connect(alice).mint(intent.endAmount);
    await token0.connect(alice).approve(PERMIT2[chainId], intent.endAmount);

    // If not permit was passed, the solution transaction will revert
    await expect(
      solutionProxy.connect(bob).solveERC20(
        intent,
        {
          data: defaultAbiCoder.encode(["uint128"], [0]),
          fillAmount: intent.amount,
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
    const permitSignature = await signPermit2(alice, PERMIT2[chainId], permit);

    await solutionProxy.connect(bob).solveERC20(
      intent,
      {
        data: defaultAbiCoder.encode(["uint128"], [0]),
        fillAmount: intent.amount,
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

  it("EIP2612 permit", async () => {
    const currentTime = await getCurrentTimestamp();

    // Generate intent
    const intent: Intent = {
      isBuy: true,
      buyToken: token1.address,
      sellToken: token0.address,
      maker: alice.address,
      solver: AddressZero,
      source: AddressZero,
      feeBps: 0,
      surplusBps: 0,
      startTime: currentTime,
      endTime: currentTime + 60,
      nonce: 0,
      isPartiallyFillable: true,
      isSmartOrder: false,
      isIncentivized: false,
      amount: ethers.utils.parseEther("0.5"),
      endAmount: ethers.utils.parseEther("0.3"),
      startAmountBps: 0,
      expectedAmountBps: 0,
    };
    intent.signature = await signIntent(alice, memswap.address, intent);

    // Mint
    await token0.connect(alice).mint(intent.endAmount);

    // If not permit was passed, the solution transaction will revert
    await expect(
      solutionProxy.connect(bob).solveERC20(
        intent,
        {
          data: defaultAbiCoder.encode(["uint128"], [0]),
          fillAmount: intent.amount,
        },
        []
      )
    ).to.be.reverted;

    // Build and sign permit
    const permit = {
      owner: alice.address,
      spender: memswap.address,
      value: intent.endAmount,
      nonce: 0,
      deadline: currentTime + 3600,
    };
    const permitSignature = await signPermitEIP2612(
      alice,
      intent.sellToken,
      permit
    ).then((signature) => splitSignature(signature));
    (permit as any).v = permitSignature.v;
    (permit as any).r = permitSignature.r;
    (permit as any).s = permitSignature.s;

    await solutionProxy.connect(bob).solveERC20(
      intent,
      {
        data: defaultAbiCoder.encode(["uint128"], [0]),
        fillAmount: intent.amount,
      },
      [
        {
          kind: PermitKind.EIP2612,
          data: defaultAbiCoder.encode(
            [
              "address",
              "address",
              "address",
              "uint256",
              "uint256",
              "uint8",
              "bytes32",
              "bytes32",
            ],
            [
              intent.sellToken,
              permit.owner,
              permit.spender,
              permit.value,
              permit.deadline,
              (permit as any).v,
              (permit as any).r,
              (permit as any).s,
            ]
          ),
        },
      ]
    );
  });

  it("Private data", async () => {
    const currentTime = await getCurrentTimestamp();

    // Generate intent
    const intent: Intent = {
      isBuy: false,
      buyToken: token0.address,
      sellToken: token1.address,
      maker: alice.address,
      solver: AddressZero,
      source: AddressZero,
      feeBps: 0,
      surplusBps: 0,
      startTime: currentTime,
      endTime: currentTime + 60,
      nonce: 0,
      isPartiallyFillable: true,
      isSmartOrder: false,
      isIncentivized: false,
      amount: ethers.utils.parseEther("0.5"),
      endAmount: ethers.utils.parseEther("0.3"),
      startAmountBps: 0,
      expectedAmountBps: 0,
    };
    intent.signature = await signIntent(alice, memswap.address, intent);

    // Mint and approve
    await token1.connect(alice).mint(intent.amount);
    await token1.connect(alice).approve(memswap.address, intent.amount);

    // Save private data that wil get overridden
    const privateMaker = intent.maker;
    const privateSignaturePrefix = intent.signature.slice(0, 26);

    // Hide private data (maker + signature prefix)
    intent.maker = AddressZero;
    intent.signature = "0x" + "00".repeat(12) + intent.signature.slice(26);

    // Intent cannot be solved without first revealing the private data
    await expect(
      solutionProxy.connect(bob).solveERC20(
        intent,
        {
          data: defaultAbiCoder.encode(["uint128"], [0]),
          fillAmount: intent.amount,
        },
        []
      )
    ).to.be.revertedWith("InvalidSignature");

    // Reveal private data
    intent.maker = privateMaker;
    intent.signature = privateSignaturePrefix + intent.signature.slice(26);
    await memswap.connect(alice).reveal([intent]);

    // Hide private data (maker + signature prefix)
    intent.maker = AddressZero;
    intent.signature = "0x" + "00".repeat(12) + intent.signature.slice(26);

    // Once the private data is revealed we can successfully solve
    await solutionProxy.connect(bob).solveERC20(
      intent,
      {
        data: defaultAbiCoder.encode(["uint128"], [0]),
        fillAmount: intent.amount,
      },
      []
    );
  });

  it("Buy limit order with slippage", async () => {
    const currentTime = await getCurrentTimestamp();

    // Generate intent
    const intent: Intent = {
      isBuy: true,
      buyToken: token0.address,
      sellToken: token1.address,
      maker: alice.address,
      solver: AddressZero,
      source: carol.address,
      feeBps: getRandomInteger(0, 1000),
      surplusBps: getRandomInteger(0, 1000),
      startTime: currentTime,
      endTime: currentTime + 60,
      nonce: 0,
      isPartiallyFillable: true,
      isSmartOrder: false,
      isIncentivized: false,
      amount: ethers.utils.parseEther("0.5"),
      endAmount: ethers.utils.parseEther("0.3"),
      startAmountBps: 0,
      expectedAmountBps: 1000,
    };
    intent.signature = await signIntent(alice, memswap.address, intent);

    // Mint and approve
    await token1.connect(alice).mint(intent.endAmount);
    await token1.connect(alice).approve(memswap.address, intent.endAmount);

    // Move to a known block timestamp
    const nextBlockTime = getRandomInteger(intent.startTime, intent.endTime);
    await time.setNextBlockTimestamp(
      // Try to avoid `Timestamp is lower than the previous block's timestamp` errors
      Math.max(
        nextBlockTime,
        await ethers.provider.getBlock("latest").then((b) => b.timestamp + 1)
      )
    );

    // Compute the start / expected / end amounts
    const endAmount = bn(intent.endAmount);
    const startAmount = endAmount.sub(
      endAmount.mul(intent.startAmountBps).div(10000)
    );
    const expectedAmount = endAmount.sub(
      endAmount.mul(intent.expectedAmountBps).div(10000)
    );

    // Compute the required amount at above timestamp
    const amount = bn(startAmount).add(
      bn(endAmount)
        .sub(startAmount)
        .mul(bn(nextBlockTime).sub(intent.startTime))
        .div(bn(intent.endTime).sub(intent.startTime))
    );

    // Get balances before the execution
    const makerBalanceBefore = await token1.balanceOf(intent.maker);
    const sourceBalanceBefore = await token1.balanceOf(intent.source);

    // Optionally have some surplus (eg. on top of amount required by intent)
    const surplus = ethers.utils.parseEther(getRandomFloat(0.001, 0.1));

    // Compute fees
    const fee =
      intent.source === AddressZero
        ? bn(0)
        : amount.sub(surplus).mul(intent.feeBps).div(10000);
    const surplusFee =
      intent.source === AddressZero
        ? bn(0)
        : amount.sub(surplus).lt(expectedAmount)
        ? expectedAmount
            .sub(amount.sub(surplus))
            .mul(intent.surplusBps)
            .div(10000)
        : bn(0);

    // Solve
    const solve = solutionProxy.connect(bob).solveERC20(
      intent,
      {
        data: defaultAbiCoder.encode(["uint128"], [surplus]),
        fillAmount: intent.amount,
      },
      []
    );

    await expect(solve)
      .to.emit(memswap, "IntentSolved")
      .withArgs(
        getIntentHash(intent),
        intent.isBuy,
        intent.buyToken,
        intent.sellToken,
        intent.maker,
        solutionProxy.address,
        intent.amount,
        amount.sub(surplus)
      );

    // Get balances after the execution
    const makerBalanceAfter = await token1.balanceOf(intent.maker);
    const sourceBalanceAfter = await token1.balanceOf(intent.source);

    // Make sure the maker and the source got the right amounts
    expect(makerBalanceBefore.sub(makerBalanceAfter)).to.eq(
      amount.sub(surplus)
    );
    expect(sourceBalanceAfter.sub(sourceBalanceBefore)).to.eq(
      fee.add(surplusFee)
    );
  });

  it("Sell limit order with slippage", async () => {
    const currentTime = await getCurrentTimestamp();

    // Generate intent
    const intent: Intent = {
      isBuy: false,
      buyToken: token0.address,
      sellToken: token1.address,
      maker: alice.address,
      solver: AddressZero,
      source: carol.address,
      feeBps: getRandomInteger(0, 1000),
      surplusBps: getRandomInteger(0, 1000),
      startTime: currentTime,
      endTime: currentTime + 60,
      nonce: 0,
      isPartiallyFillable: true,
      isSmartOrder: false,
      isIncentivized: false,
      amount: ethers.utils.parseEther("0.5"),
      endAmount: ethers.utils.parseEther("0.3"),
      startAmountBps: 0,
      expectedAmountBps: 1000,
    };
    intent.signature = await signIntent(alice, memswap.address, intent);

    // Mint and approve
    await token1.connect(alice).mint(intent.amount);
    await token1.connect(alice).approve(memswap.address, intent.amount);

    // Move to a known block timestamp
    const nextBlockTime = getRandomInteger(intent.startTime, intent.endTime);
    await time.setNextBlockTimestamp(
      // Try to avoid `Timestamp is lower than the previous block's timestamp` errors
      Math.max(
        nextBlockTime,
        await ethers.provider.getBlock("latest").then((b) => b.timestamp + 1)
      )
    );

    // Compute the start / expected / end amounts
    const endAmount = bn(intent.endAmount);
    const startAmount = endAmount.add(
      endAmount.mul(intent.startAmountBps).div(10000)
    );
    const expectedAmount = endAmount.add(
      endAmount.mul(intent.expectedAmountBps).div(10000)
    );

    // Compute the required amount at above timestamp
    const amount = bn(startAmount).sub(
      bn(startAmount)
        .sub(endAmount)
        .mul(bn(nextBlockTime).sub(intent.startTime))
        .div(bn(intent.endTime).sub(intent.startTime))
    );

    // Get balances before the execution
    const makerBalanceBefore = await token0.balanceOf(intent.maker);
    const sourceBalanceBefore = await token0.balanceOf(intent.source);

    // Optionally have some surplus (eg. on top of amount required by intent)
    const surplus = ethers.utils.parseEther(getRandomFloat(0.001, 0.1));

    // Compute fees
    const fee =
      intent.source === AddressZero
        ? bn(0)
        : amount.add(surplus).mul(intent.feeBps).div(10000);
    const surplusFee =
      intent.source === AddressZero
        ? bn(0)
        : amount.add(surplus).gt(expectedAmount)
        ? amount
            .add(surplus)
            .sub(expectedAmount)
            .mul(intent.surplusBps)
            .div(10000)
        : bn(0);

    // Solve
    const solve = solutionProxy.connect(bob).solveERC20(
      intent,
      {
        data: defaultAbiCoder.encode(["uint128"], [surplus]),
        fillAmount: intent.amount,
      },
      []
    );

    await expect(solve)
      .to.emit(memswap, "IntentSolved")
      .withArgs(
        getIntentHash(intent),
        intent.isBuy,
        intent.buyToken,
        intent.sellToken,
        intent.maker,
        solutionProxy.address,
        amount.add(surplus),
        intent.amount
      );

    // Get balances after the execution
    const makerBalanceAfter = await token0.balanceOf(intent.maker);
    const sourceBalanceAfter = await token0.balanceOf(intent.source);

    // Make sure the maker and the source got the right amounts
    expect(makerBalanceAfter.sub(makerBalanceBefore)).to.eq(
      amount.add(surplus).sub(fee).sub(surplusFee)
    );
    expect(sourceBalanceAfter.sub(sourceBalanceBefore)).to.eq(
      fee.add(surplusFee)
    );
  });
});
