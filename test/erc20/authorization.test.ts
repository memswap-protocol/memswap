import { defaultAbiCoder } from "@ethersproject/abi";
import { AddressZero } from "@ethersproject/constants";
import { Contract } from "@ethersproject/contracts";
import { SignerWithAddress } from "@nomiclabs/hardhat-ethers/signers";
import { expect } from "chai";
import { ethers } from "hardhat";

import {
  Authorization,
  Intent,
  getIntentHash,
  signAuthorization,
  signIntent,
} from "./utils";
import { bn, getCurrentTimestamp } from "../utils";

describe("[ERC20] Authorization", async () => {
  let deployer: SignerWithAddress;
  let alice: SignerWithAddress;
  let bob: SignerWithAddress;
  let carol: SignerWithAddress;
  let dan: SignerWithAddress;

  let memswap: Contract;

  let solutionProxy: Contract;
  let token0: Contract;
  let token1: Contract;

  beforeEach(async () => {
    [deployer, alice, bob, carol, dan] = await ethers.getSigners();

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

  it("On-chain sell authorization", async () => {
    const currentTime = await getCurrentTimestamp();

    // Generate intent
    const intent: Intent = {
      isBuy: false,
      buyToken: token1.address,
      sellToken: token0.address,
      maker: alice.address,
      solver: bob.address,
      source: AddressZero,
      feeBps: 0,
      surplusBps: 0,
      startTime: currentTime,
      endTime: currentTime + 60,
      nonce: 0,
      isPartiallyFillable: true,
      isSmartOrder: false,
      amount: ethers.utils.parseEther("0.5"),
      endAmount: ethers.utils.parseEther("0.3"),
      startAmountBps: 0,
      expectedAmountBps: 0,
    };
    intent.signature = await signIntent(alice, memswap.address, intent);

    // Mint and approve
    await token0.connect(alice).mint(intent.amount);
    await token0.connect(alice).approve(memswap.address, intent.amount);

    // Compute start amount
    const startAmount = bn(intent.endAmount).add(
      bn(intent.endAmount).mul(intent.startAmountBps).div(10000)
    );

    // Without authorization, cannot fill an intent of a different matchmaker
    await expect(
      solutionProxy.connect(carol).solve(
        [intent],
        {
          data: defaultAbiCoder.encode(
            ["address", "uint128"],
            [intent.buyToken, startAmount]
          ),
          fillAmounts: [intent.amount],
          executeAmounts: [startAmount],
        },
        []
      )
    ).to.be.revertedWith("Unauthorized");
    await expect(
      solutionProxy.connect(carol).solveWithOnChainAuthorizationCheck(
        [intent],
        {
          data: defaultAbiCoder.encode(
            ["address", "uint128"],
            [intent.buyToken, startAmount]
          ),
          fillAmounts: [intent.amount],
          executeAmounts: [startAmount],
        },
        []
      )
    ).to.be.revertedWith("AuthorizationIsExpired");

    // Authorization must come from the intent matchmaker
    {
      const authorization: Authorization = {
        intentHash: getIntentHash(intent),
        solver: solutionProxy.address,
        fillAmountToCheck: intent.amount,
        executeAmountToCheck: intent.endAmount,
        blockDeadline: await ethers.provider
          .getBlock("latest")
          .then((b) => b.number + 2),
      };

      await expect(
        memswap
          .connect(dan)
          .authorize([intent], [authorization], solutionProxy.address)
      ).to.be.revertedWith("Unauthorized");
    }

    // Fill amount should pass the authorization amount check
    {
      const amountAuthorized = ethers.utils.parseEther("0.4");
      const amountToFill = ethers.utils.parseEther("0.45");

      const authorization: Authorization = {
        intentHash: getIntentHash(intent),
        solver: solutionProxy.address,
        fillAmountToCheck: amountAuthorized,
        executeAmountToCheck: intent.endAmount,
        blockDeadline: await ethers.provider
          .getBlock("latest")
          .then((b) => b.number + 2),
      };

      await memswap
        .connect(bob)
        .authorize([intent], [authorization], solutionProxy.address);

      await expect(
        solutionProxy.connect(carol).solveWithOnChainAuthorizationCheck(
          [intent],
          {
            data: defaultAbiCoder.encode(
              ["address", "uint128"],
              [intent.buyToken, startAmount]
            ),
            fillAmounts: [amountToFill],
            executeAmounts: [startAmount],
          },
          []
        )
      ).to.be.revertedWith("AuthorizationAmountMismatch");
    }

    // Cannot use expired authorization
    {
      const amountAuthorized = ethers.utils.parseEther("0.4");
      const amountToFill = ethers.utils.parseEther("0.4");

      const authorization: Authorization = {
        intentHash: getIntentHash(intent),
        solver: solutionProxy.address,
        fillAmountToCheck: amountAuthorized,
        executeAmountToCheck: intent.endAmount,
        blockDeadline: await ethers.provider
          .getBlock("latest")
          .then((b) => b.number + 1),
      };

      await memswap
        .connect(bob)
        .authorize([intent], [authorization], solutionProxy.address);

      await expect(
        solutionProxy.connect(carol).solveWithOnChainAuthorizationCheck(
          [intent],
          {
            data: defaultAbiCoder.encode(
              ["address", "uint128"],
              [intent.buyToken, startAmount]
            ),
            fillAmounts: [amountToFill],
            executeAmounts: [startAmount],
          },
          []
        )
      ).to.be.revertedWith("AuthorizationIsExpired");
    }

    // Cannot fill less at a worse rate than authorized
    {
      const amountToCheck = startAmount.add(1);

      const authorization: Authorization = {
        intentHash: getIntentHash(intent),
        solver: solutionProxy.address,
        fillAmountToCheck: intent.amount,
        executeAmountToCheck: amountToCheck,
        blockDeadline: await ethers.provider
          .getBlock("latest")
          .then((b) => b.number + 2),
      };

      await memswap
        .connect(bob)
        .authorize([intent], [authorization], solutionProxy.address);

      await expect(
        solutionProxy.connect(carol).solveWithOnChainAuthorizationCheck(
          [intent],
          {
            data: defaultAbiCoder.encode(
              ["address", "uint128"],
              [intent.buyToken, startAmount]
            ),
            fillAmounts: [intent.amount],
            executeAmounts: [startAmount],
          },
          []
        )
      ).to.be.revertedWith("AmountCheckFailed");
    }

    it("On-chain sell authorization", async () => {
      const currentTime = await getCurrentTimestamp();

      // Generate intent
      const intent: Intent = {
        isBuy: false,
        buyToken: token1.address,
        sellToken: token0.address,
        maker: alice.address,
        solver: bob.address,
        source: AddressZero,
        feeBps: 0,
        surplusBps: 0,
        startTime: currentTime,
        endTime: currentTime + 60,
        nonce: 0,
        isPartiallyFillable: true,
        isSmartOrder: false,
        amount: ethers.utils.parseEther("0.5"),
        endAmount: ethers.utils.parseEther("0.3"),
        startAmountBps: 0,
        expectedAmountBps: 0,
      };
      intent.signature = await signIntent(alice, memswap.address, intent);

      // Mint and approve
      await token0.connect(alice).mint(intent.amount);
      await token0.connect(alice).approve(memswap.address, intent.amount);

      // Compute start amount
      const startAmount = bn(intent.endAmount).add(
        bn(intent.endAmount).mul(intent.startAmountBps).div(10000)
      );

      // Without authorization, cannot fill an intent of a different matchmaker
      await expect(
        solutionProxy.connect(carol).solve(
          [intent],
          {
            data: defaultAbiCoder.encode(
              ["address", "uint128"],
              [intent.buyToken, startAmount]
            ),
            fillAmounts: [intent.amount],
            executeAmounts: [startAmount],
          },
          []
        )
      ).to.be.revertedWith("Unauthorized");
      await expect(
        solutionProxy.connect(carol).solveWithOnChainAuthorizationCheck(
          [intent],
          {
            data: defaultAbiCoder.encode(
              ["address", "uint128"],
              [intent.buyToken, startAmount]
            ),
            fillAmounts: [intent.amount],
            executeAmounts: [startAmount],
          },
          []
        )
      ).to.be.revertedWith("AuthorizationIsExpired");

      // Authorization must come from the intent matchmaker
      {
        const authorization: Authorization = {
          intentHash: getIntentHash(intent),
          solver: solutionProxy.address,
          fillAmountToCheck: intent.amount,
          executeAmountToCheck: intent.endAmount,
          blockDeadline: await ethers.provider
            .getBlock("latest")
            .then((b) => b.number + 2),
        };

        await expect(
          memswap
            .connect(dan)
            .authorize([intent], [authorization], solutionProxy.address)
        ).to.be.revertedWith("Unauthorized");
      }

      // Fill amount should pass the authorization amount check
      {
        const amountAuthorized = ethers.utils.parseEther("0.4");
        const amountToFill = ethers.utils.parseEther("0.45");

        const authorization: Authorization = {
          intentHash: getIntentHash(intent),
          solver: solutionProxy.address,
          fillAmountToCheck: amountAuthorized,
          executeAmountToCheck: intent.endAmount,
          blockDeadline: await ethers.provider
            .getBlock("latest")
            .then((b) => b.number + 2),
        };

        await memswap
          .connect(bob)
          .authorize([intent], [authorization], solutionProxy.address);

        await expect(
          solutionProxy.connect(carol).solveWithOnChainAuthorizationCheck(
            [intent],
            {
              data: defaultAbiCoder.encode(
                ["address", "uint128"],
                [intent.buyToken, startAmount]
              ),
              fillAmounts: [amountToFill],
              executeAmounts: [startAmount],
            },
            []
          )
        ).to.be.revertedWith("AuthorizationAmountMismatch");
      }

      // Cannot use expired authorization
      {
        const amountAuthorized = ethers.utils.parseEther("0.4");
        const amountToFill = ethers.utils.parseEther("0.4");

        const authorization: Authorization = {
          intentHash: getIntentHash(intent),
          solver: solutionProxy.address,
          fillAmountToCheck: amountAuthorized,
          executeAmountToCheck: intent.endAmount,
          blockDeadline: await ethers.provider
            .getBlock("latest")
            .then((b) => b.number + 1),
        };

        await memswap
          .connect(bob)
          .authorize([intent], [authorization], solutionProxy.address);

        await expect(
          solutionProxy.connect(carol).solveWithOnChainAuthorizationCheck(
            [intent],
            {
              data: defaultAbiCoder.encode(
                ["address", "uint128"],
                [intent.buyToken, startAmount]
              ),
              fillAmounts: [amountToFill],
              executeAmounts: [startAmount],
            },
            []
          )
        ).to.be.revertedWith("AuthorizationIsExpired");
      }

      // Cannot fill less at a worse rate than authorized
      {
        const amountToCheck = startAmount.add(1);

        const authorization: Authorization = {
          intentHash: getIntentHash(intent),
          solver: solutionProxy.address,
          fillAmountToCheck: intent.amount,
          executeAmountToCheck: amountToCheck,
          blockDeadline: await ethers.provider
            .getBlock("latest")
            .then((b) => b.number + 2),
        };

        await memswap
          .connect(bob)
          .authorize([intent], [authorization], solutionProxy.address);

        await expect(
          solutionProxy.connect(carol).solveWithOnChainAuthorizationCheck(
            [intent],
            {
              data: defaultAbiCoder.encode(
                ["address", "uint128"],
                [intent.buyToken, startAmount]
              ),
              fillAmounts: [intent.amount],
              executeAmounts: [startAmount],
            },
            []
          )
        ).to.be.revertedWith("AmountCheckFailed");
      }

      // Successful fill
      {
        const authorization: Authorization = {
          intentHash: getIntentHash(intent),
          solver: solutionProxy.address,
          fillAmountToCheck: intent.amount,
          executeAmountToCheck: intent.endAmount,
          blockDeadline: await ethers.provider
            .getBlock("latest")
            .then((b) => b.number + 2),
        };

        await memswap
          .connect(bob)
          .authorize([intent], [authorization], solutionProxy.address);

        await expect(
          solutionProxy.connect(carol).solveWithOnChainAuthorizationCheck(
            [intent],
            {
              data: defaultAbiCoder.encode(
                ["address", "uint128"],
                [intent.buyToken, startAmount]
              ),
              fillAmounts: [intent.amount],
              executeAmounts: [startAmount],
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
            startAmount,
            intent.amount
          );
      }
    });

    // Successful fill
    {
      const authorization: Authorization = {
        intentHash: getIntentHash(intent),
        solver: solutionProxy.address,
        fillAmountToCheck: intent.amount,
        executeAmountToCheck: startAmount,
        blockDeadline: await ethers.provider
          .getBlock("latest")
          .then((b) => b.number + 2),
      };

      await memswap
        .connect(bob)
        .authorize([intent], [authorization], solutionProxy.address);

      await expect(
        solutionProxy.connect(carol).solveWithOnChainAuthorizationCheck(
          [intent],
          {
            data: defaultAbiCoder.encode(
              ["address", "uint128"],
              [intent.buyToken, startAmount]
            ),
            fillAmounts: [intent.amount],
            executeAmounts: [startAmount],
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
          startAmount,
          intent.amount
        );
    }
  });

  it("On-chain buy authorization", async () => {
    const currentTime = await getCurrentTimestamp();

    // Generate intent
    const intent: Intent = {
      isBuy: true,
      buyToken: token1.address,
      sellToken: token0.address,
      maker: alice.address,
      solver: bob.address,
      source: AddressZero,
      feeBps: 0,
      surplusBps: 0,
      startTime: currentTime,
      endTime: currentTime + 60,
      nonce: 0,
      isPartiallyFillable: true,
      isSmartOrder: false,
      amount: ethers.utils.parseEther("0.5"),
      endAmount: ethers.utils.parseEther("0.3"),
      startAmountBps: 0,
      expectedAmountBps: 0,
    };
    intent.signature = await signIntent(alice, memswap.address, intent);

    // Mint and approve
    await token0.connect(alice).mint(intent.endAmount);
    await token0.connect(alice).approve(memswap.address, intent.endAmount);

    // Cannot fill less at a worse rate than authorized
    {
      const amountToCheck = bn(intent.endAmount).sub(1);

      const authorization: Authorization = {
        intentHash: getIntentHash(intent),
        solver: solutionProxy.address,
        fillAmountToCheck: intent.amount,
        executeAmountToCheck: amountToCheck,
        blockDeadline: await ethers.provider
          .getBlock("latest")
          .then((b) => b.number + 2),
      };

      await memswap
        .connect(bob)
        .authorize([intent], [authorization], solutionProxy.address);

      await expect(
        solutionProxy.connect(carol).solveWithOnChainAuthorizationCheck(
          [intent],
          {
            data: defaultAbiCoder.encode(
              ["address", "uint128"],
              [intent.buyToken, intent.amount]
            ),
            fillAmounts: [intent.amount],
            executeAmounts: [intent.endAmount],
          },
          []
        )
      ).to.be.revertedWith("AmountCheckFailed");
    }

    // Successful fill
    {
      const authorization: Authorization = {
        intentHash: getIntentHash(intent),
        solver: solutionProxy.address,
        fillAmountToCheck: intent.amount,
        executeAmountToCheck: intent.endAmount,
        blockDeadline: await ethers.provider
          .getBlock("latest")
          .then((b) => b.number + 2),
      };

      await memswap
        .connect(bob)
        .authorize([intent], [authorization], solutionProxy.address);

      await expect(
        solutionProxy.connect(carol).solveWithOnChainAuthorizationCheck(
          [intent],
          {
            data: defaultAbiCoder.encode(
              ["address", "uint128"],
              [intent.buyToken, intent.amount]
            ),
            fillAmounts: [intent.amount],
            executeAmounts: [intent.endAmount],
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
          intent.amount,
          intent.endAmount
        );
    }
  });

  it("Signature sell authorization", async () => {
    const currentTime = await getCurrentTimestamp();

    // Generate intent
    const intent: Intent = {
      isBuy: false,
      buyToken: token1.address,
      sellToken: token0.address,
      maker: alice.address,
      solver: bob.address,
      source: AddressZero,
      feeBps: 0,
      surplusBps: 0,
      startTime: currentTime,
      endTime: currentTime + 60,
      nonce: 0,
      isPartiallyFillable: true,
      isSmartOrder: false,
      amount: ethers.utils.parseEther("0.5"),
      endAmount: ethers.utils.parseEther("0.3"),
      startAmountBps: 0,
      expectedAmountBps: 0,
    };
    intent.signature = await signIntent(alice, memswap.address, intent);

    // Mint and approve
    await token0.connect(alice).mint(intent.amount);
    await token0.connect(alice).approve(memswap.address, intent.amount);

    // Compute start amount
    const startAmount = bn(intent.endAmount).add(
      bn(intent.endAmount).mul(intent.startAmountBps).div(10000)
    );

    // Authorization must come from the intent solver
    {
      const authorization: Authorization = {
        intentHash: getIntentHash(intent),
        solver: solutionProxy.address,
        fillAmountToCheck: intent.amount,
        executeAmountToCheck: startAmount,
        blockDeadline: await ethers.provider
          .getBlock("latest")
          .then((b) => b.number + 2),
      };
      authorization.signature = await signAuthorization(
        dan,
        memswap.address,
        authorization
      );

      await expect(
        solutionProxy.connect(carol).solveWithSignatureAuthorizationCheck(
          [intent],
          {
            data: defaultAbiCoder.encode(
              ["address", "uint128"],
              [intent.buyToken, startAmount]
            ),
            fillAmounts: [intent.amount],
            executeAmounts: [startAmount],
          },
          [
            {
              authorization,
              signature: authorization.signature,
            },
          ],
          []
        )
      ).to.be.revertedWith("InvalidSignature");
    }

    // Authorization must be given to solver
    {
      const authorization: Authorization = {
        intentHash: getIntentHash(intent),
        solver: dan.address,
        fillAmountToCheck: intent.amount,
        executeAmountToCheck: startAmount,
        blockDeadline: await ethers.provider
          .getBlock("latest")
          .then((b) => b.number + 2),
      };
      authorization.signature = await signAuthorization(
        bob,
        memswap.address,
        authorization
      );

      await expect(
        solutionProxy.connect(carol).solveWithSignatureAuthorizationCheck(
          [intent],
          {
            data: defaultAbiCoder.encode(
              ["address", "uint128"],
              [intent.buyToken, startAmount]
            ),
            fillAmounts: [intent.amount],
            executeAmounts: [startAmount],
          },
          [
            {
              authorization,
              signature: authorization.signature,
            },
          ],
          []
        )
      ).to.be.revertedWith("InvalidSignature");
    }

    // Successful fill
    {
      const authorization: Authorization = {
        intentHash: getIntentHash(intent),
        solver: solutionProxy.address,
        fillAmountToCheck: intent.amount,
        executeAmountToCheck: startAmount,
        blockDeadline: await ethers.provider
          .getBlock("latest")
          .then((b) => b.number + 2),
      };
      authorization.signature = await signAuthorization(
        bob,
        memswap.address,
        authorization
      );

      await expect(
        solutionProxy.connect(carol).solveWithSignatureAuthorizationCheck(
          [intent],
          {
            data: defaultAbiCoder.encode(
              ["address", "uint128"],
              [intent.buyToken, startAmount]
            ),
            fillAmounts: [intent.amount],
            executeAmounts: [startAmount],
          },
          [
            {
              authorization,
              signature: authorization.signature,
            },
          ],
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
          startAmount,
          intent.amount
        );
    }
  });

  it("Signature buy authorization", async () => {
    const currentTime = await getCurrentTimestamp();

    // Generate intent
    const intent: Intent = {
      isBuy: true,
      buyToken: token1.address,
      sellToken: token0.address,
      maker: alice.address,
      solver: bob.address,
      source: AddressZero,
      feeBps: 0,
      surplusBps: 0,
      startTime: currentTime,
      endTime: currentTime + 60,
      nonce: 0,
      isPartiallyFillable: true,
      isSmartOrder: false,
      amount: ethers.utils.parseEther("0.5"),
      endAmount: ethers.utils.parseEther("0.3"),
      startAmountBps: 0,
      expectedAmountBps: 0,
    };
    intent.signature = await signIntent(alice, memswap.address, intent);

    // Mint and approve
    await token0.connect(alice).mint(intent.endAmount);
    await token0.connect(alice).approve(memswap.address, intent.endAmount);

    // Successful fill
    {
      const authorization: Authorization = {
        intentHash: getIntentHash(intent),
        solver: solutionProxy.address,
        fillAmountToCheck: intent.amount,
        executeAmountToCheck: intent.endAmount,
        blockDeadline: await ethers.provider
          .getBlock("latest")
          .then((b) => b.number + 2),
      };
      authorization.signature = await signAuthorization(
        bob,
        memswap.address,
        authorization
      );

      await expect(
        solutionProxy.connect(carol).solveWithSignatureAuthorizationCheck(
          [intent],
          {
            data: defaultAbiCoder.encode(
              ["address", "uint128"],
              [intent.buyToken, intent.amount]
            ),
            fillAmounts: [intent.amount],
            executeAmounts: [intent.endAmount],
          },
          [
            {
              authorization,
              signature: authorization.signature,
            },
          ],
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
          intent.amount,
          intent.endAmount
        );
    }
  });
});
