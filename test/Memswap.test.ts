import { Interface } from "@ethersproject/abi";
import { AddressZero } from "@ethersproject/constants";
import { Contract } from "@ethersproject/contracts";
import { time } from "@nomicfoundation/hardhat-network-helpers";
import { SignerWithAddress } from "@nomiclabs/hardhat-ethers/signers";
import { expect } from "chai";
import { ethers } from "hardhat";

import {
  bn,
  getCurrentTimestamp,
  getRandomBoolean,
  getRandomFloat,
  getRandomInteger,
} from "./utils";

// Tests

describe("Memswap", async () => {
  let chainId: number;

  let deployer: SignerWithAddress;
  let alice: SignerWithAddress;
  let bob: SignerWithAddress;
  let carol: SignerWithAddress;

  let memswap: Contract;
  let weth: Contract;
  let filler: Contract;
  let token0: Contract;
  let token1: Contract;

  beforeEach(async () => {
    chainId = await ethers.provider.getNetwork().then((n) => n.chainId);

    [deployer, alice, bob, carol] = await ethers.getSigners();

    memswap = await ethers
      .getContractFactory("Memswap")
      .then((factory) => factory.deploy());
    weth = await ethers
      .getContractFactory("WETH2")
      .then((factory) => factory.deploy());
    filler = await ethers
      .getContractFactory("MockFiller")
      .then((factory) => factory.deploy());
    token0 = await ethers
      .getContractFactory("MockERC20")
      .then((factory) => factory.deploy());
    token1 = await ethers
      .getContractFactory("MockERC20")
      .then((factory) => factory.deploy());

    // Send some ETH to filler contract for the tests where `tokenOut` is ETH
    await deployer.sendTransaction({
      to: filler.address,
      value: ethers.utils.parseEther("10"),
    });
  });

  const signIntent = async (signer: SignerWithAddress, intent: any) => {
    return signer._signTypedData(
      {
        name: "Memswap",
        version: "1.0",
        chainId,
        verifyingContract: memswap.address,
      },
      {
        Intent: [
          {
            name: "tokenIn",
            type: "address",
          },
          {
            name: "tokenOut",
            type: "address",
          },
          {
            name: "maker",
            type: "address",
          },
          {
            name: "filler",
            type: "address",
          },
          {
            name: "referrer",
            type: "address",
          },
          {
            name: "referrerFeeBps",
            type: "uint32",
          },
          {
            name: "referrerSurplusBps",
            type: "uint32",
          },
          {
            name: "deadline",
            type: "uint32",
          },
          {
            name: "isPartiallyFillable",
            type: "bool",
          },
          {
            name: "amountIn",
            type: "uint128",
          },
          {
            name: "startAmountOut",
            type: "uint128",
          },
          {
            name: "expectedAmountOut",
            type: "uint128",
          },
          {
            name: "endAmountOut",
            type: "uint128",
          },
        ],
      },
      intent
    );
  };

  const test = async () => {
    // Generate an intent with random values
    const intent = {
      tokenIn: getRandomBoolean() ? weth.address : token0.address,
      tokenOut: getRandomBoolean() ? AddressZero : token1.address,
      maker: alice.address,
      filler: AddressZero,
      referrer: getRandomBoolean() ? AddressZero : carol.address,
      referrerFeeBps: getRandomInteger(0, 1000),
      referrerSurplusBps: getRandomInteger(0, 1000),
      deadline: (await getCurrentTimestamp()) + getRandomInteger(1, 1000),
      isPartiallyFillable: getRandomBoolean(),
      amountIn: ethers.utils.parseEther(getRandomFloat(0.01, 1)),
      startAmountOut: ethers.utils.parseEther(getRandomFloat(0.5, 1)),
      expectedAmountOut: ethers.utils.parseEther(getRandomFloat(0.5, 0.7)),
      endAmountOut: ethers.utils.parseEther(getRandomFloat(0.01, 0.4)),
    };

    const fillAmount = intent.isPartiallyFillable
      ? ethers.utils.parseEther(
          getRandomFloat(
            0.01,
            Number(ethers.utils.formatEther(intent.amountIn))
          )
        )
      : intent.amountIn;

    if (intent.tokenIn === weth.address) {
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
    (intent as any).signature = await signIntent(alice, intent);

    // Move to a known block timestamp
    const startTime = Math.max(
      (await getCurrentTimestamp()) + 1,
      intent.deadline - getRandomInteger(1, 100)
    );
    const endTime = intent.deadline;
    await time.setNextBlockTimestamp(startTime);

    // Compute the intent amount at above timestamp
    const amount = bn(intent.startAmountOut).sub(
      bn(intent.startAmountOut)
        .sub(intent.endAmountOut)
        .div(endTime - startTime)
    );

    const makerBalanceBefore =
      intent.tokenOut === AddressZero
        ? await ethers.provider.getBalance(intent.maker)
        : await token1.balanceOf(intent.maker);
    const referrerBalanceBefore =
      intent.tokenOut === AddressZero
        ? await ethers.provider.getBalance(intent.referrer)
        : await token1.balanceOf(intent.referrer);

    // Optionally have some positive slippage (eg. on top of amount required by intent)
    const positiveSlippage = ethers.utils.parseEther(
      getRandomFloat(0.001, 0.1)
    );
    if (intent.deadline < startTime) {
      await expect(
        memswap.connect(bob).solve(intent, {
          to: filler.address,
          data: filler.interface.encodeFunctionData("fill", [
            intent.tokenOut,
            amount.add(positiveSlippage),
          ]),
          amount: fillAmount,
        })
      ).to.be.revertedWith("IntentIsExpired");
      return;
    } else {
      await memswap.connect(bob).solve(intent, {
        to: filler.address,
        data: filler.interface.encodeFunctionData("fill", [
          intent.tokenOut,
          amount.add(positiveSlippage),
        ]),
        amount: fillAmount,
      });
    }

    const makerBalanceAfter =
      intent.tokenOut === AddressZero
        ? await ethers.provider.getBalance(intent.maker)
        : await token1.balanceOf(intent.maker);
    const referrerBalanceAfter =
      intent.tokenOut === AddressZero
        ? await ethers.provider.getBalance(intent.referrer)
        : await token1.balanceOf(intent.referrer);

    const referrerFee =
      intent.referrer === AddressZero
        ? bn(0)
        : amount.mul(intent.referrerFeeBps).div(10000);
    const referrerSlippage =
      intent.referrer === AddressZero
        ? bn(0)
        : amount.add(positiveSlippage).gt(intent.expectedAmountOut) &&
          amount.lt(intent.expectedAmountOut)
        ? amount
            .add(positiveSlippage)
            .sub(intent.expectedAmountOut)
            .mul(intent.referrerSurplusBps)
            .div(10000)
        : bn(0);

    // Make sure the maker and the referrer got the right amounts
    expect(makerBalanceAfter.sub(makerBalanceBefore)).to.eq(
      amount.add(positiveSlippage).sub(referrerFee).sub(referrerSlippage)
    );
    expect(referrerBalanceAfter.sub(referrerBalanceBefore)).to.eq(
      referrerFee.add(referrerSlippage)
    );
  };

  const RUNS = 30;
  for (let i = 0; i < RUNS; i++) {
    it(`Basic filling with random values (run ${i})`, async () => test());
  }

  it("Fill with on-chain authorization", async () => {
    const intent = {
      tokenIn: token0.address,
      tokenOut: token1.address,
      maker: alice.address,
      filler: bob.address,
      referrer: AddressZero,
      referrerFeeBps: 0,
      referrerSurplusBps: 0,
      deadline: (await getCurrentTimestamp()) + 60,
      isPartiallyFillable: false,
      amountIn: ethers.utils.parseEther("0.5"),
      startAmountOut: ethers.utils.parseEther("0.3"),
      expectedAmountOut: ethers.utils.parseEther("0.3"),
      endAmountOut: ethers.utils.parseEther("0.3"),
    };
    (intent as any).signature = await signIntent(alice, intent);

    await token0.connect(alice).mint(intent.amountIn);
    await token0.connect(alice).approve(memswap.address, intent.amountIn);

    await expect(
      memswap.connect(carol).solve(intent, {
        to: filler.address,
        data: filler.interface.encodeFunctionData("fill", [
          intent.tokenOut,
          intent.startAmountOut,
        ]),
        amount: intent.amountIn,
      })
    ).to.be.revertedWith("Unauthorized");

    // Authorize
    await memswap.connect(bob).authorize(intent, carol.address, {
      maximumAmount: intent.amountIn,
      blockDeadline: await ethers.provider
        .getBlock("latest")
        .then((b) => b.number + 2),
      isPartiallyFillable: false,
    });

    await memswap.connect(carol).solveWithOnChainAuthorizationCheck(intent, {
      to: filler.address,
      data: filler.interface.encodeFunctionData("fill", [
        intent.tokenOut,
        intent.startAmountOut,
      ]),
      amount: intent.amountIn,
    });
  });
});
