import { defaultAbiCoder } from "@ethersproject/abi";
import { AddressZero } from "@ethersproject/constants";
import { Contract } from "@ethersproject/contracts";
import { parseUnits } from "@ethersproject/units";
import { SignerWithAddress } from "@nomiclabs/hardhat-ethers/signers";
import { expect } from "chai";
import hre, { ethers } from "hardhat";

import { Intent, signIntent } from "./utils";
import { getCurrentTimestamp, getIncentivizationTip } from "../utils";

describe("[ERC20] Incentivization", async () => {
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

  it("Cannot use anything other than the required priority fee", async () => {
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
      isIncentivized: true,
      amount: ethers.utils.parseEther("0.5"),
      endAmount: ethers.utils.parseEther("0.3"),
      startAmountBps: 0,
      expectedAmountBps: 0,
    };
    intent.signature = await signIntent(alice, memswap.address, intent);

    // Mint and approve
    await token1.connect(alice).mint(intent.amount);
    await token1.connect(alice).approve(memswap.address, intent.amount);

    // The priority fee cannot be lower than required
    {
      const nextBaseFee = parseUnits("10", "gwei");
      await hre.network.provider.send("hardhat_setNextBlockBaseFeePerGas", [
        "0x" + nextBaseFee.toNumber().toString(16),
      ]);

      const requiredPriorityFee = await memswap.requiredPriorityFee();
      await expect(
        solutionProxy.connect(bob).solveERC20(
          intent,
          {
            data: defaultAbiCoder.encode(["uint128"], [0]),
            fillAmount: intent.amount,
          },
          [],
          {
            maxFeePerGas: nextBaseFee.add(requiredPriorityFee).sub(1),
            maxPriorityFeePerGas: requiredPriorityFee,
          }
        )
      ).to.be.revertedWith("InvalidPriorityFee");
    }

    // The priority fee cannot be higher than required
    {
      const nextBaseFee = parseUnits("10", "gwei");
      await hre.network.provider.send("hardhat_setNextBlockBaseFeePerGas", [
        "0x" + nextBaseFee.toNumber().toString(16),
      ]);

      const requiredPriorityFee = await memswap.requiredPriorityFee();
      await expect(
        solutionProxy.connect(bob).solveERC20(
          intent,
          {
            data: defaultAbiCoder.encode(["uint128"], [0]),
            fillAmount: intent.amount,
          },
          [],
          {
            maxFeePerGas: nextBaseFee.add(requiredPriorityFee).add(1),
            maxPriorityFeePerGas: requiredPriorityFee.add(1),
          }
        )
      ).to.be.revertedWith("InvalidPriorityFee");
    }

    // The priority fee should match the required value
    await solutionProxy.connect(bob).solveERC20(
      intent,
      {
        data: defaultAbiCoder.encode(["uint128"], [0]),
        fillAmount: intent.amount,
      },
      [],
      {
        value: await getIncentivizationTip(
          memswap,
          intent.isBuy,
          intent.endAmount,
          intent.expectedAmountBps,
          intent.endAmount
        ),
        maxPriorityFeePerGas: await memswap.requiredPriorityFee(),
      }
    );
  });

  it("Cannot pay builder out-of-band", async () => {
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
      isIncentivized: true,
      amount: ethers.utils.parseEther("0.5"),
      endAmount: ethers.utils.parseEther("0.3"),
      startAmountBps: 0,
      expectedAmountBps: 0,
    };
    intent.signature = await signIntent(alice, memswap.address, intent);

    // Mint and approve
    await token1.connect(alice).mint(intent.amount);
    await token1.connect(alice).approve(memswap.address, intent.amount);

    // Enable out-of-band payments to the builder
    await solutionProxy.connect(bob).setPayBuilderOnRefund(true);

    // The solution will fail if the tip the builder was too high
    await expect(
      solutionProxy.connect(bob).solveERC20(
        intent,
        {
          data: defaultAbiCoder.encode(["uint128"], [0]),
          fillAmount: intent.amount,
        },
        [],
        {
          value: await getIncentivizationTip(
            memswap,
            intent.isBuy,
            intent.endAmount,
            intent.expectedAmountBps,
            intent.endAmount
          ).then((tip) => tip.add(1)),
          maxPriorityFeePerGas: await memswap.requiredPriorityFee(),
        }
      )
    ).to.be.revertedWith("InvalidTip");
  });

  it("Insufficient tip", async () => {
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
      isIncentivized: true,
      amount: ethers.utils.parseEther("0.5"),
      endAmount: ethers.utils.parseEther("0.3"),
      startAmountBps: 0,
      expectedAmountBps: 0,
    };
    intent.signature = await signIntent(alice, memswap.address, intent);

    // Mint and approve
    await token1.connect(alice).mint(intent.amount);
    await token1.connect(alice).approve(memswap.address, intent.amount);

    // The solution will fail if the tip the builder was too low
    await expect(
      solutionProxy.connect(bob).solveERC20(
        intent,
        {
          data: defaultAbiCoder.encode(["uint128"], [0]),
          fillAmount: intent.amount,
        },
        [],
        {
          value: await getIncentivizationTip(
            memswap,
            intent.isBuy,
            intent.endAmount,
            intent.expectedAmountBps,
            intent.endAmount
          ).then((tip) => tip.sub(1)),
          maxPriorityFeePerGas: await memswap.requiredPriorityFee(),
        }
      )
    ).to.be.revertedWith("InvalidTip");
  });
});
