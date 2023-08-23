import { Interface } from "@ethersproject/abi";
import { _TypedDataEncoder } from "@ethersproject/hash";
import { JsonRpcProvider } from "@ethersproject/providers";
import { parse } from "@ethersproject/transactions";
import { Wallet } from "@ethersproject/wallet";
import { getCallTraces, getStateChange } from "@georgeroman/evm-tx-simulator";

import { MEMSWAP } from "../../common/addresses";
import { logger } from "../../common/logger";
import { Intent } from "../../common/types";
import {
  bn,
  getEIP712Domain,
  getEIP712TypesForAuthorization,
  getEIP712TypesForIntent,
  now,
} from "../../common/utils";
import { config } from "../config";
import { redis } from "../redis";
import { Solution } from "../types";

const COMPONENT = "solution-handler";

const AUCTION_DURATION = 9;
const RELEASE_DURATION = 3;
const BLOCK_DEADLINE = 2;

export const handle = async (
  intent: Intent,
  txs: string[]
): Promise<{
  status: "success" | "error";
  error?: string;
  recheckIn?: number;
  auth?: {
    maximumAmountIn: string;
    minimumAmountOut: string;
    blockDeadline: number;
    isPartiallyFillable: boolean;
    signature: string;
  };
}> => {
  try {
    const provider = new JsonRpcProvider(config.jsonUrl);
    const matchMaker = new Wallet(config.matchMakerPk);

    // Compute the hash of the intent
    const chainId = await provider.getNetwork().then((n) => n.chainId);
    const intentHash = _TypedDataEncoder.hashStruct(
      "Intent",
      getEIP712TypesForIntent(),
      intent
    );

    // If the auction is ended and the current submission is just for retrieving
    // the authorization, then skip any checks and return the signature directly
    {
      const ct = now();

      const bestSolutionStartKey = `matchmaker:best-solution-start:${intentHash}`;
      const bestSolutionStart = await redis.get(bestSolutionStartKey);
      if (
        // The auction period is finalized
        ct - Number(bestSolutionStart) > AUCTION_DURATION &&
        // The release period is not yet finalized
        ct - Number(bestSolutionStart) <= AUCTION_DURATION + RELEASE_DURATION
      ) {
        const bestSolutionKey = `matchmaker:best-solution:${intentHash}`;
        const bestSolution: Solution | undefined = await redis
          .get(bestSolutionKey)
          .then((bf) => (bf ? JSON.parse(bf) : undefined));
        if (
          // There is a best solution
          bestSolution &&
          // The best solution matches the current submission (assume`JSON.stringify` is deterministic)
          JSON.stringify(bestSolution.txs) === JSON.stringify(txs)
        ) {
          const auth = {
            intentHash,
            authorizedFiller: parse(txs[txs.length - 1]).from!,
            maximumAmountIn: intent.amountIn,
            minimumAmountOut: bestSolution.amountReceived,
            blockDeadline:
              (await provider.getBlock("latest").then((b) => b.number)) +
              BLOCK_DEADLINE,
            isPartiallyFillable: false,
          };

          const signature = await matchMaker._signTypedData(
            getEIP712Domain(chainId),
            getEIP712TypesForAuthorization(),
            auth
          );

          return {
            status: "success",
            auth: {
              ...auth,
              signature,
            },
          };
        }
      }
    }

    // Return early if the intent is expired
    if (intent.deadline < now()) {
      return {
        status: "error",
        error: "Intent is expired",
      };
    }

    // Get the call traces of the submission + status check transactions
    const traces = await getCallTraces(
      [
        // Authorization transaction
        await (async () => {
          const parsedTx = parse(txs[txs.length - 1]);
          return {
            from: matchMaker.address,
            to: MEMSWAP,
            data: new Interface([
              `
                function authorize(
                  (
                    address tokenIn,
                    address tokenOut,
                    address maker,
                    address filler,
                    address referrer,
                    uint32 referrerFeeBps,
                    uint32 referrerSurplusBps,
                    uint32 deadline,
                    bool isPartiallyFillable,
                    uint128 amountIn,
                    uint128 startAmountOut,
                    uint128 expectedAmountOut,
                    uint128 endAmountOut,
                    bytes signature
                  ) intent,
                  address authorizedFiller,
                  (
                    uint128 maximumAmountIn,
                    uint128 minimumAmountOut,
                    uint32 blockDeadline,
                    bool isPartiallyFillable
                  ) auth
                )
              `,
            ]).encodeFunctionData("authorize", [
              intent,
              parsedTx.from!,
              {
                maximumAmountIn: intent.amountIn,
                minimumAmountOut: 0,
                blockDeadline:
                  (await provider.getBlock("latest").then((b) => b.number)) +
                  100,
                isPartiallyFillable: false,
              },
            ]),
            value: 0,
            gas: parsedTx.gasLimit,
            gasPrice: (parsedTx.gasPrice ?? parsedTx.maxFeePerGas)!,
          };
        })(),
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
      ],
      provider
    );

    // Make sure the solution transaction didn't reverted
    const solveTrace = traces[traces.length - 1];
    if (solveTrace.error) {
      logger.info(COMPONENT, JSON.stringify(txs.map((tx) => parse(tx))));

      return {
        status: "error",
        error: "Solve transaction reverted",
      };
    }

    // Compute the amount received by the intent maker
    const stateChange = getStateChange(solveTrace);
    const amountReceived =
      stateChange[intent.maker.toLowerCase()].tokenBalanceState[
        `erc20:${intent.tokenOut.toLowerCase()}`
      ];

    // Fetch the current best solution
    const bestSolutionKey = `matchmaker:best-solution:${intentHash}`;
    const bestSolution: Solution | undefined = await redis
      .get(bestSolutionKey)
      .then((bf) => (bf ? JSON.parse(bf) : undefined));

    const ct = now();

    // Fetch the start time of the auction period
    const bestSolutionStartKey = `matchmaker:best-solution-start:${intentHash}`;
    const bestSolutionStart = await redis.get(bestSolutionStartKey);

    if (
      // The auction period didn't start yet
      !bestSolutionStart ||
      // The auction period is not yet finalized
      ct - Number(bestSolutionStart) <= AUCTION_DURATION
    ) {
      if (
        // There is no best solution yet
        !bestSolution ||
        // The current submission is the best solution
        bn(amountReceived).gt(bestSolution.amountReceived)
      ) {
        if (!bestSolution) {
          await redis.set(
            bestSolutionKey,
            JSON.stringify({
              txs,
              amountReceived,
            }),
            "EX",
            AUCTION_DURATION + RELEASE_DURATION
          );
        } else {
          await redis.set(
            bestSolutionKey,
            JSON.stringify({
              txs,
              amountReceived,
            }),
            "EX",
            "KEEPTTL"
          );
        }

        // Start the auction if this is the first successful submission
        if (!bestSolutionStart) {
          await redis.set(
            bestSolutionStartKey,
            ct,
            "EX",
            AUCTION_DURATION + RELEASE_DURATION
          );
        }

        return {
          status: "success",
          recheckIn: Math.max(
            0,
            Number(bestSolutionStart ?? ct) + AUCTION_DURATION + 1 - ct
          ),
        };
      }
    } else if (
      // The current submission is at least as good as the best one
      bn(amountReceived).gte(bestSolution!.amountReceived) &&
      // The auction period is finalized
      ct - Number(bestSolutionStart) > AUCTION_DURATION &&
      // The release period is not yet finalized
      ct - Number(bestSolutionStart) <= AUCTION_DURATION + RELEASE_DURATION
    ) {
      const auth = {
        intentHash,
        authorizedFiller: parse(txs[txs.length - 1]).from!,
        maximumAmountIn: intent.amountIn,
        minimumAmountOut: amountReceived,
        blockDeadline:
          (await provider.getBlock("latest").then((b) => b.number)) +
          BLOCK_DEADLINE,
        isPartiallyFillable: false,
      };

      const signature = await matchMaker._signTypedData(
        getEIP712Domain(chainId),
        getEIP712TypesForAuthorization(),
        auth
      );

      return {
        status: "success",
        auth: {
          ...auth,
          signature,
        },
      };
    }

    return {
      status: "error",
      error: "Solution not good enough",
    };
  } catch (error) {
    console.log(error);
    return {
      status: "error",
      error: "Unknown error",
    };
  }
};
