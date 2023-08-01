import { BigNumber, BigNumberish } from "@ethersproject/bignumber";
import { AddressZero } from "@ethersproject/constants";
import { Contract } from "@ethersproject/contracts";
import { time } from "@nomicfoundation/hardhat-network-helpers";
import { SignerWithAddress } from "@nomiclabs/hardhat-ethers/signers";
import { expect } from "chai";
import { ethers } from "hardhat";

// Utilities

const bn = (value: BigNumberish) => BigNumber.from(value);

const getCurrentTimestamp = async () =>
  ethers.provider.getBlock("latest").then((b) => b!.timestamp);

const getRandomBoolean = () => Math.random() < 0.5;

const getRandomInteger = (min: number, max: number) => {
  min = Math.ceil(min);
  max = Math.floor(max);
  return Math.floor(Math.random() * (max - min + 1)) + min;
};

const getRandomFloat = (min: number, max: number) =>
  (Math.random() * (max - min) + min).toFixed(6);

// Tests

describe("Memswap", async () => {
  let chainId: number;

  let deployer: SignerWithAddress;
  let alice: SignerWithAddress;
  let bob: SignerWithAddress;
  let carol: SignerWithAddress;

  let memswap: Contract;
  let filler: Contract;
  let token0: Contract;
  let token1: Contract;

  beforeEach(async () => {
    chainId = await ethers.provider.getNetwork().then((n) => n.chainId);

    [deployer, alice, bob, carol] = await ethers.getSigners();

    memswap = await ethers
      .getContractFactory("Memswap")
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
            name: "maker",
            type: "address",
          },
          {
            name: "filler",
            type: "address",
          },
          {
            name: "tokenIn",
            type: "address",
          },
          {
            name: "tokenOut",
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
            name: "referrerSlippageBps",
            type: "uint32",
          },
          {
            name: "deadline",
            type: "uint32",
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
      maker: alice.address,
      filler: AddressZero,
      tokenIn: getRandomBoolean() ? AddressZero : token0.address,
      tokenOut: getRandomBoolean() ? AddressZero : token1.address,
      referrer: getRandomBoolean() ? AddressZero : carol.address,
      referrerFeeBps: getRandomInteger(0, 1000),
      referrerSlippageBps: getRandomInteger(0, 1000),
      deadline: (await getCurrentTimestamp()) + getRandomInteger(1, 1000),
      amountIn: ethers.utils.parseEther(getRandomFloat(0.01, 1)),
      startAmountOut: ethers.utils.parseEther(getRandomFloat(0.5, 1)),
      endAmountOut: ethers.utils.parseEther(getRandomFloat(0.01, 0.5)),
    };

    if (intent.tokenIn === AddressZero) {
      // Deposit to escrow
      await alice.sendTransaction({
        to: await memswap.ethEscrow(),
        value: intent.amountIn,
      });
    } else {
      // Mint and approve
      await token0.connect(alice).mint(intent.amountIn);
      await token0.connect(alice).approve(memswap.address, intent.amountIn);
    }

    // Sign the intent
    (intent as any).signature = await signIntent(alice, intent);

    const makerBalanceBefore = await token1.balanceOf(intent.maker);
    const referrerBalanceBefore = await token1.balanceOf(intent.referrer);

    // Move to a known block timestamp
    const startTime = Math.max(
      (await getCurrentTimestamp()) + 1,
      intent.deadline - getRandomInteger(1, 100)
    );
    const endTime = intent.deadline;
    await time.increaseTo(startTime);

    // Compute the intent amount at above timestamp
    const amount = bn(intent.startAmountOut).sub(
      bn(intent.startAmountOut)
        .sub(intent.endAmountOut)
        .div(endTime - startTime)
    );

    // Optionally have some positive slippage (eg. on top of amount required by intent)
    const positiveSlippage = ethers.utils.parseEther(
      getRandomFloat(0.001, 0.1)
    );
    await memswap
      .connect(bob)
      .execute(
        intent,
        filler.address,
        filler.interface.encodeFunctionData("fill", [
          intent.tokenOut,
          amount.add(positiveSlippage),
        ])
      );

    const makerBalanceAfter = await token1.balanceOf(intent.maker);
    const referrerBalanceAfter = await token1.balanceOf(intent.referrer);

    const referrerFee =
      intent.referrer === AddressZero
        ? bn(0)
        : amount.mul(intent.referrerFeeBps).div(10000);
    const referrerSlippage =
      intent.referrer === AddressZero
        ? bn(0)
        : positiveSlippage.mul(intent.referrerSlippageBps).div(10000);

    // Make sure the maker and the referrer got the right amounts
    expect(
      makerBalanceAfter
        .sub(makerBalanceBefore)
        .eq(amount.add(positiveSlippage).sub(referrerFee).sub(referrerSlippage))
    );
    expect(
      referrerBalanceAfter
        .sub(referrerBalanceBefore)
        .eq(referrerFee.add(referrerSlippage))
    );
  };

  const RUNS = 30;
  for (let i = 0; i < RUNS; i++) {
    it(`Basic filling with random values (run ${i})`, async () => test());
  }
});
