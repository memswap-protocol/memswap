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
  BLOCK_TIME,
  getEIP712TypesForIntent,
  isIntentFilled,
  now,
} from "../../common/utils";
import { config } from "../config";
import * as jobs from "../jobs";
import { redis } from "../redis";
import { Solution } from "../types";

const COMPONENT = "solution-process";

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

    logger.info(
      COMPONENT,
      JSON.stringify({
        msg: "Processing solution",
        intentHash,
        uuid,
        baseUrl,
        intent,
        txs,
      })
    );

    const perfTime1 = performance.now();

    // Return early if the intent is expired
    if (intent.deadline < now()) {
      const msg = "Intent is expired";
      logger.info(
        COMPONENT,
        JSON.stringify({
          msg,
          intentHash,
        })
      );

      return {
        status: "error",
        error: msg,
      };
    }

    const perfTime2 = performance.now();

    // TODO: Return early if intent is filled
    if (await isIntentFilled(intent, config.chainId, provider)) {
      const msg = "Filled";
      logger.info(
        COMPONENT,
        JSON.stringify({
          msg,
          intentHash,
        })
      );

      return {
        status: "error",
        error: msg,
      };
    }

    const perfTime3 = performance.now();

    // Determine the target block for the solution
    const latestBlock = await provider.getBlock("latest");
    let targetBlockNumber = latestBlock.number + 1;
    let targetBlockTimestamp = latestBlock.timestamp + BLOCK_TIME;
    if (targetBlockTimestamp - now() < 6) {
      // If there is less than 6 seconds until the next block inclusion
      // then the solution will have to wait until the block after that
      targetBlockNumber += 1;
      targetBlockTimestamp += BLOCK_TIME;
    }

    const perfTime4 = performance.now();

    // Return early if the submission period is already over (for the current target block)
    const solutionKey = `matchmaker:solutions:${intentHash}:${targetBlockNumber}`;
    if (await jobs.signatureRelease.isLocked(solutionKey)) {
      const msg = "Submission period is over";
      logger.info(
        COMPONENT,
        JSON.stringify({
          msg,
          intentHash,
        })
      );

      return {
        status: "error",
        error: msg,
      };
    }

    const perfTime5 = performance.now();

    // Assume the solution transaction is the last one in the list
    const parsedSolutionTx = parse(txs[txs.length - 1]);
    const authorizedSolver = parsedSolutionTx.from!;

    // Get the call traces of the submission + status check transactions
    const txsToSimulate = [
      // Authorization transaction
      {
        from: matchmaker.address,
        to: MEMSWAP[config.chainId],
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

    const perfTime6 = performance.now();

    const traces = await getCallTraces(txsToSimulate, provider);

    const perfTime7 = performance.now();

    // Make sure the solution transaction didn't reverted
    const solveTrace = traces[traces.length - 1];
    if (solveTrace.error) {
      const msg = "Solution transaction reverted";
      logger.info(
        COMPONENT,
        JSON.stringify({
          msg,
          intentHash,
          txsToSimulate,
        })
      );

      return {
        status: "error",
        error: msg,
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
      } as Solution)
    );

    // Put a delayed job to release the signatures
    await jobs.signatureRelease.addToQueue(
      solutionKey,
      targetBlockTimestamp - now()
    );

    const perfTime8 = performance.now();

    logger.info(
      COMPONENT,
      JSON.stringify({
        msg: "Performance measurements for process-solution",
        time1: (perfTime2 - perfTime1) / 1000,
        time2: (perfTime3 - perfTime2) / 1000,
        time3: (perfTime4 - perfTime3) / 1000,
        time4: (perfTime5 - perfTime4) / 1000,
        time5: (perfTime6 - perfTime5) / 1000,
        time6: (perfTime7 - perfTime6) / 1000,
        time7: (perfTime8 - perfTime7) / 1000,
      })
    );

    return { status: "success" };
  } catch (error: any) {
    logger.error(
      COMPONENT,
      JSON.stringify({
        msg: "Unknown error",
        error,
        stack: error.stack,
      })
    );

    return {
      status: "error",
      error: "Unknown error",
    };
  }
};
