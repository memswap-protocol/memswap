import { Interface } from "@ethersproject/abi";
import { AddressZero } from "@ethersproject/constants";
import { _TypedDataEncoder } from "@ethersproject/hash";
import { JsonRpcProvider } from "@ethersproject/providers";
import { parse } from "@ethersproject/transactions";
import { formatEther, parseEther } from "@ethersproject/units";
import { Wallet } from "@ethersproject/wallet";
import { getCallTraces, getStateChange } from "@georgeroman/evm-tx-simulator";

import { MEMSWAP_ERC20 } from "../../common/addresses";
import { logger } from "../../common/logger";
import { getEthConversion } from "../../common/reservoir";
import { IntentERC20, Protocol } from "../../common/types";
import {
  AVERAGE_BLOCK_TIME,
  MATCHMAKER_AUTHORIZATION_GAS,
  bn,
  getEIP712TypesForIntent,
  isIntentFilled,
  now,
} from "../../common/utils";
import { config } from "../config";
import * as jobs from "../jobs";
import { redis } from "../redis";
import { Solution } from "../types";

const COMPONENT = "solution-process-erc20";

export const process = async (
  intent: IntentERC20,
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
      getEIP712TypesForIntent(Protocol.ERC20),
      intent
    );

    logger.info(
      COMPONENT,
      JSON.stringify({
        msg: "Processing solution",
        intentHash,
        intent,
        txs,
      })
    );

    const perfTime1 = performance.now();

    // Return early if the intent is not yet started
    if (intent.startTime > now()) {
      const msg = "Intent not yet started";
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

    // Return early if the intent is expired
    if (intent.endTime <= now()) {
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

    const latestBlock = await provider.getBlock("latest");
    // The inclusion target is two blocks in the future
    const targetBlockNumber = latestBlock.number + 2;
    // The submission period is only open until one block in the future
    const submissionDeadline = latestBlock.timestamp + AVERAGE_BLOCK_TIME;

    const perfTime4 = performance.now();

    // Return early if the submission period is already over (for the current target block)
    const solutionKey = `matchmaker:solutions:${intentHash}:${targetBlockNumber}`;
    if (await jobs.submissionERC20.isLocked(solutionKey)) {
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
    const solver =
      parsedSolutionTx.to!.toLowerCase() === MEMSWAP_ERC20[config.chainId]
        ? parsedSolutionTx.from!
        : parsedSolutionTx.to!;

    // Get the call traces of the submission + status check transactions
    const txsToSimulate = [
      // Authorization transaction
      {
        from: matchmaker.address,
        to: MEMSWAP_ERC20[config.chainId],
        data: new Interface([
          `
            function authorize(
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
              )[] intents,
              (
                uint128 fillAmountToCheck,
                uint128 executeAmountToCheck,
                uint32 blockDeadline
              )[] auths,
              address solver
            )
          `,
        ]).encodeFunctionData("authorize", [
          [intent],
          [
            {
              fillAmountToCheck: intent.amount,
              executeAmountToCheck: intent.isBuy
                ? bn("0x" + "ff".repeat(16))
                : 0,
              blockDeadline: targetBlockNumber,
            },
          ],
          solver,
        ]),
        value: 0,
        gas: parsedSolutionTx.gasLimit,
        maxFeePerGas: parsedSolutionTx.maxFeePerGas!,
        maxPriorityFeePerGas: parsedSolutionTx.maxPriorityFeePerGas!,
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
          maxFeePerGas: parsedTx.maxFeePerGas!,
          maxPriorityFeePerGas: parsedTx.maxPriorityFeePerGas!,
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
          error: solveTrace.error,
          txsToSimulate,
        })
      );

      return {
        status: "error",
        error: msg,
      };
    }

    const stateChange = getStateChange(solveTrace);

    // Approximation for gas used by matchmaker on-chain authorization transaction
    const matchmakerGasFee = bn(MATCHMAKER_AUTHORIZATION_GAS).mul(
      latestBlock.baseFeePerGas!
    );

    if (intent.isBuy) {
      const token = intent.sellToken.toLowerCase();

      // Compute the amount pulled from the intent maker
      const amountPulled =
        stateChange[intent.maker.toLowerCase()]?.tokenBalanceState[
          `erc20:${token}`
        ] ?? "0";

      // Ensure the matchmaker is profitable (or at least not losing money)
      const matchmakerProfit =
        stateChange[matchmaker.address.toLowerCase()]?.tokenBalanceState[
          `erc20:${token}`
        ] ?? "0";
      const matchmakerProfitInEth = bn(matchmakerProfit)
        .mul(parseEther("1"))
        .div(await getEthConversion(token));
      if (matchmakerProfitInEth.lt(matchmakerGasFee)) {
        const msg = "Matchmaker not profitable";
        logger.info(
          COMPONENT,
          JSON.stringify({
            msg,
            intentHash,
            matchmakerProfitInEth: matchmakerProfitInEth.toString(),
            matchmakerGasFee: matchmakerGasFee.toString(),
          })
        );

        return {
          status: "error",
          error: msg,
        };
      }

      // Save the solution
      const solution: Solution = {
        intent,
        fillAmountToCheck: intent.amount,
        executeAmountToCheck: bn(amountPulled).mul(-1).toString(),
        userTxs: txs.slice(0, txs.length - 1),
        txs,
        solver,
      };
      await redis.zadd(
        solutionKey,
        Number(formatEther(amountPulled)),
        JSON.stringify(solution)
      );
    } else {
      const token = intent.buyToken.toLowerCase();
      const isEth = token === AddressZero;

      // Compute the amount received by the intent maker
      const amountReceived =
        stateChange[intent.maker.toLowerCase()]?.tokenBalanceState[
          `${isEth ? "native" : "erc20"}:${token}`
        ] ?? "0";

      // Ensure the matchmaker is profitable (or at least not losing money)
      const matchmakerProfit =
        stateChange[matchmaker.address.toLowerCase()]?.tokenBalanceState[
          `${isEth ? "native" : "erc20"}:${token}`
        ] ?? "0";
      const matchmakerProfitInEth = bn(matchmakerProfit)
        .mul(parseEther("1"))
        .div(await getEthConversion(token));
      if (matchmakerProfitInEth.lt(matchmakerGasFee)) {
        const msg = "Matchmaker not profitable";
        logger.info(
          COMPONENT,
          JSON.stringify({
            msg,
            intentHash,
            matchmakerProfitInEth: matchmakerProfitInEth.toString(),
            matchmakerGasFee: matchmakerGasFee.toString(),
          })
        );

        return {
          status: "error",
          error: msg,
        };
      }

      // Save the solution
      const solution: Solution = {
        intent,
        fillAmountToCheck: intent.amount,
        executeAmountToCheck: amountReceived,
        userTxs: txs.slice(0, txs.length - 1),
        txs,
        solver,
      };
      await redis.zadd(
        solutionKey,
        Number(formatEther(amountReceived)),
        JSON.stringify(solution)
      );
    }

    // Put a delayed job to relay the winning solution
    await jobs.submissionERC20.addToQueue(
      solutionKey,
      submissionDeadline - now()
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
