import { defaultAbiCoder } from "@ethersproject/abi";
import { splitSignature } from "@ethersproject/bytes";
import { AddressZero } from "@ethersproject/constants";
import { Contract } from "@ethersproject/contracts";
import { SignerWithAddress } from "@nomiclabs/hardhat-ethers/signers";
import { expect } from "chai";
import { ethers } from "hardhat";

import { Intent, getIntentHash, signIntent } from "./utils";
import {
  PermitKind,
  bn,
  getCurrentTimestamp,
  signPermit2,
  signPermitEIP2612,
} from "../utils";
import { PERMIT2 } from "../../src/common/addresses";

describe("[ERC20] Misc", async () => {
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
      amount: ethers.utils.parseEther("0.5"),
      expectedAmount: ethers.utils.parseEther("0.3"),
      startAmountBps: 0,
      endAmountBps: 0,
      signature: "0x",
    };

    // Mint and approve
    await token1.connect(alice).mint(intent.amount);
    await token1.connect(alice).approve(memswap.address, intent.amount);

    // Compute start amount
    const startAmount = bn(intent.expectedAmount).add(
      bn(intent.expectedAmount).mul(intent.startAmountBps).div(10000)
    );

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
    await solutionProxy.connect(bob).solve(
      [intent],
      {
        data: defaultAbiCoder.encode(
          ["address", "uint128"],
          [intent.buyToken, startAmount]
        ),
        fillAmounts: [intent.amount],
        executeAmounts: [intent.expectedAmount],
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
      amount: ethers.utils.parseEther("0.5"),
      expectedAmount: ethers.utils.parseEther("0.3"),
      startAmountBps: 0,
      endAmountBps: 0,
    };
    intent.signature = await signIntent(alice, memswap.address, intent);

    // Mint and approve
    await token0.connect(alice).mint(intent.amount);
    await token0.connect(alice).approve(memswap.address, intent.amount);

    // Compute start amount
    const startAmount = bn(intent.expectedAmount).add(
      bn(intent.expectedAmount).mul(intent.startAmountBps).div(10000)
    );

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
            ["address", "uint128"],
            [intent.buyToken, startAmount]
          ),
          fillAmounts: [intent.amount],
          executeAmounts: [intent.expectedAmount],
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
      amount: ethers.utils.parseEther("0.5"),
      expectedAmount: ethers.utils.parseEther("0.3"),
      startAmountBps: 0,
      endAmountBps: 0,
    };
    intent.signature = await signIntent(alice, memswap.address, intent);

    // Mint and approve
    await token1.connect(alice).mint(intent.amount);
    await token1.connect(alice).approve(memswap.address, intent.amount);

    // Compute start amount
    const startAmount = bn(intent.expectedAmount).sub(
      bn(intent.expectedAmount).mul(intent.startAmountBps).div(10000)
    );

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
            ["address", "uint128"],
            [intent.buyToken, startAmount]
          ),
          fillAmounts: [intent.amount],
          executeAmounts: [intent.expectedAmount],
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
      amount: ethers.utils.parseEther("0.5"),
      expectedAmount: ethers.utils.parseEther("0.3"),
      startAmountBps: 0,
      endAmountBps: 0,
    };
    intent.signature = await signIntent(alice, memswap.address, intent);

    // Mint and approve Permit2
    await token0.connect(alice).mint(intent.expectedAmount);
    await token0
      .connect(alice)
      .approve(PERMIT2[chainId], intent.expectedAmount);

    // If not permit was passed, the solution transaction will revert
    await expect(
      solutionProxy.connect(bob).solve(
        [intent],
        {
          data: defaultAbiCoder.encode(
            ["address", "uint128"],
            [intent.buyToken, intent.amount]
          ),
          fillAmounts: [intent.amount],
          executeAmounts: [intent.expectedAmount],
        },
        []
      )
    ).to.be.reverted;

    // Build and sign permit
    const permit = {
      details: {
        token: intent.sellToken,
        amount: intent.expectedAmount,
        expiration: currentTime + 3600,
        nonce: 0,
      },
      spender: memswap.address,
      sigDeadline: currentTime + 3600,
    };
    const permitSignature = await signPermit2(alice, PERMIT2[chainId], permit);

    await solutionProxy.connect(bob).solve(
      [intent],
      {
        data: defaultAbiCoder.encode(
          ["address", "uint128"],
          [intent.buyToken, intent.amount]
        ),
        fillAmounts: [intent.amount],
        executeAmounts: [intent.expectedAmount],
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
      amount: ethers.utils.parseEther("0.5"),
      expectedAmount: ethers.utils.parseEther("0.3"),
      startAmountBps: 0,
      endAmountBps: 0,
    };
    intent.signature = await signIntent(alice, memswap.address, intent);

    // Mint
    await token0.connect(alice).mint(intent.expectedAmount);

    // If not permit was passed, the solution transaction will revert
    await expect(
      solutionProxy.connect(bob).solve(
        [intent],
        {
          data: defaultAbiCoder.encode(
            ["address", "uint128"],
            [intent.buyToken, intent.amount]
          ),
          fillAmounts: [intent.amount],
          executeAmounts: [intent.expectedAmount],
        },
        []
      )
    ).to.be.reverted;

    // Build and sign permit
    const permit = {
      owner: alice.address,
      spender: memswap.address,
      value: intent.expectedAmount,
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

    await solutionProxy.connect(bob).solve(
      [intent],
      {
        data: defaultAbiCoder.encode(
          ["address", "uint128"],
          [intent.buyToken, intent.amount]
        ),
        fillAmounts: [intent.amount],
        executeAmounts: [intent.expectedAmount],
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
      amount: ethers.utils.parseEther("0.5"),
      expectedAmount: ethers.utils.parseEther("0.3"),
      startAmountBps: 0,
      endAmountBps: 0,
    };
    intent.signature = await signIntent(alice, memswap.address, intent);

    // Mint and approve
    await token1.connect(alice).mint(intent.amount);
    await token1.connect(alice).approve(memswap.address, intent.amount);

    // Compute start amount
    const startAmount = bn(intent.expectedAmount).add(
      bn(intent.expectedAmount).mul(intent.startAmountBps).div(10000)
    );

    // Save private data that wil get overridden
    const privateMaker = intent.maker;
    const privateSignaturePrefix = intent.signature.slice(0, 26);

    // Hide private data (maker + signature prefix)
    intent.maker = AddressZero;
    intent.signature = "0x" + "00".repeat(12) + intent.signature.slice(26);

    // Intent cannot be solved without first revealing the private data
    await expect(
      solutionProxy.connect(bob).solve(
        [intent],
        {
          data: defaultAbiCoder.encode(
            ["address", "uint128"],
            [intent.buyToken, startAmount]
          ),
          fillAmounts: [intent.amount],
          executeAmounts: [intent.expectedAmount],
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
    await solutionProxy.connect(bob).solve(
      [intent],
      {
        data: defaultAbiCoder.encode(
          ["address", "uint128"],
          [intent.buyToken, startAmount]
        ),
        fillAmounts: [intent.amount],
        executeAmounts: [intent.expectedAmount],
      },
      []
    );
  });

  it("Direct filling with erc20", async () => {
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
      amount: ethers.utils.parseEther("0.5"),
      expectedAmount: ethers.utils.parseEther("0.3"),
      startAmountBps: 0,
      endAmountBps: 0,
    };
    intent.signature = await signIntent(alice, memswap.address, intent);

    // Mint and approve sell token
    await token0.connect(alice).mint(intent.expectedAmount);
    await token0.connect(alice).approve(memswap.address, intent.expectedAmount);

    // Mint and approve buy token
    await token1.connect(bob).mint(intent.amount);
    await token1.connect(bob).approve(memswap.address, intent.amount);

    const buyBalancesBefore = {
      alice: await token1.balanceOf(alice.address),
      bob: await token1.balanceOf(bob.address),
    };
    const sellBalancesBefore = {
      alice: await token0.balanceOf(alice.address),
      bob: await token0.balanceOf(bob.address),
    };

    await memswap.connect(bob).solve(
      [intent],
      {
        data: "0x",
        fillAmounts: [intent.amount],
        executeAmounts: [intent.expectedAmount],
      },
      []
    );

    const buyBalancesAfter = {
      alice: await token1.balanceOf(alice.address),
      bob: await token1.balanceOf(bob.address),
    };
    const sellBalancesAfter = {
      alice: await token0.balanceOf(alice.address),
      bob: await token0.balanceOf(bob.address),
    };

    expect(buyBalancesAfter.alice.sub(buyBalancesBefore.alice)).to.eq(
      intent.amount
    );
    expect(buyBalancesBefore.bob.sub(buyBalancesAfter.bob)).to.eq(
      intent.amount
    );
    expect(sellBalancesBefore.alice.sub(sellBalancesAfter.alice)).to.eq(
      intent.expectedAmount
    );
    expect(sellBalancesAfter.bob.sub(sellBalancesBefore.bob)).to.eq(
      intent.expectedAmount
    );
  });

  it("Direct filling with native", async () => {
    const currentTime = await getCurrentTimestamp();

    // Generate intent
    const intent: Intent = {
      isBuy: true,
      buyToken: AddressZero,
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
      amount: ethers.utils.parseEther("0.5"),
      expectedAmount: ethers.utils.parseEther("0.3"),
      startAmountBps: 0,
      endAmountBps: 0,
    };
    intent.signature = await signIntent(alice, memswap.address, intent);

    // Mint and approve sell token
    await token0.connect(alice).mint(intent.expectedAmount);
    await token0.connect(alice).approve(memswap.address, intent.expectedAmount);

    const buyBalancesBefore = {
      alice: await ethers.provider.getBalance(alice.address),
      bob: await ethers.provider.getBalance(bob.address),
    };
    const sellBalancesBefore = {
      alice: await token0.balanceOf(alice.address),
      bob: await token0.balanceOf(bob.address),
    };

    await memswap.connect(bob).solve(
      [intent],
      {
        data: "0x",
        fillAmounts: [intent.amount],
        executeAmounts: [intent.expectedAmount],
      },
      [],
      {
        value: intent.amount,
      }
    );

    const buyBalancesAfter = {
      alice: await ethers.provider.getBalance(alice.address),
      bob: await ethers.provider.getBalance(bob.address),
    };
    const sellBalancesAfter = {
      alice: await token0.balanceOf(alice.address),
      bob: await token0.balanceOf(bob.address),
    };

    expect(buyBalancesAfter.alice.sub(buyBalancesBefore.alice)).to.eq(
      intent.amount
    );
    // Use `gte` instead of `eq` to cover gas fees
    expect(buyBalancesBefore.bob.sub(buyBalancesAfter.bob)).to.be.gte(
      intent.amount
    );
    expect(sellBalancesBefore.alice.sub(sellBalancesAfter.alice)).to.eq(
      intent.expectedAmount
    );
    expect(sellBalancesAfter.bob.sub(sellBalancesBefore.bob)).to.eq(
      intent.expectedAmount
    );
  });
});
