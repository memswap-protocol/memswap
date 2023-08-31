import { JsonRpcProvider } from "@ethersproject/providers";
import { Wallet } from "@ethersproject/wallet";
import { FlashbotsBundleProvider } from "@flashbots/ethers-provider-bundle";

import { config } from "./config";

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
