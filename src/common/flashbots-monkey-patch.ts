import { keccak256 } from "@ethersproject/keccak256";
import { parse } from "@ethersproject/transactions";
import {
  FlashbotsBundleProvider,
  FlashbotsBundleRawTransaction,
} from "@flashbots/ethers-provider-bundle";
import axios from "axios";

import { config } from "./config";

// Inspiration:
// https://github.com/koraykoska/mev-bundle-submitter/blob/47696f4376e9b97cf44d042112c779e279805b1d/monkey-patches.js

(FlashbotsBundleProvider.prototype as any).blxrSubmitBundle = async function (
  txs: FlashbotsBundleRawTransaction[],
  targetBlock: number
) {
  const response = await axios.post(
    "https://mev.api.blxrbdn.com",
    {
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
    {
      headers: {
        Authorization: config.bloxrouteAuth,
      },
    }
  );

  const bundleTransactions = txs.map((tx) => {
    const txDetails = parse(tx.signedTransaction);
    return {
      signedTransaction: tx.signedTransaction,
      hash: keccak256(tx.signedTransaction),
      account: txDetails.from,
      nonce: txDetails.nonce,
    };
  });

  return {
    wait: () =>
      this.waitForBundleInclusion(bundleTransactions, targetBlock, 60 * 1000),
    bundleHash: response.data?.result?.bundleHash,
  };
};
