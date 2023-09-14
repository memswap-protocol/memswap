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
import { isTxIncluded } from "../common/utils";
import { config } from "./config";

// Monkey-patch the flashbots bundle provider to support relaying via bloxroute
import "./monkey-patches/flashbots-bundle-provider";

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
  intentHash: string,
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
        gasPrice: parsedTx.maxFeePerGas!,
      },
      provider
    );
  } catch {
    logger.error(
      logComponent,
      JSON.stringify({
        msg: "Simulation failed",
        intentHash,
        parsedTx,
      })
    );

    throw new Error("Simulation failed");
  }

  logger.info(
    logComponent,
    JSON.stringify({
      msg: "Relaying using regular transaction",
      intentHash,
    })
  );

  const txResponse = await provider.sendTransaction(tx).then((tx) => tx.wait());

  logger.info(
    logComponent,
    JSON.stringify({
      msg: "Transaction included",
      intentHash,
      txHash: txResponse.transactionHash,
    })
  );
};

export const relayViaFlashbots = async (
  intentHash: string,
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
  if (simulationResult.error) {
    if (JSON.stringify(simulationResult.error).includes("nonce too high")) {
      // Retry with all user transactions removed - assuming the
      // error is coming from their inclusion in previous blocks
      const mappedUserTxs = userTxs.map((tx) => tx.signedTransaction);
      txs = txs.filter((tx) => !mappedUserTxs.includes(tx.signedTransaction));

      return relayViaFlashbots(
        intentHash,
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
          intentHash,
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
  const hash = (receipt as any).bundleHash;

  logger.info(
    logComponent,
    JSON.stringify({
      msg: "Bundle relayed using flashbots",
      intentHash,
      targetBlock,
      bundleHash: hash,
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
          intentHash,
          targetBlock,
          bundleHash: hash,
        })
      );
    } else {
      logger.info(
        logComponent,
        JSON.stringify({
          msg: "Bundle not included",
          intentHash,
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
        intentHash,
        targetBlock,
        bundleHash: hash,
      })
    );

    throw new Error("Bundle not included");
  }
};

export const relayViaBloxroute = async (
  intentHash: string,
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
  if (simulationResult.error) {
    if (JSON.stringify(simulationResult.error).includes("nonce too high")) {
      // Retry with all user transactions removed - assuming the
      // error is coming from their inclusion in previous blocks
      const mappedUserTxs = userTxs.map((tx) => tx.signedTransaction);
      txs = txs.filter((tx) => !mappedUserTxs.includes(tx.signedTransaction));

      return relayViaBloxroute(
        intentHash,
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
          intentHash,
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

  const receipt = await (flashbotsProvider as any).blxrSubmitBundle(
    txs,
    targetBlock
  );
  const hash = (receipt as any).bundleHash;

  logger.info(
    logComponent,
    JSON.stringify({
      msg: "Bundle relayed using bloxroute",
      intentHash,
      targetBlock,
      bundleHash: hash,
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
          intentHash,
          targetBlock,
          bundleHash: hash,
        })
      );
    } else {
      logger.info(
        logComponent,
        JSON.stringify({
          msg: "Bundle not included",
          intentHash,
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
        intentHash,
        targetBlock,
        bundleHash: hash,
      })
    );

    throw new Error("Bundle not included");
  }
};
