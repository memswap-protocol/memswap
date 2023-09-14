import { Interface, defaultAbiCoder } from "@ethersproject/abi";
import { AddressZero } from "@ethersproject/constants";
import { JsonRpcProvider } from "@ethersproject/providers";
import { parse, serialize } from "@ethersproject/transactions";
import { parseUnits } from "@ethersproject/units";
import { Wallet } from "@ethersproject/wallet";
import { FlashbotsBundleRawTransaction } from "@flashbots/ethers-provider-bundle";
import axios from "axios";
import { Queue, Worker } from "bullmq";
import { randomUUID } from "crypto";

import {
  SOLUTION_PROXY_ERC721,
  MATCHMAKER,
  MEMETH,
} from "../../common/addresses";
import { logger } from "../../common/logger";
import {
  Authorization,
  IntentERC721,
  SolutionERC721,
  TxData,
} from "../../common/types";
import {
  PESSIMISTIC_BLOCK_TIME,
  bn,
  getAuthorizationHash,
  getIntentHash,
  isIntentFilled,
  isTxIncluded,
  now,
} from "../../common/utils";
import { config } from "../config";
import { redis } from "../redis";
import * as solutions from "../solutions";
import { BuySolutionDataERC721 } from "../types";
import {
  getFlashbotsProvider,
  relayViaBloxroute,
  relayViaFlashbots,
  relayViaTransaction,
} from "../utils";

const COMPONENT = "tx-solver-erc721";

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
    const { intent, approvalTxOrTxHash, existingSolution, authorization } =
      job.data as {
        intent: IntentERC721;
        approvalTxOrTxHash?: string;
        existingSolution?: SolutionERC721;
        authorization?: Authorization;
      };

    try {
      const perfTime1 = performance.now();

      const provider = new JsonRpcProvider(config.jsonUrl);
      const flashbotsProvider = await getFlashbotsProvider();

      const perfTime12 = performance.now();

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

      const perfTime2 = performance.now();

      // Starting tip is 1 gwei
      let maxPriorityFeePerGas = parseUnits("1", "gwei");

      // TODO: Compute this dynamically
      const gasLimit = 500000;

      // Approximations for gas used by memswap logic and gas used by swap logic
      const memswapGas = 150000;
      const defaultGas = 200000;

      let solution: SolutionERC721;
      if (existingSolution) {
        // Reuse existing solution

        solution = existingSolution;
      } else {
        // Check and generate solution

        if (!intent.isBuy) {
          logger.info(
            COMPONENT,
            JSON.stringify({
              msg: "Sell intents not yet supported",
              intent,
              intentHash,
              approvalTxOrTxHash,
            })
          );
          return;
        }

        if (intent.sellToken !== MEMETH[config.chainId]) {
          logger.info(
            COMPONENT,
            JSON.stringify({
              msg: "Non-ETH intents are not yet supported",
              intent,
              intentHash,
              approvalTxOrTxHash,
            })
          );
          return;
        }

        if (!(intent.isCriteriaOrder && intent.tokenIdOrCriteria === "0")) {
          logger.info(
            COMPONENT,
            JSON.stringify({
              msg: "Non-contract-wide intents ar enot yet supported",
              intent,
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

        if (![solver.address, AddressZero].includes(intent.solver)) {
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
        const latestBaseFee = await provider
          .getBlock("pending")
          .then((b) => b!.baseFeePerGas!);

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

        const { data: solutionDetails } = (await solutions.reservoir.solve(
          intent,
          intent.amount,
          provider
        )) as { data: BuySolutionDataERC721 };

        const gasConsumed = bn(memswapGas)
          .add(solutionDetails.gasUsed ?? defaultGas)
          .toString();

        if (bn(solutionDetails.maxSellAmountInEth).gt(maxAmountIn)) {
          logger.error(
            COMPONENT,
            JSON.stringify({
              msg: "Solution not good enough",
              solutionAmountIn: solutionDetails.maxSellAmountInEth,
              maxAmountIn: maxAmountIn.toString(),
              intentHash,
              approvalTxOrTxHash,
            })
          );
          return;
        }

        const grossProfitInETH = bn(solutionDetails.maxSellAmountInEth).sub(
          maxAmountIn
        );

        const gasFee = latestBaseFee.add(maxPriorityFeePerGas).mul(gasConsumed);
        const netProfitInETH = grossProfitInETH.sub(gasFee);

        logger.info(
          COMPONENT,
          JSON.stringify({
            msg: "Profit breakdown",
            solutionDetails,
            maxAmountIn: maxAmountIn.toString(),
            grossProfitInETH: grossProfitInETH.toString(),
            netProfitInETH: netProfitInETH.toString(),
            gasConsumed,
            gasFee: gasFee.toString(),
          })
        );

        if (config.chainId === 1 && netProfitInETH.lte(0)) {
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

        if (netProfitInETH.gt(0)) {
          // Assume other solvers compete for the same intent and so increase the
          // tip to the block builder as much as possible while we're profitable.
          // This will also result in the bundles being included faster.
          const minTipIncrement = parseUnits("0.01", "gwei");
          const gasPerTipIncrement = minTipIncrement.mul(gasConsumed);

          // Deduct from the 40% of the profit
          const minTipUnits = netProfitInETH
            .mul(4000)
            .div(10000)
            .div(gasPerTipIncrement);
          maxPriorityFeePerGas = maxPriorityFeePerGas.add(
            minTipIncrement.mul(minTipUnits)
          );

          // Give 50% of the profit back to the user
          maxAmountIn = maxAmountIn.sub(netProfitInETH.mul(5000).div(10000));

          // The rest of 10% from the profit is kept

          logger.info(
            COMPONENT,
            JSON.stringify({
              msg: "Tip increment",
              intentHash,
              gasPerTipIncrement: gasPerTipIncrement.toString(),
              minTipUnits: minTipUnits.toString(),
              maxPriorityFeePerGas: maxPriorityFeePerGas.toString(),
              newMaxPriorityFeePerGas: maxPriorityFeePerGas
                .add(minTipIncrement.mul(minTipUnits))
                .toString(),
            })
          );
        }

        solution = {
          txs: solutionDetails.txs,
          data: defaultAbiCoder.encode(
            ["(address to, bytes data, uint256 value)[]"],
            [solutionDetails.calls]
          ),
          fillTokenDetails: solutionDetails.tokenIds.map((tokenId) => ({
            tokenId,
            criteriaProof: [],
          })),
        };
      }

      const perfTime3 = performance.now();

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
      const estimatedBaseFee = await provider.getBlock("pending").then((b) => {
        // Handle weird issue when the base fee gets returned in gwei rather than wei
        const converted =
          b!.baseFeePerGas!.toString().length <= 3
            ? parseUnits(b!.baseFeePerGas!.toString(), "gwei")
            : b!.baseFeePerGas!;
        return converted.add(converted.mul(3000).div(10000));
      });

      const perfTime4 = performance.now();

      const getFillerTxs = async (
        intent: IntentERC721,
        authorization?: Authorization
      ) => {
        let method: string;
        if (intent.solver === MATCHMAKER[config.chainId] && authorization) {
          // For relaying
          method = "solveWithSignatureAuthorizationCheck";
        } else if (intent.solver === MATCHMAKER[config.chainId]) {
          // For matchmaker submission
          method = "solveWithOnChainAuthorizationCheck";
        } else {
          // For relaying
          method = "solve";
        }

        let nonce = await provider.getTransactionCount(solver.address);

        const solverTxs = [
          ...solution.txs,
          {
            to: SOLUTION_PROXY_ERC721[config.chainId],
            value: 0,
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
                    bool isCriteriaOrder,
                    uint256 tokenIdOrCriteria,
                    uint128 amount,
                    uint128 endAmount,
                    uint16 startAmountBps,
                    uint16 expectedAmountBps,
                    bytes signature
                  ) intent,
                  (
                    bytes data,
                    (
                      uint256 tokenId,
                      bytes32[] criteriaProof
                    )[] fillTokenDetails
                  ) solution,
                  ${
                    authorization
                      ? `
                        (
                          uint128 fillAmountToCheck,
                          uint128 executeAmountToCheck,
                          uint32 blockDeadline
                        ) auth,
                        bytes authSignature,
                      `
                      : ""
                  }
                  ${`
                    (
                      uint8 kind,
                      bytes data
                    )[] permits
                  `}
                )
              `,
            ]).encodeFunctionData(
              method,
              method === "solveWithSignatureAuthorizationCheck"
                ? [
                    intent,
                    solution,
                    authorization,
                    authorization?.signature!,
                    [],
                  ]
                : [intent, solution, []]
            ),
          },
        ];

        const signedSolverTxs: FlashbotsBundleRawTransaction[] = [];
        for (let i = 0; i < solverTxs.length; i++) {
          signedSolverTxs.push({
            signedTransaction: await solver.signTransaction({
              from: solver.address,
              type: 2,
              nonce: nonce + i,
              gasLimit,
              chainId: config.chainId,
              maxFeePerGas: estimatedBaseFee
                .add(maxPriorityFeePerGas)
                .toString(),
              maxPriorityFeePerGas: maxPriorityFeePerGas.toString(),
              ...solverTxs[i],
            }),
          });
        }

        return signedSolverTxs;
      };

      // Whether to include the approval transaction in the bundle
      const includeApprovalTx =
        approvalTxHash && !(await isTxIncluded(approvalTxHash, provider));

      const relayMethod = config.bloxrouteAuth
        ? relayViaBloxroute
        : relayViaFlashbots;

      const perfTime5 = performance.now();

      if (intent.solver !== MATCHMAKER[config.chainId]) {
        // Solve directly

        // If the approval transaction is still pending, include it in the bundle
        const fillerTxs = await getFillerTxs(intent);
        const txs = includeApprovalTx ? [approvalTx!, ...fillerTxs] : fillerTxs;

        const targetBlock =
          (await provider.getBlock("latest").then((b) => b.number)) + 1;

        // Relay
        await relayMethod(
          intentHash,
          provider,
          flashbotsProvider,
          txs,
          targetBlock,
          COMPONENT
        );
      } else {
        // Solve via matchmaker

        if (!authorization) {
          // We don't have an authorization so first we must request it

          logger.info(
            COMPONENT,
            JSON.stringify({
              msg: "Submitting solution to matchmaker",
              intentHash,
              txHash: approvalTxHash,
            })
          );

          const fillerTxs = await getFillerTxs(intent);
          const txs = includeApprovalTx
            ? [
                approvalTx!.signedTransaction,
                ...fillerTxs.map((tx) => tx.signedTransaction),
              ]
            : fillerTxs.map((tx) => tx.signedTransaction);

          // Generate a random uuid for the request
          const uuid = randomUUID();

          await redis.set(
            `solver:${uuid}`,
            JSON.stringify({ intent, approvalTxOrTxHash, solution }),
            "EX",
            PESSIMISTIC_BLOCK_TIME * 4
          );

          await axios.post(`${config.matchmakerBaseUrl}/erc721/solutions`, {
            uuid,
            baseUrl: config.solverBaseUrl,
            intent,
            txs,
          });
        } else {
          // We do have an authorization so all we have to do is relay the transaction

          const targetBlock =
            (await provider.getBlock("latest").then((b) => b.number)) + 1;
          if (targetBlock > authorization.blockDeadline) {
            // If the authorization deadline was exceeded we need to request another authorization
            await job.updateData({
              ...job.data,
              authorization: undefined,
            });

            throw new Error("Authorization deadline exceeded");
          }

          // If the approval transaction is still pending, include it in the bundle
          const fillerTxs = await getFillerTxs(intent, authorization);
          const txs = includeApprovalTx
            ? [approvalTx!, ...fillerTxs]
            : fillerTxs;

          // Relay
          await relayMethod(
            intentHash,
            provider,
            flashbotsProvider,
            txs,
            targetBlock,
            COMPONENT
          );
        }
      }

      const perfTime6 = performance.now();

      logger.info(
        COMPONENT,
        JSON.stringify({
          msg: "Performance measurements for tx-solver",
          time1: (perfTime2 - perfTime1) / 1000,
          time12: (perfTime12 - perfTime1) / 1000,
          time22: (perfTime2 - perfTime12) / 1000,
          time2: (perfTime3 - perfTime2) / 1000,
          time3: (perfTime4 - perfTime3) / 1000,
          time4: (perfTime5 - perfTime4) / 1000,
          time5: (perfTime6 - perfTime5) / 1000,
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
  intent: IntentERC721,
  options?: {
    approvalTxOrTxHash?: string;
    existingSolution?: SolutionERC721;
    authorization?: Authorization;
  },
  delay?: number
) =>
  queue.add(
    randomUUID(),
    {
      intent,
      approvalTxOrTxHash: options?.approvalTxOrTxHash,
      existingSolution: options?.existingSolution,
      authorization: options?.authorization,
    },
    {
      delay: delay ? delay * 1000 : undefined,
      jobId:
        getIntentHash(intent) +
        (options?.authorization
          ? getAuthorizationHash(options.authorization)
          : ""),
    }
  );
