import { JsonRpcProvider } from "@ethersproject/providers";
import { parse } from "@ethersproject/transactions";
import { Wallet } from "@ethersproject/wallet";
import {
  FlashbotsBundleProvider,
  FlashbotsBundleRawTransaction,
  FlashbotsBundleResolution,
} from "@flashbots/ethers-provider-bundle";
import * as txSimulator from "@georgeroman/evm-tx-simulator";

import { logger } from "../common/logger";
import { PESSIMISTIC_BLOCK_TIME, isTxIncluded } from "../common/utils";
import { config } from "./config";

// Monkey-patch the flashbots bundle provider to support relaying via bloxroute
import "./flashbots-monkey-patch";

let cachedFlashbotsProvider: FlashbotsBundleProvider | undefined;
export const getFlashbotsProvider = async () => {
  if (!cachedFlashbotsProvider) {
    cachedFlashbotsProvider = await FlashbotsBundleProvider.create(
      new JsonRpcProvider(config.jsonUrl),
      new Wallet(config.flashbotsSignerPk),
      config.chainId === 1
        ? "https://relay.flashbots.net"
        : "https://relay-goerli.flashbots.net"
    );
  }

  return cachedFlashbotsProvider;
};

// Warm-up
getFlashbotsProvider();

// Relay methods

export const relayViaTransaction = async (
  hash: string,
  isIncentivized: boolean,
  provider: JsonRpcProvider,
  tx: string,
  logComponent: string
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
        maxFeePerGas: parsedTx.maxFeePerGas!,
        maxPriorityFeePerGas: parsedTx.maxPriorityFeePerGas!,
      },
      provider
    );
  } catch {
    // For some reason, incentivized intents fail the above simulation very often

    logger[isIncentivized ? "info" : "error"](
      logComponent,
      JSON.stringify({
        msg: "Simulation failed",
        hash,
        parsedTx,
      })
    );

    if (!isIncentivized) {
      throw new Error("Simulation failed");
    }
  }

  logger.info(
    logComponent,
    JSON.stringify({
      msg: "Relaying using regular transaction",
      hash,
    })
  );

  const txResponse = await provider.sendTransaction(tx).then((tx) => tx.wait());

  logger.info(
    logComponent,
    JSON.stringify({
      msg: "Transaction included",
      hash,
      txHash: txResponse.transactionHash,
    })
  );
};

export const relayViaFlashbots = async (
  hash: string,
  provider: JsonRpcProvider,
  flashbotsProvider: FlashbotsBundleProvider,
  txs: FlashbotsBundleRawTransaction[],
  // These are to be removed if the simulation fails with "nonce too high"
  userTxs: FlashbotsBundleRawTransaction[],
  targetBlock: number,
  logComponent: string
): Promise<any> => {
  const signedBundle = await flashbotsProvider.signBundle(txs);

  const simulationResult: { error?: string; results: [{ error?: string }] } =
    (await flashbotsProvider.simulate(signedBundle, targetBlock)) as any;
  if (simulationResult.error || simulationResult.results.some((r) => r.error)) {
    if (
      ["nonce too low", "nonce too high"].some((e) =>
        JSON.stringify(simulationResult.error)?.includes(e)
      )
    ) {
      // Retry with all user transactions removed - assuming the
      // error is coming from their inclusion in previous blocks
      const mappedUserTxs = userTxs.map((tx) => tx.signedTransaction);
      txs = txs.filter((tx) => !mappedUserTxs.includes(tx.signedTransaction));

      return relayViaFlashbots(
        hash,
        provider,
        flashbotsProvider,
        txs,
        [],
        targetBlock,
        logComponent
      );
    } else {
      logger.error(
        logComponent,
        JSON.stringify({
          msg: "Bundle simulation failed",
          hash,
          simulationResult,
          txs,
        })
      );

      throw new Error("Bundle simulation failed");
    }
  }

  const receipt = await flashbotsProvider.sendRawBundle(
    signedBundle,
    targetBlock
  );
  const bundleHash = (receipt as any).bundleHash;

  logger.info(
    logComponent,
    JSON.stringify({
      msg: "Bundle relayed using flashbots",
      hash,
      targetBlock,
      bundleHash,
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
        logComponent,
        JSON.stringify({
          msg: "Bundle included",
          hash,
          targetBlock,
          bundleHash: hash,
        })
      );
    } else {
      logger.info(
        logComponent,
        JSON.stringify({
          msg: "Bundle not included",
          hash,
          targetBlock,
          bundleHash: hash,
        })
      );

      throw new Error("Bundle not included");
    }
  } else {
    logger.info(
      logComponent,
      JSON.stringify({
        msg: "Bundle not included",
        hash,
        targetBlock,
        bundleHash: hash,
      })
    );

    throw new Error("Bundle not included");
  }
};

export const relayViaBloxroute = async (
  hash: string,
  provider: JsonRpcProvider,
  flashbotsProvider: FlashbotsBundleProvider,
  txs: FlashbotsBundleRawTransaction[],
  // These are to be removed if the simulation fails with "nonce too high"
  userTxs: FlashbotsBundleRawTransaction[],
  targetBlock: number,
  logComponent: string
): Promise<any> => {
  // Simulate via flashbots
  const signedBundle = await flashbotsProvider.signBundle(txs);
  const simulationResult: { error?: string; results: [{ error?: string }] } =
    (await flashbotsProvider.simulate(signedBundle, targetBlock)) as any;
  if (simulationResult.error || simulationResult.results.some((r) => r.error)) {
    if (
      ["nonce too low", "nonce too high"].some((e) =>
        JSON.stringify(simulationResult.error)?.includes(e)
      )
    ) {
      // Retry with all user transactions removed - assuming the
      // error is coming from their inclusion in previous blocks
      const mappedUserTxs = userTxs.map((tx) => tx.signedTransaction);
      txs = txs.filter((tx) => !mappedUserTxs.includes(tx.signedTransaction));

      return relayViaBloxroute(
        hash,
        provider,
        flashbotsProvider,
        txs,
        [],
        targetBlock,
        logComponent
      );
    } else {
      logger.error(
        logComponent,
        JSON.stringify({
          msg: "Bundle simulation failed",
          hash,
          simulationResult,
          txs,
        })
      );

      throw new Error("Bundle simulation failed");
    }
  }

  logger.info(
    logComponent,
    JSON.stringify({
      msg: "Bloxroute debug",
      params: {
        id: "1",
        method: "blxr_submit_bundle",
        params: {
          transaction: txs.map((tx) => tx.signedTransaction.slice(2)),
          block_number: "0x" + targetBlock.toString(16),
          mev_builders: {
            bloxroute: "",
            flashbots: "",
            builder0x69: "",
            beaverbuild: "",
            buildai: "",
            all: "",
          },
        },
      },
    })
  );

  let done = false;
  while (!done) {
    try {
      const receipt = await (flashbotsProvider as any).blxrSubmitBundle(
        txs,
        targetBlock
      );
      const hash = (receipt as any).bundleHash;

      logger.info(
        logComponent,
        JSON.stringify({
          msg: "Bundle relayed using bloxroute",
          hash,
          targetBlock,
          bundleHash: hash,
        })
      );

      const waitResponse = await Promise.race([
        (receipt as any).wait(),
        new Promise((resolve) =>
          setTimeout(resolve, PESSIMISTIC_BLOCK_TIME * 1000)
        ),
      ]);
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
            logComponent,
            JSON.stringify({
              msg: "Bundle included",
              hash,
              targetBlock,
              bundleHash: hash,
            })
          );
        } else {
          logger.info(
            logComponent,
            JSON.stringify({
              msg: "Bundle not included",
              hash,
              targetBlock,
              bundleHash: hash,
            })
          );

          throw new Error("Bundle not included");
        }
      } else {
        logger.info(
          logComponent,
          JSON.stringify({
            msg: "Bundle not included",
            hash,
            targetBlock,
            bundleHash: hash,
          })
        );

        throw new Error("Bundle not included");
      }
    } catch (error: any) {
      const data = error.response?.data;
      if (
        data &&
        JSON.stringify(data).includes("1 bundle submissions per second")
      ) {
        // Retry after waiting for 1 second
        await new Promise((resolve) => setTimeout(resolve, 1100));
      } else {
        throw error;
      }
    }

    done = true;
  }
};
