import { Interface, defaultAbiCoder } from "@ethersproject/abi";
import { AddressZero } from "@ethersproject/constants";
import { JsonRpcProvider } from "@ethersproject/providers";
import { parse, serialize } from "@ethersproject/transactions";
import { parseEther, parseUnits } from "@ethersproject/units";
import { Wallet } from "@ethersproject/wallet";
import { FlashbotsBundleRawTransaction } from "@flashbots/ethers-provider-bundle";
import axios from "axios";
import { Queue, Worker } from "bullmq";
import { randomUUID } from "crypto";

import {
  MATCHMAKER,
  MEMETH,
  SOLUTION_PROXY,
  WETH9,
} from "../../common/addresses";
import { logger } from "../../common/logger";
import {
  getFlashbotsProvider,
  relayViaBloxroute,
  relayViaFlashbots,
  relayViaTransaction,
} from "../../common/tx";
import { IntentERC20, SolutionERC20 } from "../../common/types";
import {
  MATCHMAKER_AUTHORIZATION_GAS,
  PESSIMISTIC_BLOCK_TIME,
  bn,
  getIncentivizationTip,
  getIntentHash,
  getToken,
  isIntentFilled,
  isTxIncluded,
  now,
} from "../../common/utils";
import { config } from "../config";
import * as jobs from "../jobs";
import { redis } from "../redis";
import * as solutions from "../solutions";
import { BuySolutionDataERC20, SellSolutionDataERC20 } from "../types";

const COMPONENT = "tx-solver-erc20";

export const queue = new Queue(COMPONENT, {
  connection: redis.duplicate(),
  defaultJobOptions: {
    attempts: 10,
    removeOnComplete: 10000,
    removeOnFail: 10000,
  },
});

const worker = new Worker(
  COMPONENT,
  async (job) => {
    const { intent, approvalTxOrTxHash } = job.data as {
      intent: IntentERC20;
      approvalTxOrTxHash?: string;
    };

    try {
      const perfTime1 = performance.now();

      const provider = new JsonRpcProvider(config.jsonUrl);
      const flashbotsProvider = await getFlashbotsProvider();

      const perfTime2 = performance.now();

      const solver = new Wallet(config.solverPk);
      const intentHash = getIntentHash(intent);

      if (await isIntentFilled(intent, config.chainId, provider)) {
        logger.info(
          COMPONENT,
          JSON.stringify({
            msg: "Filled",
            intentHash,
            approvalTxOrTxHash,
          })
        );
        return;
      }

      const perfTime3 = performance.now();

      // Starting tip is 1 gwei (which is also the required priority fee for incentivized intents)
      let maxPriorityFeePerGas = parseUnits("1", "gwei");

      // TODO: Compute this dynamically
      const gasLimit = 800000;

      // Approximations for gas used by memswap logic, swap logic and matchmaker authorization logic
      const memswapGas = 150000;
      const defaultGas = 200000;

      if (intent.sellToken === AddressZero) {
        logger.info(
          COMPONENT,
          JSON.stringify({
            msg: "Unsupported sell token",
            intentHash,
            approvalTxOrTxHash,
          })
        );
        return;
      }

      if (
        (intent.sellToken === MEMETH[config.chainId] &&
          intent.buyToken === WETH9[config.chainId]) ||
        (intent.sellToken === WETH9[config.chainId] &&
          intent.buyToken === AddressZero)
      ) {
        logger.info(
          COMPONENT,
          JSON.stringify({
            msg: "Attempted to wrap/unwrap WETH",
            intentHash,
            approvalTxOrTxHash,
          })
        );
        return;
      }

      if (intent.startTime > now()) {
        logger.info(
          COMPONENT,
          JSON.stringify({
            msg: "Not started",
            now: now(),
            startTime: intent.startTime,
            intentHash,
            approvalTxOrTxHash,
          })
        );
        return;
      }

      if (intent.endTime <= now()) {
        logger.info(
          COMPONENT,
          JSON.stringify({
            msg: "Expired",
            now: now(),
            endTime: intent.endTime,
            intentHash,
            approvalTxOrTxHash,
          })
        );
        return;
      }

      if (
        ![solver.address, AddressZero, MATCHMAKER[config.chainId]].includes(
          intent.solver
        )
      ) {
        logger.info(
          COMPONENT,
          JSON.stringify({
            msg: "Unsupported solver",
            solver: intent.solver,
            intentHash,
            approvalTxOrTxHash,
          })
        );
        return;
      }

      logger.info(
        COMPONENT,
        JSON.stringify({
          msg: "Generating solution",
          intentHash,
          approvalTxOrTxHash,
        })
      );

      const latestBlock = await provider.getBlock("latest");
      const latestTimestamp = latestBlock.timestamp + PESSIMISTIC_BLOCK_TIME;

      let solution: SolutionERC20;
      if (!intent.isBuy) {
        // Sell

        const endAmount = bn(intent.endAmount);
        const startAmount = endAmount.add(
          endAmount.mul(intent.startAmountBps).div(10000)
        );
        const expectedAmount = endAmount.add(
          endAmount.mul(intent.expectedAmountBps).div(10000)
        );

        let minAmountOut = startAmount.sub(
          startAmount
            .sub(endAmount)
            .mul(latestTimestamp - intent.startTime)
            .div(intent.endTime - intent.startTime)
        );

        const { data: solutionDetails } = (await solutions.zeroex.solve(
          intent,
          intent.amount
        )) as { data: SellSolutionDataERC20 };

        const gasConsumed = bn(memswapGas)
          .add(solutionDetails.gasUsed ?? defaultGas)
          .toString();

        if (bn(solutionDetails.minBuyAmount).lt(minAmountOut)) {
          logger.error(
            COMPONENT,
            JSON.stringify({
              msg: "Solution not good enough",
              solutionAmountOut: solutionDetails.minBuyAmount,
              minAmountOut: minAmountOut.toString(),
              intentHash,
              approvalTxOrTxHash,
            })
          );
          return;
        }

        const buyTokenDecimals = await getToken(intent.buyToken, provider).then(
          (t) => t.decimals
        );
        const grossProfitInBuyToken = bn(solutionDetails.minBuyAmount).sub(
          minAmountOut
        );
        const grossProfitInEth = grossProfitInBuyToken
          .mul(parseEther("1"))
          .div(parseUnits(solutionDetails.buyTokenToEthRate, buyTokenDecimals));

        solution = {
          fillAmount: intent.amount,
          executeAmount: minAmountOut.toString(),
          expectedAmount: expectedAmount.toString(),
          calls: solutionDetails.calls,
          executeTokenToEthRate: solutionDetails.buyTokenToEthRate,
          executeTokenDecimals: buyTokenDecimals,
          grossProfitInEth: grossProfitInEth.toString(),
          gasConsumed,
        };
      } else {
        const endAmount = bn(intent.endAmount);
        const startAmount = endAmount.sub(
          endAmount.mul(intent.startAmountBps).div(10000)
        );
        const expectedAmount = endAmount.sub(
          endAmount.mul(intent.expectedAmountBps).div(10000)
        );

        let maxAmountIn = startAmount.add(
          bn(endAmount)
            .sub(startAmount)
            .mul(latestTimestamp - intent.startTime)
            .div(intent.endTime - intent.startTime)
        );

        // We need to subtract any fees from `maxAmountIn`
        if (intent.feeBps) {
          maxAmountIn = maxAmountIn.sub(
            maxAmountIn.mul(intent.feeBps).div(10000)
          );
        }
        if (intent.surplusBps && maxAmountIn.lt(expectedAmount)) {
          maxAmountIn = maxAmountIn.sub(
            expectedAmount.sub(maxAmountIn).mul(intent.surplusBps).div(10000)
          );
        }

        const { data: solutionDetails } = (await solutions.zeroex.solve(
          intent,
          intent.amount
        )) as { data: BuySolutionDataERC20 };

        const gasConsumed = bn(memswapGas)
          .add(solutionDetails.gasUsed ?? defaultGas)
          .toString();

        if (bn(solutionDetails.maxSellAmount).gt(maxAmountIn)) {
          logger.error(
            COMPONENT,
            JSON.stringify({
              msg: "Solution not good enough",
              solutionAmountIn: solutionDetails.maxSellAmount,
              maxAmountIn: maxAmountIn.toString(),
              intentHash,
              approvalTxOrTxHash,
            })
          );
          return;
        }

        const sellTokenDecimals = await getToken(
          intent.sellToken,
          provider
        ).then((t) => t.decimals);
        const grossProfitInSellToken = maxAmountIn.sub(
          solutionDetails.maxSellAmount
        );
        const grossProfitInEth = grossProfitInSellToken
          .mul(parseEther("1"))
          .div(
            parseUnits(solutionDetails.sellTokenToEthRate, sellTokenDecimals)
          );

        solution = {
          fillAmount: intent.amount,
          executeAmount: maxAmountIn.toString(),
          expectedAmount: expectedAmount.toString(),
          calls: solutionDetails.calls,
          executeTokenToEthRate: solutionDetails.sellTokenToEthRate,
          executeTokenDecimals: sellTokenDecimals,
          grossProfitInEth: grossProfitInEth.toString(),
          gasConsumed,
        };
      }

      const latestBaseFee = await provider
        .getBlock("pending")
        .then((b) => b!.baseFeePerGas!);

      // Compute the amount to pay the matchmaker for covering the on-chain authorization gas cost
      const matchmakerGasFee = bn(MATCHMAKER_AUTHORIZATION_GAS).mul(
        latestBaseFee.add(maxPriorityFeePerGas)
      );
      let matchmakerGasFeeInToken = matchmakerGasFee
        .mul(
          parseUnits(
            solution.executeTokenToEthRate,
            solution.executeTokenDecimals
          )
        )
        .div(parseEther("1"));
      // Adjust up by 3% for safety
      matchmakerGasFeeInToken = matchmakerGasFeeInToken.add(
        matchmakerGasFeeInToken.mul(300).div(10000)
      );

      // If needed, adjust the executed amount given the incentivization tip
      const isMatchmakerIntent = intent.solver === MATCHMAKER[config.chainId];
      if (isMatchmakerIntent) {
        if (intent.isBuy) {
          solution.executeAmount = bn(solution.executeAmount)
            .sub(matchmakerGasFeeInToken)
            .toString();
        } else {
          solution.executeAmount = bn(solution.executeAmount)
            .add(matchmakerGasFeeInToken)
            .toString();
        }
      }

      // Compute the incentiziation tip given the expected and executed amount
      const incentivizationTip = intent.isIncentivized
        ? getIncentivizationTip(
            intent.isBuy,
            solution.expectedAmount,
            intent.expectedAmountBps,
            solution.executeAmount
          ).toString()
        : "0";

      const solverGasFee = latestBaseFee
        .add(maxPriorityFeePerGas)
        .mul(solution.gasConsumed);

      // Compute net profit
      const netProfitInEth = bn(solution.grossProfitInEth)
        .sub(solverGasFee)
        .sub(isMatchmakerIntent ? matchmakerGasFee : 0)
        .sub(incentivizationTip);

      logger.info(
        COMPONENT,
        JSON.stringify({
          msg: "Profit breakdown",
          solution,
          netProfitInEth: netProfitInEth.toString(),
          solverGasFee: solverGasFee.toString(),
          matchmakerGasFee: isMatchmakerIntent
            ? matchmakerGasFee.toString()
            : undefined,
        })
      );

      if (config.chainId === 1 && netProfitInEth.lte(0)) {
        logger.error(
          COMPONENT,
          JSON.stringify({
            msg: "Insufficient solver profit",
            intentHash,
            approvalTxOrTxHash,
          })
        );
        return;
      }

      if (netProfitInEth.gt(0)) {
        if (!intent.isIncentivized) {
          // Assume other solvers compete for the same intent and so increase the
          // tip to the block builder as much as possible while we're profitable.
          // This will also result in the bundles being included faster.
          const minTipIncrement = parseUnits("0.01", "gwei");
          const gasPerTipIncrement = minTipIncrement.mul(solution.gasConsumed);

          // Deduct from the 40% of the profit
          const minTipUnits = netProfitInEth
            .mul(4000)
            .div(10000)
            .div(gasPerTipIncrement);
          maxPriorityFeePerGas = maxPriorityFeePerGas.add(
            minTipIncrement.mul(minTipUnits)
          );

          // Give 50% of the profit back to the user
          const sharedProfit = netProfitInEth
            .mul(5000)
            .div(10000)
            .mul(
              parseUnits(
                solution.executeTokenToEthRate,
                solution.executeTokenDecimals
              )
            )
            .div(parseEther("1"));
          if (intent.isBuy) {
            solution.executeAmount = bn(solution.executeAmount)
              .sub(sharedProfit)
              .toString();
          } else {
            solution.executeAmount = bn(solution.executeAmount)
              .add(sharedProfit)
              .toString();
          }

          // The rest of 10% from the profit is kept

          logger.info(
            COMPONENT,
            JSON.stringify({
              msg: "Tip increment",
              intentHash,
              gasPerTipIncrement: gasPerTipIncrement.toString(),
              minTipUnits: minTipUnits.toString(),
              oldMaxPriorityFeePerGas: maxPriorityFeePerGas
                .sub(minTipIncrement.mul(minTipUnits))
                .toString(),
              newMaxPriorityFeePerGas: maxPriorityFeePerGas.toString(),
            })
          );
        }
      }

      const perfTime4 = performance.now();

      let approvalTx: FlashbotsBundleRawTransaction | undefined;
      let approvalTxHash: string | undefined;
      if (approvalTxOrTxHash && approvalTxOrTxHash.length === 66) {
        // We have a transaction hash
        const tx = await provider.getTransaction(approvalTxOrTxHash);
        approvalTx = {
          signedTransaction: serialize(
            {
              to: tx.to,
              nonce: tx.nonce,
              gasLimit: tx.gasLimit,
              data: tx.data,
              value: tx.value,
              chainId: tx.chainId,
              type: tx.type,
              accessList: tx.accessList,
              maxPriorityFeePerGas: tx.maxPriorityFeePerGas,
              maxFeePerGas: tx.maxFeePerGas,
            },
            {
              v: tx.v!,
              r: tx.r!,
              s: tx.s!,
            }
          ),
        };
        approvalTxHash = approvalTxOrTxHash;
      } else if (approvalTxOrTxHash) {
        // We have a signed transaction
        approvalTx = { signedTransaction: approvalTxOrTxHash };
        approvalTxHash = parse(approvalTxOrTxHash).hash!;
      }

      // Just in case, set to 30% more than the pending block's base fee
      const estimatedBaseFee = await provider
        .getBlock("pending")
        .then((b) =>
          b!.baseFeePerGas!.add(b!.baseFeePerGas!.mul(3000).div(10000))
        );

      const perfTime5 = performance.now();

      const getFillerTx = async (intent: IntentERC20) => {
        let method: string;
        if (isMatchmakerIntent) {
          // For matchmaker submission
          method = "solveWithOnChainAuthorizationCheckERC20";

          // Make sure to cover the matchmaker's gas
          const token = intent.isBuy ? intent.sellToken : intent.buyToken;
          solution.calls.push({
            to: token === AddressZero ? MATCHMAKER[config.chainId] : token,
            data:
              token === AddressZero
                ? "0x"
                : new Interface([
                    "function transfer(address to, uint256 amount)",
                  ]).encodeFunctionData("transfer", [
                    MATCHMAKER[config.chainId],
                    matchmakerGasFeeInToken,
                  ]),
            value:
              token === AddressZero ? matchmakerGasFeeInToken.toString() : "0",
          });
        } else {
          // For direct submission
          method = "solveERC20";
        }

        const encodedSolution = {
          data: defaultAbiCoder.encode(
            ["uint128", "(address to, bytes data, uint256 value)[]"],
            [solution.executeAmount, solution.calls]
          ),
          fillAmount: solution.fillAmount,
        };
        return {
          signedTransaction: await solver.signTransaction({
            from: solver.address,
            to: SOLUTION_PROXY[config.chainId],
            value: incentivizationTip,
            data: new Interface([
              `
                function ${method}(
                  (
                    bool isBuy,
                    address buyToken,
                    address sellToken,
                    address maker,
                    address solver,
                    address source,
                    uint16 feeBps,
                    uint16 surplusBps,
                    uint32 startTime,
                    uint32 endTime,
                    bool isPartiallyFillable,
                    bool isSmartOrder,
                    bool isIncentivized,
                    uint128 amount,
                    uint128 endAmount,
                    uint16 startAmountBps,
                    uint16 expectedAmountBps,
                    bytes signature
                  ) intent,
                  (
                    bytes data,
                    uint128 fillAmount
                  ) solution,
                  ${`
                    (
                      uint8 kind,
                      bytes data
                    )[] permits     
                  `}
                )
              `,
            ]).encodeFunctionData(method, [intent, encodedSolution, []]),
            type: 2,
            nonce: await provider.getTransactionCount(solver.address),
            gasLimit,
            chainId: config.chainId,
            maxFeePerGas: estimatedBaseFee.add(maxPriorityFeePerGas).toString(),
            maxPriorityFeePerGas: maxPriorityFeePerGas.toString(),
          }),
        };
      };

      // Whether to include the approval transaction in the bundle
      const includeApprovalTx =
        approvalTxHash && !(await isTxIncluded(approvalTxHash, provider));

      const relayMethod = config.bloxrouteAuth
        ? relayViaBloxroute
        : relayViaFlashbots;

      const perfTime6 = performance.now();

      // If the approval transaction is still pending, include it in the bundle
      const fillerTx = await getFillerTx(intent);
      const txs = includeApprovalTx ? [approvalTx!, fillerTx] : [fillerTx];

      if (!isMatchmakerIntent) {
        // Solve directly

        // If specified and the conditions allow it, use direct transactions rather than bundles
        let useBundle = true;
        if (
          !includeApprovalTx &&
          Boolean(Number(process.env.RELAY_DIRECTLY_WHEN_POSSIBLE))
        ) {
          useBundle = false;
        }

        if (useBundle) {
          const targetBlock =
            (await provider.getBlock("latest").then((b) => b.number)) + 1;

          // Relay
          await relayMethod(
            intentHash,
            provider,
            flashbotsProvider,
            txs,
            includeApprovalTx ? [approvalTx!] : [],
            targetBlock,
            COMPONENT
          );
        } else {
          // At this point, for sure the approval transaction was already included, so we can skip it
          const fillerTx = await getFillerTx(intent);

          // Relay
          await relayViaTransaction(
            intentHash,
            intent.isIncentivized,
            provider,
            fillerTx.signedTransaction,
            COMPONENT
          );
        }
      } else {
        // Solve via matchmaker

        await axios.post(`${config.matchmakerBaseUrl}/erc20/solutions`, {
          intent,
          txs: txs.map((tx) => tx.signedTransaction),
        });

        // Retry in ~4 blocks to cover any matchmaker failures
        await queue.add(
          randomUUID(),
          {
            intent,
            approvalTxOrTxHash,
          },
          {
            delay: PESSIMISTIC_BLOCK_TIME * 4 * 1000,
          }
        );
      }

      await jobs.inventoryManager.addToQueue(
        intent.isBuy ? intent.sellToken : intent.buyToken
      );

      const perfTime7 = performance.now();

      logger.info(
        COMPONENT,
        JSON.stringify({
          msg: "Performance measurements for tx-solver",
          time12: (perfTime2 - perfTime1) / 1000,
          time23: (perfTime3 - perfTime2) / 1000,
          time34: (perfTime4 - perfTime3) / 1000,
          time45: (perfTime5 - perfTime4) / 1000,
          time56: (perfTime6 - perfTime5) / 1000,
          time67: (perfTime7 - perfTime6) / 1000,
        })
      );
    } catch (error: any) {
      logger.error(
        COMPONENT,
        JSON.stringify({
          msg: "Job failed",
          error: error.response?.data
            ? JSON.stringify(error.response.data)
            : error,
          stack: error.stack,
        })
      );
      throw error;
    }
  },
  { connection: redis.duplicate(), concurrency: 10 }
);
worker.on("error", (error) => {
  logger.error(
    COMPONENT,
    JSON.stringify({
      msg: "Worker errored",
      error,
    })
  );
});

export const addToQueue = async (
  intent: IntentERC20,
  options?: {
    approvalTxOrTxHash?: string;
  },
  delay?: number
) =>
  queue.add(
    randomUUID(),
    {
      intent,
      approvalTxOrTxHash: options?.approvalTxOrTxHash,
    },
    {
      delay: delay ? delay * 1000 : undefined,
      jobId: getIntentHash(intent),
    }
  );
