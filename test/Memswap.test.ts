import { Interface } from "@ethersproject/abi";
import { BigNumberish } from "@ethersproject/bignumber";
import { AddressZero } from "@ethersproject/constants";
import { Contract } from "@ethersproject/contracts";
import { time } from "@nomicfoundation/hardhat-network-helpers";
import { SignerWithAddress } from "@nomiclabs/hardhat-ethers/signers";
import { expect } from "chai";
import { ethers } from "hardhat";

import {
  AUTHORIZATION_EIP712_TYPES,
  INTENT_EIP712_HASH,
  bn,
  bulkSign,
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
  let dan: SignerWithAddress;

  let memswap: Contract;
  let weth: Contract;
  let solver: Contract;
  let token0: Contract;
  let token1: Contract;

  beforeEach(async () => {
    chainId = await ethers.provider.getNetwork().then((n) => n.chainId);

    [deployer, alice, bob, carol, dan] = await ethers.getSigners();

    memswap = await ethers
      .getContractFactory("Memswap")
      .then((factory) => factory.deploy());
    weth = await ethers
      .getContractFactory("WETH2")
      .then((factory) => factory.deploy());
    solver = await ethers
      .getContractFactory("MockSolutionProxy")
      .then((factory) => factory.deploy());
    token0 = await ethers
      .getContractFactory("MockERC20")
      .then((factory) => factory.deploy());
    token1 = await ethers
      .getContractFactory("MockERC20")
      .then((factory) => factory.deploy());

    // Send some ETH to solver contract for the tests where `tokenOut` is ETH
    await deployer.sendTransaction({
      to: solver.address,
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
      INTENT_EIP712_HASH,
      intent
    );
  };

  const signAuthorization = async (signer: SignerWithAddress, auth: any) => {
    return signer._signTypedData(
      {
        name: "Memswap",
        version: "1.0",
        chainId,
        verifyingContract: memswap.address,
      },
      AUTHORIZATION_EIP712_TYPES,
      auth
    );
  };

  const fillWithRandomValues = async () => {
    // Generate an intent with random values
    const intent = {
      tokenIn: getRandomBoolean() ? weth.address : token0.address,
      tokenOut: getRandomBoolean() ? AddressZero : token1.address,
      maker: alice.address,
      matchmaker: AddressZero,
      source: getRandomBoolean() ? AddressZero : carol.address,
      feeBps: getRandomInteger(0, 1000),
      surplusBps: getRandomInteger(0, 1000),
      deadline: (await getCurrentTimestamp()) + getRandomInteger(1, 1000),
      isPartiallyFillable: getRandomBoolean(),
      amountIn: ethers.utils.parseEther(getRandomFloat(0.01, 1)),
      endAmountOut: ethers.utils.parseEther(getRandomFloat(0.01, 0.4)),
      startAmountBps: getRandomInteger(800, 1000),
      expectedAmountBps: getRandomInteger(500, 800),
    };

    // Generate a random fill amount (for partially-fillable intents)
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

    const startAmountOut = bn(intent.endAmountOut).add(
      bn(intent.endAmountOut).mul(intent.startAmountBps).div(10000)
    );
    const expectedAmountOut = bn(intent.endAmountOut).add(
      bn(intent.endAmountOut).mul(intent.expectedAmountBps).div(10000)
    );

    // Compute the intent amount at above timestamp
    const amount = bn(startAmountOut).sub(
      bn(startAmountOut)
        .sub(intent.endAmountOut)
        .div(endTime - startTime ?? 1)
    );

    const makerBalanceBefore =
      intent.tokenOut === AddressZero
        ? await ethers.provider.getBalance(intent.maker)
        : await token1.balanceOf(intent.maker);
    const sourceBalanceBefore =
      intent.tokenOut === AddressZero
        ? await ethers.provider.getBalance(intent.source)
        : await token1.balanceOf(intent.source);

    // Optionally have some positive slippage (eg. on top of amount required by intent)
    const positiveSlippage = ethers.utils.parseEther(
      getRandomFloat(0.001, 0.1)
    );
    if (intent.deadline < startTime) {
      await expect(
        memswap.connect(bob).solve(intent, {
          to: solver.address,
          data: solver.interface.encodeFunctionData("fill", [
            intent.tokenOut,
            amount.add(positiveSlippage),
          ]),
          amount: fillAmount,
        })
      ).to.be.revertedWith("IntentIsExpired");
      return;
    } else {
      await memswap.connect(bob).solve(intent, {
        to: solver.address,
        data: solver.interface.encodeFunctionData("fill", [
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
    const sourceBalanceAfter =
      intent.tokenOut === AddressZero
        ? await ethers.provider.getBalance(intent.source)
        : await token1.balanceOf(intent.source);

    // Compute source fees
    const sourceFee =
      intent.source === AddressZero
        ? bn(0)
        : amount.mul(intent.feeBps).div(10000);
    const sourceSlippage =
      intent.source === AddressZero
        ? bn(0)
        : amount.add(positiveSlippage).gt(expectedAmountOut) &&
          amount.lt(expectedAmountOut)
        ? amount
            .add(positiveSlippage)
            .sub(expectedAmountOut)
            .mul(intent.surplusBps)
            .div(10000)
        : bn(0);

    // Make sure the maker and the source got the right amounts
    expect(makerBalanceAfter.sub(makerBalanceBefore)).to.eq(
      amount.add(positiveSlippage).sub(sourceFee).sub(sourceSlippage)
    );
    expect(sourceBalanceAfter.sub(sourceBalanceBefore)).to.eq(
      sourceFee.add(sourceSlippage)
    );
  };

  const FILL_WITH_RANDOM_VALUES_RUNS = 30;
  for (let i = 0; i < FILL_WITH_RANDOM_VALUES_RUNS; i++) {
    it(`Fill random values (run ${i})`, fillWithRandomValues);
  }

  it("Fill with on-chain authorization", async () => {
    const intent = {
      tokenIn: token0.address,
      tokenOut: token1.address,
      maker: alice.address,
      matchmaker: bob.address,
      source: AddressZero,
      feeBps: 0,
      surplusBps: 0,
      deadline: (await getCurrentTimestamp()) + 60,
      isPartiallyFillable: true,
      amountIn: ethers.utils.parseEther("0.5"),
      endAmountOut: ethers.utils.parseEther("0.3"),
      startAmountBps: 0,
      expectedAmountBps: 0,
    };
    (intent as any).signature = await signIntent(alice, intent);

    await token0.connect(alice).mint(intent.amountIn);
    await token0.connect(alice).approve(memswap.address, intent.amountIn);

    const startAmountOut = bn(intent.endAmountOut).add(
      bn(intent.endAmountOut).mul(intent.startAmountBps).div(10000)
    );

    await expect(
      memswap.connect(carol).solve(intent, {
        to: solver.address,
        data: solver.interface.encodeFunctionData("fill", [
          intent.tokenOut,
          startAmountOut,
        ]),
        amount: intent.amountIn,
      })
    ).to.be.revertedWith("Unauthorized");

    // Authorization must come from the intent solver
    {
      await expect(
        memswap.connect(dan).authorize(intent, carol.address, {
          maxAmountIn: intent.amountIn,
          minAmountOut: intent.endAmountOut,
          blockDeadline: await ethers.provider
            .getBlock("latest")
            .then((b) => b.number + 2),
          isPartiallyFillable: true,
        })
      ).to.be.revertedWith("Unauthorized");
    }

    // Non-partially-fillable authorizations cannot be partially filled
    {
      const maxAmountIn = ethers.utils.parseEther("0.4");
      await memswap.connect(bob).authorize(intent, carol.address, {
        maxAmountIn,
        minAmountOut: intent.endAmountOut,
        blockDeadline: await ethers.provider
          .getBlock("latest")
          .then((b) => b.number + 2),
        isPartiallyFillable: false,
      });

      await expect(
        memswap.connect(carol).solveWithOnChainAuthorizationCheck(intent, {
          to: solver.address,
          data: solver.interface.encodeFunctionData("fill", [
            intent.tokenOut,
            startAmountOut,
          ]),
          amount: ethers.utils.parseEther("0.3"),
        })
      ).to.be.revertedWith("AuthorizationIsNotPartiallyFillable");
    }

    // Cannot fill more than the authorization maximum amount
    {
      const maxAmountIn = ethers.utils.parseEther("0.3");
      await memswap.connect(bob).authorize(intent, carol.address, {
        maxAmountIn,
        minAmountOut: intent.endAmountOut,
        blockDeadline: await ethers.provider
          .getBlock("latest")
          .then((b) => b.number + 2),
        isPartiallyFillable: true,
      });

      await expect(
        memswap.connect(carol).solveWithOnChainAuthorizationCheck(intent, {
          to: solver.address,
          data: solver.interface.encodeFunctionData("fill", [
            intent.tokenOut,
            startAmountOut,
          ]),
          amount: ethers.utils.parseEther("0.4"),
        })
      ).to.be.revertedWith("AuthorizationIsInsufficient");
    }

    // Cannot use expired authorization
    {
      const maxAmountIn = ethers.utils.parseEther("0.3");
      await memswap.connect(bob).authorize(intent, carol.address, {
        maxAmountIn,
        minAmountOut: intent.endAmountOut,
        blockDeadline: await ethers.provider
          .getBlock("latest")
          .then((b) => b.number + 1),
        isPartiallyFillable: false,
      });

      await expect(
        memswap.connect(carol).solveWithOnChainAuthorizationCheck(intent, {
          to: solver.address,
          data: solver.interface.encodeFunctionData("fill", [
            intent.tokenOut,
            startAmountOut,
          ]),
          amount: maxAmountIn,
        })
      ).to.be.revertedWith("AuthorizationIsExpired");
    }

    // Cannot fill less at a worse rate than authorized
    {
      const maxAmountIn = ethers.utils.parseEther("0.3");
      await memswap.connect(bob).authorize(intent, carol.address, {
        maxAmountIn,
        minAmountOut: startAmountOut,
        blockDeadline: await ethers.provider
          .getBlock("latest")
          .then((b) => b.number + 2),
        isPartiallyFillable: false,
      });

      await expect(
        memswap.connect(carol).solveWithOnChainAuthorizationCheck(intent, {
          to: solver.address,
          data: solver.interface.encodeFunctionData("fill", [
            intent.tokenOut,
            startAmountOut.sub(1),
          ]),
          amount: maxAmountIn,
        })
      ).to.be.revertedWith("InvalidSolution");
    }

    // Successful fill
    {
      const maxAmountIn = ethers.utils.parseEther("0.3");
      await memswap.connect(bob).authorize(intent, carol.address, {
        maxAmountIn,
        minAmountOut: intent.endAmountOut,
        blockDeadline: await ethers.provider
          .getBlock("latest")
          .then((b) => b.number + 2),
        isPartiallyFillable: false,
      });

      await memswap.connect(carol).solveWithOnChainAuthorizationCheck(intent, {
        to: solver.address,
        data: solver.interface.encodeFunctionData("fill", [
          intent.tokenOut,
          startAmountOut,
        ]),
        amount: maxAmountIn,
      });
    }
  });

  it("Fill with signature authorization", async () => {
    const intent = {
      tokenIn: token0.address,
      tokenOut: token1.address,
      maker: alice.address,
      matchmaker: bob.address,
      source: AddressZero,
      feeBps: 0,
      surplusBps: 0,
      deadline: (await getCurrentTimestamp()) + 60,
      isPartiallyFillable: true,
      amountIn: ethers.utils.parseEther("0.5"),
      endAmountOut: ethers.utils.parseEther("0.3"),
      startAmountBps: 0,
      expectedAmountBps: 0,
    };
    (intent as any).signature = await signIntent(alice, intent);

    await token0.connect(alice).mint(intent.amountIn);
    await token0.connect(alice).approve(memswap.address, intent.amountIn);

    const startAmountOut = bn(intent.endAmountOut).add(
      bn(intent.endAmountOut).mul(intent.startAmountBps).div(10000)
    );

    await expect(
      memswap.connect(carol).solve(intent, {
        to: solver.address,
        data: solver.interface.encodeFunctionData("fill", [
          intent.tokenOut,
          startAmountOut,
        ]),
        amount: intent.amountIn,
      })
    ).to.be.revertedWith("Unauthorized");

    const _signAuthorization = async (
      signer: SignerWithAddress,
      intent: any,
      authorizedSolver: string,
      auth: {
        maxAmountIn: BigNumberish;
        minAmountOut: BigNumberish;
        blockDeadline: number;
        isPartiallyFillable: boolean;
      }
    ) => {
      return signAuthorization(signer, {
        intentHash: await memswap.getIntentHash(intent),
        authorizedSolver,
        ...auth,
      });
    };

    // Authorization must come from the intent solver
    {
      const auth = {
        maxAmountIn: ethers.utils.parseEther("0.3"),
        minAmountOut: intent.endAmountOut,
        blockDeadline: await ethers.provider
          .getBlock("latest")
          .then((b) => b.number + 1),
        isPartiallyFillable: false,
      };
      const authSignature = await _signAuthorization(
        dan,
        intent,
        carol.address,
        auth
      );

      await expect(
        memswap.connect(carol).solveWithSignatureAuthorizationCheck(
          intent,
          {
            to: solver.address,
            data: solver.interface.encodeFunctionData("fill", [
              intent.tokenOut,
              startAmountOut,
            ]),
            amount: ethers.utils.parseEther("0.3"),
          },
          auth,
          authSignature
        )
      ).to.be.revertedWith("InvalidSignature");
    }

    // Authorization must be given to solver
    {
      const auth = {
        maxAmountIn: ethers.utils.parseEther("0.3"),
        minAmountOut: intent.endAmountOut,
        blockDeadline: await ethers.provider
          .getBlock("latest")
          .then((b) => b.number + 1),
        isPartiallyFillable: false,
      };
      const authSignature = await _signAuthorization(
        bob,
        intent,
        alice.address,
        auth
      );

      await expect(
        memswap.connect(carol).solveWithSignatureAuthorizationCheck(
          intent,
          {
            to: solver.address,
            data: solver.interface.encodeFunctionData("fill", [
              intent.tokenOut,
              startAmountOut,
            ]),
            amount: ethers.utils.parseEther("0.3"),
          },
          auth,
          authSignature
        )
      ).to.be.revertedWith("InvalidSignature");
    }

    // Successful fill
    {
      const auth = {
        maxAmountIn: ethers.utils.parseEther("0.3"),
        minAmountOut: intent.endAmountOut,
        blockDeadline: await ethers.provider
          .getBlock("latest")
          .then((b) => b.number + 1),
        isPartiallyFillable: false,
      };
      const authSignature = await _signAuthorization(
        bob,
        intent,
        carol.address,
        auth
      );

      await memswap.connect(carol).solveWithSignatureAuthorizationCheck(
        intent,
        {
          to: solver.address,
          data: solver.interface.encodeFunctionData("fill", [
            intent.tokenOut,
            startAmountOut,
          ]),
          amount: ethers.utils.parseEther("0.3"),
        },
        auth,
        authSignature
      );
    }
  });

  it("Validation", async () => {
    const intent = {
      tokenIn: token0.address,
      tokenOut: token1.address,
      maker: alice.address,
      matchmaker: AddressZero,
      source: AddressZero,
      feeBps: 0,
      surplusBps: 0,
      deadline: (await getCurrentTimestamp()) + 60,
      isPartiallyFillable: true,
      amountIn: ethers.utils.parseEther("0.5"),
      endAmountOut: ethers.utils.parseEther("0.3"),
      startAmountBps: 0,
      expectedAmountBps: 0,
      signature: "0x",
    };

    await token0.connect(alice).mint(intent.amountIn);
    await token0.connect(alice).approve(memswap.address, intent.amountIn);

    const startAmountOut = bn(intent.endAmountOut).add(
      bn(intent.endAmountOut).mul(intent.startAmountBps).div(10000)
    );

    await expect(memswap.connect(bob).validate([intent])).to.be.revertedWith(
      "InvalidSignature"
    );
    await memswap.connect(alice).validate([intent]);

    await memswap.connect(carol).solve(intent, {
      to: solver.address,
      data: solver.interface.encodeFunctionData("fill", [
        intent.tokenOut,
        startAmountOut,
      ]),
      amount: intent.amountIn,
    });
  });

  it("Cancellation", async () => {
    const intent = {
      tokenIn: token0.address,
      tokenOut: token1.address,
      maker: alice.address,
      matchmaker: AddressZero,
      source: AddressZero,
      feeBps: 0,
      surplusBps: 0,
      deadline: (await getCurrentTimestamp()) + 60,
      isPartiallyFillable: true,
      amountIn: ethers.utils.parseEther("0.5"),
      endAmountOut: ethers.utils.parseEther("0.3"),
      startAmountBps: 0,
      expectedAmountBps: 0,
    };
    (intent as any).signature = await signIntent(alice, intent);

    await token0.connect(alice).mint(intent.amountIn);
    await token0.connect(alice).approve(memswap.address, intent.amountIn);

    const startAmountOut = bn(intent.endAmountOut).add(
      bn(intent.endAmountOut).mul(intent.startAmountBps).div(10000)
    );

    await expect(memswap.connect(bob).cancel([intent])).to.be.revertedWith(
      "Unauthorized"
    );
    await memswap.connect(alice).cancel([intent]);

    await expect(
      memswap.connect(carol).solve(intent, {
        to: solver.address,
        data: solver.interface.encodeFunctionData("fill", [
          intent.tokenOut,
          startAmountOut,
        ]),
        amount: intent.amountIn,
      })
    ).to.be.revertedWith("IntentIsCancelled");
  });

  const bulkSignature = async (count: number) => {
    const intents: any[] = [];
    for (let i = 0; i < count; i++) {
      intents.push({
        tokenIn: token0.address,
        tokenOut: token1.address,
        maker: alice.address,
        matchmaker: AddressZero,
        source: AddressZero,
        feeBps: 0,
        surplusBps: 0,
        deadline: (await getCurrentTimestamp()) + 60,
        isPartiallyFillable: true,
        amountIn: ethers.utils.parseEther("0.5"),
        endAmountOut: ethers.utils.parseEther("0.3"),
        startAmountBps: 0,
        expectedAmountBps: 0,
      });
    }

    await bulkSign(alice, intents, memswap.address, chainId);

    const intent = intents[getRandomInteger(0, intents.length - 1)];
    await token0.connect(alice).mint(intent.amountIn);
    await token0.connect(alice).approve(memswap.address, intent.amountIn);

    const startAmountOut = bn(intent.endAmountOut).add(
      bn(intent.endAmountOut).mul(intent.startAmountBps).div(10000)
    );

    // Move to a known block timestamp
    const startTime = Math.max(
      (await getCurrentTimestamp()) + 1,
      intent.deadline - getRandomInteger(1, 100)
    );
    const endTime = intent.deadline;
    await time.setNextBlockTimestamp(startTime);

    // Compute the intent amount at above timestamp
    const amount = bn(startAmountOut).sub(
      bn(startAmountOut)
        .sub(intent.endAmountOut)
        .div(endTime - startTime ?? 1)
    );

    await memswap.connect(bob).solve(intent, {
      to: solver.address,
      data: solver.interface.encodeFunctionData("fill", [
        intent.tokenOut,
        amount,
      ]),
      amount: intent.amountIn,
    });
  };

  const BULK_SIGNATURE_RUNS = 20;
  for (let i = 0; i < BULK_SIGNATURE_RUNS; i++) {
    it(`Bulk-signature (${i + 1} intents)`, async () => bulkSignature(i + 1));
  }
});
