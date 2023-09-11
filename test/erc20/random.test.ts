import { Interface, defaultAbiCoder } from "@ethersproject/abi";
import { AddressZero } from "@ethersproject/constants";
import { Contract } from "@ethersproject/contracts";
import { time } from "@nomicfoundation/hardhat-network-helpers";
import { SignerWithAddress } from "@nomiclabs/hardhat-ethers/signers";
import { expect } from "chai";
import { ethers } from "hardhat";

import { Intent, getIntentHash, signIntent } from "./utils";
import {
  bn,
  getCurrentTimestamp,
  getRandomBoolean,
  getRandomFloat,
  getRandomInteger,
} from "../utils";

describe("[ERC20] Random", async () => {
  let deployer: SignerWithAddress;
  let alice: SignerWithAddress;
  let bob: SignerWithAddress;
  let carol: SignerWithAddress;

  let memswap: Contract;
  let weth: Contract;

  let solutionProxy: Contract;
  let token0: Contract;
  let token1: Contract;

  beforeEach(async () => {
    [deployer, alice, bob, carol] = await ethers.getSigners();

    memswap = await ethers
      .getContractFactory("MemswapERC20")
      .then((factory) => factory.deploy());
    weth = await ethers
      .getContractFactory("WETH2")
      .then((factory) => factory.deploy());

    solutionProxy = await ethers
      .getContractFactory("MockSolutionProxyERC20")
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

  const solveBuyWithRandomValues = async () => {
    const currentTime = await getCurrentTimestamp();

    // Generate an intent with random values
    const intent: Intent = {
      isBuy: true,
      buyToken: getRandomBoolean() ? AddressZero : token1.address,
      sellToken: getRandomBoolean() ? weth.address : token0.address,
      maker: alice.address,
      matchmaker: AddressZero,
      source: getRandomBoolean() ? AddressZero : carol.address,
      feeBps: getRandomInteger(0, 1000),
      surplusBps: getRandomInteger(0, 1000),
      startTime: currentTime,
      endTime: currentTime + getRandomInteger(1, 1000),
      nonce: 0,
      isPartiallyFillable: getRandomBoolean(),
      amount: ethers.utils.parseEther(getRandomFloat(0.01, 1)),
      endAmount: ethers.utils.parseEther(getRandomFloat(0.01, 0.4)),
      startAmountBps: getRandomInteger(800, 1000),
      expectedAmountBps: getRandomInteger(500, 800),
      hasDynamicSignature: false,
    };

    // Generate a random fill amount (for partially-fillable intents)
    const fillAmount = intent.isPartiallyFillable
      ? ethers.utils.parseEther(
          getRandomFloat(0.01, Number(ethers.utils.formatEther(intent.amount)))
        )
      : intent.amount;

    if (intent.sellToken === weth.address) {
      // Deposit and approve
      await alice.sendTransaction({
        to: weth.address,
        data: new Interface([
          "function depositAndApprove(address spender, uint256 amount)",
        ]).encodeFunctionData("depositAndApprove", [
          memswap.address,
          intent.endAmount,
        ]),
        value: intent.endAmount,
      });
    } else {
      // Mint and approve
      await token0.connect(alice).mint(intent.endAmount);
      await token0.connect(alice).approve(memswap.address, intent.endAmount);
    }

    // Sign the intent
    intent.signature = await signIntent(alice, memswap.address, intent);

    // Move to a known block timestamp
    const nextBlockTime = Math.max(
      getRandomInteger(intent.startTime, intent.endTime),
      // Try to avoid `Timestamp is lower than the previous block's timestamp` errors
      await ethers.provider.getBlock("latest").then((b) => b.timestamp + 1)
    );
    await time.setNextBlockTimestamp(nextBlockTime);

    // Compute the start / expected / end amounts
    const endAmount = bn(intent.endAmount).mul(fillAmount).div(intent.amount);
    const startAmount = bn(endAmount).sub(
      bn(endAmount).mul(intent.startAmountBps).div(10000)
    );
    const expectedAmount = bn(endAmount).sub(
      bn(endAmount).mul(intent.expectedAmountBps).div(10000)
    );

    // Compute the required amount at above timestamp
    const amount = bn(startAmount).add(
      bn(endAmount)
        .sub(startAmount)
        .mul(bn(nextBlockTime).sub(intent.startTime))
        .div(bn(intent.endTime).sub(intent.startTime))
    );

    // Get balances before the execution
    const makerBalanceBefore =
      intent.sellToken === weth.address
        ? await weth.balanceOf(intent.maker)
        : await token0.balanceOf(intent.maker);
    const sourceBalanceBefore =
      intent.sellToken === weth.address
        ? await weth.balanceOf(intent.source)
        : await token0.balanceOf(intent.source);

    // Optionally have some surplus (eg. from amount required by intent)
    const surplus = ethers.utils.parseEther(
      getRandomFloat(
        0,
        Number(ethers.utils.formatEther(bn(amount).mul(5000).div(10000)))
      )
    );

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
    const solve = solutionProxy.connect(bob).solve(
      [intent],
      {
        data: defaultAbiCoder.encode(
          ["address", "uint128"],
          [intent.buyToken, fillAmount]
        ),
        fillAmounts: [fillAmount],
        executeAmounts: [amount.sub(surplus)],
      },
      []
    );
    if (nextBlockTime > intent.endTime) {
      await expect(solve).to.be.revertedWith("IntentIsExpired");
    } else {
      await expect(solve)
        .to.emit(memswap, "IntentSolved")
        .withArgs(
          getIntentHash(intent),
          intent.isBuy,
          intent.buyToken,
          intent.sellToken,
          intent.maker,
          solutionProxy.address,
          fillAmount,
          amount.sub(surplus).sub(fee).sub(surplusFee)
        );
    }

    // Get balances after the execution
    const makerBalanceAfter =
      intent.sellToken === weth.address
        ? await weth.balanceOf(intent.maker)
        : await token0.balanceOf(intent.maker);
    const sourceBalanceAfter =
      intent.sellToken === weth.address
        ? await weth.balanceOf(intent.source)
        : await token0.balanceOf(intent.source);

    // Make sure the maker and the source got the right amounts
    expect(makerBalanceBefore.sub(makerBalanceAfter)).to.eq(
      amount.sub(surplus)
    );
    expect(sourceBalanceAfter.sub(sourceBalanceBefore)).to.eq(
      fee.add(surplusFee)
    );
  };

  const solveSellWithRandomValues = async () => {
    const currentTime = await getCurrentTimestamp();

    // Generate an intent with random values
    const intent: Intent = {
      isBuy: false,
      buyToken: getRandomBoolean() ? AddressZero : token1.address,
      sellToken: getRandomBoolean() ? weth.address : token0.address,
      maker: alice.address,
      matchmaker: AddressZero,
      source: getRandomBoolean() ? AddressZero : carol.address,
      feeBps: getRandomInteger(0, 1000),
      surplusBps: getRandomInteger(0, 1000),
      startTime: currentTime,
      endTime: currentTime + getRandomInteger(1, 1000),
      nonce: 0,
      isPartiallyFillable: getRandomBoolean(),
      amount: ethers.utils.parseEther(getRandomFloat(0.01, 1)),
      endAmount: ethers.utils.parseEther(getRandomFloat(0.01, 0.4)),
      startAmountBps: getRandomInteger(800, 1000),
      expectedAmountBps: getRandomInteger(500, 800),
      hasDynamicSignature: false,
    };

    // Generate a random fill amount (for partially-fillable intents)
    const fillAmount = intent.isPartiallyFillable
      ? ethers.utils.parseEther(
          getRandomFloat(0.01, Number(ethers.utils.formatEther(intent.amount)))
        )
      : intent.amount;

    if (intent.sellToken === weth.address) {
      // Deposit and approve
      await alice.sendTransaction({
        to: weth.address,
        data: new Interface([
          "function depositAndApprove(address spender, uint256 amount)",
        ]).encodeFunctionData("depositAndApprove", [
          memswap.address,
          fillAmount,
        ]),
        value: fillAmount,
      });
    } else {
      // Mint and approve
      await token0.connect(alice).mint(fillAmount);
      await token0.connect(alice).approve(memswap.address, fillAmount);
    }

    // Sign the intent
    intent.signature = await signIntent(alice, memswap.address, intent);

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
    const endAmount = bn(intent.endAmount).mul(fillAmount).div(intent.amount);
    const startAmount = bn(endAmount).add(
      bn(endAmount).mul(intent.startAmountBps).div(10000)
    );
    const expectedAmount = bn(endAmount).add(
      bn(endAmount).mul(intent.expectedAmountBps).div(10000)
    );

    // Compute the required amount at above timestamp
    const amount = bn(startAmount).sub(
      bn(startAmount)
        .sub(endAmount)
        .mul(bn(nextBlockTime).sub(intent.startTime))
        .div(bn(intent.endTime).sub(intent.startTime))
    );

    // Get balances before the execution
    const makerBalanceBefore =
      intent.buyToken === AddressZero
        ? await ethers.provider.getBalance(intent.maker)
        : await token1.balanceOf(intent.maker);
    const sourceBalanceBefore =
      intent.buyToken === AddressZero
        ? await ethers.provider.getBalance(intent.source)
        : await token1.balanceOf(intent.source);

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
    const solve = solutionProxy.connect(bob).solve(
      [intent],
      {
        data: defaultAbiCoder.encode(
          ["address", "uint128"],
          [intent.buyToken, amount.add(surplus)]
        ),
        fillAmounts: [fillAmount],
        executeAmounts: [amount.add(surplus)],
      },
      []
    );
    if (nextBlockTime > intent.endTime) {
      await expect(solve).to.be.revertedWith("IntentIsExpired");
    } else {
      await expect(solve)
        .to.emit(memswap, "IntentSolved")
        .withArgs(
          getIntentHash(intent),
          intent.isBuy,
          intent.buyToken,
          intent.sellToken,
          intent.maker,
          solutionProxy.address,
          amount.add(surplus).sub(fee).sub(surplusFee),
          fillAmount
        );
    }

    // Get balances after the execution
    const makerBalanceAfter =
      intent.buyToken === AddressZero
        ? await ethers.provider.getBalance(intent.maker)
        : await token1.balanceOf(intent.maker);
    const sourceBalanceAfter =
      intent.buyToken === AddressZero
        ? await ethers.provider.getBalance(intent.source)
        : await token1.balanceOf(intent.source);

    // Make sure the maker and the source got the right amounts
    expect(makerBalanceAfter.sub(makerBalanceBefore)).to.eq(
      amount.add(surplus).sub(fee).sub(surplusFee)
    );
    expect(sourceBalanceAfter.sub(sourceBalanceBefore)).to.eq(
      fee.add(surplusFee)
    );
  };

  const RUNS = 50;
  for (let i = 0; i < RUNS; i++) {
    it(`Solve buy random values (run ${i})`, solveBuyWithRandomValues);
  }
  for (let i = 0; i < RUNS; i++) {
    it(`Solve sell random values (run ${i})`, solveSellWithRandomValues);
  }
});
