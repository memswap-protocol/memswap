import { defaultAbiCoder } from "@ethersproject/abi";
import { AddressZero } from "@ethersproject/constants";
import { Contract } from "@ethersproject/contracts";
import { time } from "@nomicfoundation/hardhat-network-helpers";
import { SignerWithAddress } from "@nomiclabs/hardhat-ethers/signers";
import { expect } from "chai";
import { ethers } from "hardhat";

import { Intent, getIntentHash, bulkSign } from "./utils";
import { bn, getCurrentTimestamp, getRandomInteger } from "../utils";

describe("[ERC20] Bulk-signing", async () => {
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
      .getContractFactory("MemswapERC20")
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

  const bulkSigning = async (count: number) => {
    const currentTime = await getCurrentTimestamp();

    // Generate intents
    const intents: Intent[] = [];
    for (let i = 0; i < count; i++) {
      intents.push({
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
      solutionProxy.connect(bob).solve(
        intent,
        {
          data: defaultAbiCoder.encode(["uint128"], [0]),
          fillAmount: intent.amount,
        },
        []
      )
    )
      .to.emit(memswap, "IntentSolved")
      .withArgs(
        getIntentHash(intent),
        intent.isBuy,
        intent.buyToken,
        intent.sellToken,
        intent.maker,
        solutionProxy.address,
        amount,
        intent.amount
      );
  };

  const RUNS = 30;
  for (let i = 0; i < RUNS; i++) {
    const count = getRandomInteger(1, 200);
    it(`Bulk-sign (${count} intents)`, async () => bulkSigning(count));
  }
});
