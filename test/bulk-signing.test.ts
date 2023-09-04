import { defaultAbiCoder } from "@ethersproject/abi";
import { AddressZero } from "@ethersproject/constants";
import { Contract } from "@ethersproject/contracts";
import { time } from "@nomicfoundation/hardhat-network-helpers";
import { SignerWithAddress } from "@nomiclabs/hardhat-ethers/signers";
import { expect } from "chai";
import { ethers } from "hardhat";

import {
  Intent,
  Side,
  bn,
  bulkSign,
  getCurrentTimestamp,
  getIntentHash,
  getRandomInteger,
} from "./utils";

describe("Bulk-signing", async () => {
  let chainId: number;

  let deployer: SignerWithAddress;
  let alice: SignerWithAddress;
  let bob: SignerWithAddress;

  let memswap: Contract;
  let weth: Contract;

  let solutionProxy: Contract;
  let token0: Contract;
  let token1: Contract;

  beforeEach(async () => {
    chainId = await ethers.provider.getNetwork().then((n) => n.chainId);

    [deployer, alice, bob] = await ethers.getSigners();

    memswap = await ethers
      .getContractFactory("Memswap")
      .then((factory) => factory.deploy());
    weth = await ethers
      .getContractFactory("WETH2")
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

  const bulkSigning = async (count: number) => {
    const currentTime = await getCurrentTimestamp();

    // Generate intents
    const intents: Intent[] = [];
    for (let i = 0; i < count; i++) {
      intents.push({
        side: Side.SELL,
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
        amount: ethers.utils.parseEther("0.5"),
        endAmount: ethers.utils.parseEther("0.3"),
        startAmountBps: 0,
        expectedAmountBps: 0,
        hasDynamicSignature: false,
      });
    }

    // Bulk-sign
    await bulkSign(alice, intents, memswap.address, chainId);

    // Choose a random intent to solve
    const intent = intents[getRandomInteger(0, intents.length - 1)];

    // Mint and approve
    await token0.connect(alice).mint(intent.amount);
    await token0.connect(alice).approve(memswap.address, intent.amount);

    // Move to a known block timestamp
    const nextBlockTime = getRandomInteger(intent.startTime, intent.endTime);
    await time.setNextBlockTimestamp(
      // Try to avoid `Timestamp is lower than the previous block's timestamp` errors
      Math.max(
        nextBlockTime,
        await ethers.provider.getBlock("latest").then((b) => b.timestamp + 1)
      )
    );

    // Compute start amount
    const startAmount = bn(intent.endAmount).add(
      bn(intent.endAmount).mul(intent.startAmountBps).div(10000)
    );

    // Compute the required amount at above timestamp
    const amount = bn(startAmount).sub(
      bn(startAmount)
        .sub(intent.endAmount)
        .mul(bn(nextBlockTime).sub(intent.startTime))
        .div(bn(intent.endTime).sub(intent.startTime))
    );

    await expect(
      solutionProxy.connect(bob).solve([intent], {
        data: defaultAbiCoder.encode(
          ["address", "uint128"],
          [intent.tokenOut, amount]
        ),
        fillAmounts: [intent.amount],
        executeAmounts: [amount],
      })
    )
      .to.emit(memswap, "IntentSolved")
      .withArgs(
        getIntentHash(intent),
        intent.tokenIn,
        intent.tokenOut,
        intent.maker,
        solutionProxy.address,
        intent.amount,
        amount
      );
  };

  const RUNS = 30;
  for (let i = 0; i < RUNS; i++) {
    const count = getRandomInteger(1, 200);
    it(`Bulk-sign (${count} intents)`, async () => bulkSigning(count));
  }
});
