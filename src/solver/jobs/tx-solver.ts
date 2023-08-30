import { Interface } from "@ethersproject/abi";
import { AddressZero } from "@ethersproject/constants";
import { JsonRpcProvider } from "@ethersproject/providers";
import { parse, serialize } from "@ethersproject/transactions";
import { formatEther, parseEther, parseUnits } from "@ethersproject/units";
import { Wallet } from "@ethersproject/wallet";
import {
  FlashbotsBundleProvider,
  FlashbotsBundleRawTransaction,
  FlashbotsBundleResolution,
} from "@flashbots/ethers-provider-bundle";
import * as txSimulator from "@georgeroman/evm-tx-simulator";
import axios from "axios";
import { Queue, Worker } from "bullmq";
import { randomUUID } from "crypto";

import {
  SOLUTION_PROXY,
  MATCHMAKER,
  MEMSWAP,
  MEMSWAP_WETH,
  REGULAR_WETH,
} from "../../common/addresses";
import { logger } from "../../common/logger";
import { Authorization, Intent, Solution } from "../../common/types";
import {
  bn,
  getIntentHash,
  isIntentFilled,
  isTxIncluded,
  now,
} from "../../common/utils";
import { config } from "../config";
import { redis } from "../redis";
import * as solutions from "../solutions";

const COMPONENT = "tx-solver";

const BLOCK_TIME = 15;

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
        intent: Intent;
        approvalTxOrTxHash?: string;
        existingSolution?: Solution;
        authorization?: Authorization;
      };

    try {
      const provider = new JsonRpcProvider(config.jsonUrl);
      const flashbotsProvider = await FlashbotsBundleProvider.create(
        provider,
        new Wallet(config.flashbotsSignerPk),
        config.chainId === 1
          ? "https://relay.flashbots.net"
          : "https://relay-goerli.flashbots.net"
      );

      const solver = new Wallet(config.solverPk);
      const intentHash = getIntentHash(intent);

      if (await isIntentFilled(intent, config.chainId, provider)) {
        logger.info(
          COMPONENT,
          JSON.stringify({
            intentHash,
            approvalTxOrTxHash,
            message: "Filled",
          })
        );
        return;
      }

      // TODO: Compute both of these dynamically
      const maxPriorityFeePerGas = parseUnits("10", "gwei");
      const gasLimit = 1000000;

      let solution: Solution;
      if (existingSolution) {
        // Reuse existing solution

        solution = existingSolution;
      } else {
        // Check and generate solution

        if (
          (intent.tokenIn === MEMSWAP_WETH[config.chainId] &&
            intent.tokenOut === REGULAR_WETH[config.chainId]) ||
          (intent.tokenIn === REGULAR_WETH[config.chainId] &&
            intent.tokenOut === AddressZero)
        ) {
          logger.info(
            COMPONENT,
            JSON.stringify({
              intentHash,
              approvalTxOrTxHash,
              message: "Attempted to wrap/unwrap WETH",
            })
          );
          return;
        }

        if (intent.deadline <= now()) {
          logger.info(
            COMPONENT,
            JSON.stringify({
              intentHash,
              approvalTxOrTxHash,
              message: `Expired (now=${now()}, deadline=${intent.deadline})`,
            })
          );
          return;
        }

        if (
          ![solver.address, AddressZero, MATCHMAKER[config.chainId]].includes(
            intent.matchmaker
          )
        ) {
          logger.info(
            COMPONENT,
            JSON.stringify({
              intentHash,
              approvalTxOrTxHash,
              message: `Unsupported matchmaker (matchmaker=${intent.matchmaker})`,
            })
          );
          return;
        }

        logger.info(
          COMPONENT,
          JSON.stringify({
            intentHash,
            approvalTxOrTxHash,
            message: "Generating solution",
          })
        );

        const latestBlock = await provider.getBlock("latest");
        const latestTimestamp = latestBlock.timestamp + BLOCK_TIME;
        const latestBaseFee = await provider
          .getBlock("pending")
          .then((b) => b!.baseFeePerGas!);

        const startAmountOut = bn(intent.endAmountOut).add(
          bn(intent.endAmountOut).mul(intent.startAmountBps).div(10000)
        );
        const minAmountOut = startAmountOut.sub(
          startAmountOut
            .sub(intent.endAmountOut)
            .div(intent.deadline - latestTimestamp)
        );

        const solutionDetails = await solutions.zeroEx.solve(
          intent.tokenIn,
          intent.tokenOut,
          intent.amountIn
        );

        if (solutionDetails.amountOut && solutionDetails.tokenOutToEthRate) {
          if (bn(solutionDetails.amountOut).lt(minAmountOut)) {
            logger.error(
              COMPONENT,
              JSON.stringify({
                intentHash,
                approvalTxOrTxHash,
                message: `Solution not good enough (actualAmountOut=${
                  solutionDetails.amountOut
                }, minAmountOut=${minAmountOut.toString()})`,
              })
            );
            return;
          }

          const fillerGrossProfitInETH = bn(solutionDetails.amountOut)
            .sub(minAmountOut)
            .mul(parseEther(solutionDetails.tokenOutToEthRate))
            .div(parseEther("1"));
          const fillerNetProfitInETH = fillerGrossProfitInETH.sub(
            latestBaseFee.add(maxPriorityFeePerGas).mul(gasLimit)
          );
          if (fillerNetProfitInETH.lte(0)) {
            logger.error(
              COMPONENT,
              JSON.stringify({
                intentHash,
                approvalTxOrTxHash,
                message: `Insufficient solver profit (profit=${formatEther(
                  fillerGrossProfitInETH
                )})`,
              })
            );
            return;
          }
        }

        solution = {
          to: SOLUTION_PROXY[config.chainId],
          data: new Interface([
            "function fill(address to, bytes data, address tokenIn, uint256 amountIn, address tokenOut, uint256 amountOut)",
          ]).encodeFunctionData("fill", [
            solutionDetails.to,
            solutionDetails.data,
            intent.tokenIn,
            intent.amountIn,
            intent.tokenOut,
            minAmountOut,
          ]),
          amount: intent.amountIn,
        };
      }

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

      const latestBaseFee = await provider
        .getBlock("pending")
        .then((b) => b!.baseFeePerGas!);

      const getFillerTx = async (
        intent: Intent,
        authorization?: Authorization
      ) => {
        let method: string;
        if (intent.matchmaker === MATCHMAKER[config.chainId] && authorization) {
          // For relaying
          method = "solveWithSignatureAuthorizationCheck";
        } else if (intent.matchmaker === MATCHMAKER[config.chainId]) {
          // For matchmaker submission
          method = "solveWithOnChainAuthorizationCheck";
        } else {
          // For relaying
          method = "solve";
        }

        return {
          signedTransaction: await solver.signTransaction({
            from: solver.address,
            to: MEMSWAP[config.chainId],
            value: 0,
            data: new Interface([
              `
                function ${method}(
                  (
                    address tokenIn,
                    address tokenOut,
                    address maker,
                    address matchmaker,
                    address source,
                    uint16 feeBps,
                    uint16 surplusBps,
                    uint32 deadline,
                    bool isPartiallyFillable,
                    uint128 amountIn,
                    uint128 endAmountOut,
                    uint16 startAmountBps,
                    uint16 expectedAmountBps,
                    bytes signature
                  ) intent,
                  (
                    address to,
                    bytes data,
                    uint128 amount
                  ) solution${
                    authorization
                      ? `,
                        (
                          uint128 maxAmountIn,
                          uint128 minAmountOut,
                          uint32 blockDeadline,
                          bool isPartiallyFillable
                        ),
                        bytes signature
                      `
                      : ""
                  }
                )
              `,
            ]).encodeFunctionData(
              method,
              method === "solveWithSignatureAuthorizationCheck"
                ? [intent, solution, authorization, authorization!.signature!]
                : [intent, solution]
            ),
            type: 2,
            nonce: await provider.getTransactionCount(solver.address),
            gasLimit,
            chainId: config.chainId,
            maxFeePerGas: latestBaseFee.add(maxPriorityFeePerGas).toString(),
            maxPriorityFeePerGas: maxPriorityFeePerGas.toString(),
          }),
        };
      };

      // Whether to include the approval transaction in the bundle
      const includeApprovalTx =
        approvalTxHash && !(await isTxIncluded(approvalTxHash, provider));

      // If specified and the conditions allow it, use direct transactions rather than flashbots
      let useFlashbots = true;
      if (
        !includeApprovalTx &&
        Boolean(Number(process.env.RELAY_DIRECTLY_WHEN_POSSIBLE))
      ) {
        useFlashbots = false;
      }

      if (intent.matchmaker !== MATCHMAKER[config.chainId]) {
        // Solve directly

        if (useFlashbots) {
          // If the approval transaction is still pending, include it in the bundle
          const fillerTx = await getFillerTx(intent);
          const txs = includeApprovalTx ? [approvalTx!, fillerTx] : [fillerTx];

          const targetBlock =
            (await provider.getBlock("latest").then((b) => b.number)) + 1;

          // Relay
          await relayViaFlashbots(
            intentHash,
            provider,
            flashbotsProvider,
            txs,
            targetBlock
          );
        } else {
          // At this point, for sure the approval transaction was already included, so we can skip it
          const fillerTx = await getFillerTx(intent);

          // Relay
          await relayViaTransaction(
            intentHash,
            provider,
            fillerTx.signedTransaction
          );
        }
      } else {
        // Solve via matchmaker

        if (!authorization) {
          // We don't have an authorization so first we must request it

          logger.info(
            COMPONENT,
            JSON.stringify({
              intentHash,
              txHash: approvalTxHash,
              message: "Submitting solution to matchmaker",
            })
          );

          const fillerTx = await getFillerTx(intent);
          const txs = includeApprovalTx
            ? [approvalTx!.signedTransaction, fillerTx.signedTransaction]
            : [fillerTx.signedTransaction];

          // Generate a random uuid for the request
          const uuid = randomUUID();

          await redis.set(
            `solver:${uuid}`,
            JSON.stringify({ intent, approvalTxHash, solution }),
            "EX",
            BLOCK_TIME
          );

          await axios.post(`${config.matchmakerBaseUrl}/solutions`, {
            uuid,
            baseUrl: config.solverBaseUrl,
            intent,
            txs,
          });

          // Add a delayed job to retry in case we didn't receive the matchmaker authorization
          await addToQueue(
            intent,
            { approvalTxOrTxHash, existingSolution, authorization },
            60
          );
        } else {
          // We do have an authorization so all we have to do is relay the transaction

          const targetBlock =
            (await provider.getBlock("latest").then((b) => b.number)) + 1;
          if (targetBlock > authorization.blockDeadline) {
            // If the authorization deadline was exceeded we need to request another authorization
            job.updateData({
              ...job.data,
              authorization: undefined,
            });

            throw new Error("Authorization deadline exceeded");
          }

          if (useFlashbots) {
            // If the approval transaction is still pending, include it in the bundle
            const fillerTx = await getFillerTx(intent, authorization);
            const txs = includeApprovalTx
              ? [approvalTx!, fillerTx]
              : [fillerTx];

            // Relay
            await relayViaFlashbots(
              intentHash,
              provider,
              flashbotsProvider,
              txs,
              targetBlock
            );
          } else {
            // At this point, for sure the approval transaction was already included, so we can skip it
            const fillerTx = await getFillerTx(intent, authorization);

            // Relay
            await relayViaTransaction(
              intentHash,
              provider,
              fillerTx.signedTransaction
            );
          }
        }
      }
    } catch (error: any) {
      logger.error(
        COMPONENT,
        `Job failed: ${
          error.response?.data ? JSON.stringify(error.response.data) : error
        } (${error.stack})`
      );
      throw error;
    }
  },
  { connection: redis.duplicate(), concurrency: 10 }
);
worker.on("error", (error) => {
  logger.error(COMPONENT, JSON.stringify({ data: `Worker errored: ${error}` }));
});

export const addToQueue = async (
  intent: Intent,
  options?: {
    approvalTxOrTxHash?: string;
    existingSolution?: Solution;
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
    }
  );

// Relay methods

const relayViaTransaction = async (
  intentHash: string,
  provider: JsonRpcProvider,
  tx: string
) => {
  const parsedTx = parse(tx);
  try {
    await txSimulator.getCallResult(
      {
        from: parsedTx.from!,
        to: parsedTx.to!,
        data: parsedTx.data,
        value: parsedTx.value,
        gas: parsedTx.gasLimit,
        gasPrice: parsedTx.maxFeePerGas!,
      },
      provider
    );
  } catch {
    logger.error(
      COMPONENT,
      JSON.stringify({
        intentHash,
        message: "Simulation failed",
        parsedTx,
      })
    );

    throw new Error("Simulation failed");
  }

  logger.info(
    COMPONENT,
    JSON.stringify({
      intentHash,
      message: "Relaying using regular transaction",
    })
  );

  const txResponse = await provider.sendTransaction(tx);

  logger.info(
    COMPONENT,
    JSON.stringify({
      intentHash,
      message: `Transaction included (txHash=${txResponse.hash})`,
    })
  );
};

const relayViaFlashbots = async (
  intentHash: string,
  provider: JsonRpcProvider,
  flashbotsProvider: FlashbotsBundleProvider,
  txs: FlashbotsBundleRawTransaction[],
  targetBlock: number
) => {
  const signedBundle = await flashbotsProvider.signBundle(txs);

  const simulationResult: { error?: string; results: [{ error?: string }] } =
    (await flashbotsProvider.simulate(signedBundle, targetBlock)) as any;
  if (simulationResult.error || simulationResult.results.some((r) => r.error)) {
    logger.error(
      COMPONENT,
      JSON.stringify({
        intentHash,
        message: "Bundle simulation failed",
        simulationResult,
        txs,
      })
    );

    throw new Error("Bundle simulation failed");
  }

  logger.info(
    COMPONENT,
    JSON.stringify({
      intentHash,
      message: `Relaying bundle using flashbots (targetBlock=${targetBlock})`,
    })
  );

  const receipt = await flashbotsProvider.sendRawBundle(
    signedBundle,
    targetBlock
  );
  const hash = (receipt as any).bundleHash;

  logger.info(
    COMPONENT,
    JSON.stringify({
      intentHash,
      message: `Bundle relayed using flashbots (targetBlock=${targetBlock}, bundleHash=${hash})`,
    })
  );

  const waitResponse = await (receipt as any).wait();
  if (
    waitResponse === FlashbotsBundleResolution.BundleIncluded ||
    waitResponse === FlashbotsBundleResolution.AccountNonceTooHigh
  ) {
    if (
      await isTxIncluded(
        parse(txs[txs.length - 1].signedTransaction).hash!,
        provider
      )
    ) {
      logger.info(
        COMPONENT,
        JSON.stringify({
          intentHash,
          message: `Bundle included (targetBlock=${targetBlock}, bundleHash=${hash})`,
        })
      );
    } else {
      logger.info(
        COMPONENT,
        JSON.stringify({
          intentHash,
          message: `Bundle not included (targetBlock=${targetBlock}, bundleHash=${hash})`,
        })
      );

      throw new Error("Bundle not included");
    }
  } else {
    logger.info(
      COMPONENT,
      JSON.stringify({
        intentHash,
        message: `Bundle not included (targetBlock=${targetBlock}, bundleHash=${hash})`,
      })
    );

    throw new Error("Bundle not included");
  }
};
