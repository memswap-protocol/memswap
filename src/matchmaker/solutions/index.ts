import { Interface } from "@ethersproject/abi";
import { _TypedDataEncoder } from "@ethersproject/hash";
import { JsonRpcProvider } from "@ethersproject/providers";
import { parse } from "@ethersproject/transactions";
import { formatEther } from "@ethersproject/units";
import { Wallet } from "@ethersproject/wallet";
import { getCallTraces, getStateChange } from "@georgeroman/evm-tx-simulator";

import { MEMSWAP } from "../../common/addresses";
import { logger } from "../../common/logger";
import { Intent } from "../../common/types";
import {
  getEIP712TypesForIntent,
  isIntentFilled,
  now,
} from "../../common/utils";
import { config } from "../config";
import * as jobs from "../jobs";
import { redis } from "../redis";

const COMPONENT = "solution-process";

const RELEASE_DURATION = 3;

export const processSolution = async (
  uuid: string,
  baseUrl: string,
  intent: Intent,
  txs: string[]
): Promise<{
  status: "success" | "error";
  error?: string;
}> => {
  try {
    const provider = new JsonRpcProvider(config.jsonUrl);
    const matchmaker = new Wallet(config.matchmakerPk);

    // Determine the hash of the intent
    const intentHash = _TypedDataEncoder.hashStruct(
      "Intent",
      getEIP712TypesForIntent(),
      intent
    );

    // Return early if the intent is expired
    if (intent.deadline < now()) {
      const message = "Intent is expired";
      logger.info(COMPONENT, JSON.stringify({ intentHash, message }));

      return {
        status: "error",
        error: message,
      };
    }

    // TODO: Return early if intent is filled
    if (await isIntentFilled(intent, provider)) {
      const message = "Filled";
      logger.info(
        COMPONENT,
        JSON.stringify({
          intentHash,
          message,
        })
      );

      return {
        status: "error",
        error: message,
      };
    }

    // Determine the target block for the solution
    const latestBlock = await provider.getBlock("latest");
    let targetBlockNumber = latestBlock.number + 1;
    let targetBlockTimestamp = latestBlock.timestamp + 12;
    if (targetBlockTimestamp - now() < 6) {
      // If there is less than 6 seconds until the next block inclusion
      // then the solution will have to wait until the block after that
      targetBlockNumber += 1;
      targetBlockTimestamp += 12;
    }

    // Return early if the submission period is already over (for the current target block)
    const solutionKey = `matchmaker:solutions:${intentHash}:${targetBlockNumber}`;
    if (await jobs.signatureRelease.isLocked(solutionKey)) {
      const message = "Submission period is over";
      logger.info(COMPONENT, JSON.stringify({ intentHash, message }));

      return {
        status: "error",
        error: message,
      };
    }

    // Assume the solution transaction is the last one in the list
    const parsedSolutionTx = parse(txs[txs.length - 1]);
    const authorizedSolver = parsedSolutionTx.from!;

    // Get the call traces of the submission + status check transactions
    const txsToSimulate = [
      // Authorization transaction
      {
        from: matchmaker.address,
        to: MEMSWAP,
        data: new Interface([
          `
            function authorize(
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
              address authorizedSolver,
              (
                uint128 maxAmountIn,
                uint128 minAmountOut,
                uint32 blockDeadline,
                bool isPartiallyFillable
              ) auth
            )
          `,
        ]).encodeFunctionData("authorize", [
          intent,
          authorizedSolver,
          {
            maxAmountIn: intent.amountIn,
            minAmountOut: 0,
            blockDeadline: targetBlockNumber,
            isPartiallyFillable: false,
          },
        ]),
        value: 0,
        gas: parsedSolutionTx.gasLimit,
        gasPrice: (parsedSolutionTx.gasPrice ?? parsedSolutionTx.maxFeePerGas)!,
      },
      // Submission transactions
      ...txs.map((tx) => {
        const parsedTx = parse(tx);
        return {
          from: parsedTx.from!,
          to: parsedTx.to!,
          data: parsedTx.data!,
          value: parsedTx.value,
          gas: parsedTx.gasLimit,
          gasPrice: (parsedTx.gasPrice ?? parsedTx.maxFeePerGas)!,
        };
      }),
    ];
    const traces = await getCallTraces(txsToSimulate, provider);

    // Make sure the solution transaction didn't reverted
    const solveTrace = traces[traces.length - 1];
    if (solveTrace.error) {
      const message = "Solution transaction reverted";
      logger.info(
        COMPONENT,
        JSON.stringify({ intentHash, message, txsToSimulate })
      );

      return {
        status: "error",
        error: message,
      };
    }

    // Compute the amount received by the intent maker
    const stateChange = getStateChange(solveTrace);
    const amountReceived =
      stateChange[intent.maker.toLowerCase()].tokenBalanceState[
        `erc20:${intent.tokenOut.toLowerCase()}`
      ];

    // Save the solution
    await redis.zadd(
      solutionKey,
      Number(formatEther(amountReceived)),
      JSON.stringify({
        uuid,
        baseUrl,
        intentHash,
        authorizedSolver,
        maxAmountIn: intent.amountIn,
        minAmountOut: amountReceived,
      })
    );

    // Put a delayed job to release the signatures
    await jobs.signatureRelease.addToQueue(
      solutionKey,
      targetBlockTimestamp - now()
    );

    return { status: "success" };
  } catch (error: any) {
    logger.error(COMPONENT, JSON.stringify({ error, stack: error.stack }));

    return {
      status: "error",
      error: "Unknown error",
    };
  }
};
