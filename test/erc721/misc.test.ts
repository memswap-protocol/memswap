import { defaultAbiCoder } from "@ethersproject/abi";
import { AddressZero } from "@ethersproject/constants";
import { Contract } from "@ethersproject/contracts";
import { SignerWithAddress } from "@nomiclabs/hardhat-ethers/signers";
import { expect } from "chai";
import { ethers } from "hardhat";

import { Intent, getIntentHash, signIntent } from "./utils";
import { PermitKind, getCurrentTimestamp, signPermit2 } from "../utils";
import { PERMIT2 } from "../../src/common/addresses";

describe("[ERC721] Misc", async () => {
  let chainId: number;

  let deployer: SignerWithAddress;
  let alice: SignerWithAddress;
  let bob: SignerWithAddress;

  let memswap: Contract;
  let nft: Contract;

  let solutionProxy: Contract;
  let token0: Contract;
  let token1: Contract;

  beforeEach(async () => {
    chainId = await ethers.provider.getNetwork().then((n) => n.chainId);

    [deployer, alice, bob] = await ethers.getSigners();

    nft = await ethers
      .getContractFactory("MemswapAlphaNFT")
      .then((factory) => factory.deploy(deployer.address, "", ""));
    memswap = await ethers
      .getContractFactory("MemswapERC721")
      .then((factory) => factory.deploy(nft.address));

    solutionProxy = await ethers
      .getContractFactory("MockSolutionProxy")
      .then((factory) => factory.deploy(memswap.address));
    token0 = await ethers
      .getContractFactory("MockERC20")
      .then((factory) => factory.deploy());
    token1 = await ethers
      .getContractFactory("MockERC721")
      .then((factory) => factory.deploy());

    // Allowed the Memswap contract to mint
    await nft.connect(deployer).setIsAllowedToMint([memswap.address], [true]);

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
      isCriteriaOrder: true,
      tokenIdOrCriteria: 0,
      amount: 2,
      endAmount: ethers.utils.parseEther("0.3"),
      startAmountBps: 0,
      expectedAmountBps: 0,
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
    await solutionProxy.connect(bob).solveERC721(
      intent,
      {
        data: defaultAbiCoder.encode(["uint128"], [0]),
        fillTokenDetails: tokenIdsToFill.map((tokenId) => ({
          tokenId,
          criteriaProof: [],
        })),
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
      isCriteriaOrder: true,
      tokenIdOrCriteria: 0,
      amount: 2,
      endAmount: ethers.utils.parseEther("0.3"),
      startAmountBps: 0,
      expectedAmountBps: 0,
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
      solutionProxy.connect(bob).solveERC721(
        intent,
        {
          data: defaultAbiCoder.encode(["uint128"], [0]),
          fillTokenDetails: tokenIdsToFill.map((tokenId) => ({
            tokenId,
            criteriaProof: [],
          })),
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
      isCriteriaOrder: true,
      tokenIdOrCriteria: 0,
      amount: 2,
      endAmount: ethers.utils.parseEther("0.3"),
      startAmountBps: 0,
      expectedAmountBps: 0,
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
      solutionProxy.connect(bob).solveERC721(
        intent,
        {
          data: defaultAbiCoder.encode(["uint128"], [0]),
          fillTokenDetails: tokenIdsToFill.map((tokenId) => ({
            tokenId,
            criteriaProof: [],
          })),
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
      isCriteriaOrder: true,
      tokenIdOrCriteria: 0,
      amount: 2,
      endAmount: ethers.utils.parseEther("0.3"),
      startAmountBps: 0,
      expectedAmountBps: 0,
    };
    intent.signature = await signIntent(alice, memswap.address, intent);

    // Mint and approve Permit2
    await token0.connect(alice).mint(intent.endAmount);
    await token0.connect(alice).approve(PERMIT2[chainId], intent.endAmount);

    const tokenIdsToFill = [...Array(Number(intent.amount)).keys()];

    // If not permit was passed, the solution transaction will revert
    await expect(
      solutionProxy.connect(bob).solveERC721(
        intent,
        {
          data: defaultAbiCoder.encode(["uint128"], [0]),
          fillTokenDetails: tokenIdsToFill.map((tokenId) => ({
            tokenId,
            criteriaProof: [],
          })),
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

    await solutionProxy.connect(bob).solveERC721(
      intent,
      {
        data: defaultAbiCoder.encode(["uint128"], [0]),
        fillTokenDetails: tokenIdsToFill.map((tokenId) => ({
          tokenId,
          criteriaProof: [],
        })),
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
