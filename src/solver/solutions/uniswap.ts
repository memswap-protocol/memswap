import { Interface } from "@ethersproject/abi";
import { Provider } from "@ethersproject/abstract-provider";
import { AddressZero } from "@ethersproject/constants";
import { Contract } from "@ethersproject/contracts";
import {
  WETH9,
  Currency,
  CurrencyAmount,
  Ether,
  Percent,
  Token,
  TradeType,
} from "@uniswap/sdk-core";
import { AlphaRouter, SwapType } from "@uniswap/smart-order-router";

import { MEMSWAP_WETH, REGULAR_WETH } from "../../common/addresses";
import { config } from "../config";
import { SolutionDetails } from "../types";

const getToken = async (
  address: string,
  provider: Provider
): Promise<Currency> => {
  const contract = new Contract(
    address,
    new Interface(["function decimals() view returns (uint8)"]),
    provider
  );

  // The core Uniswap SDK misses the WETH9 address for some chains (eg. Sepolia)
  if (!WETH9[config.chainId]) {
    WETH9[config.chainId] = new Token(
      config.chainId,
      REGULAR_WETH[config.chainId],
      await contract.decimals(),
      "WETH",
      "Wrapped Ether"
    );
  }

  return [MEMSWAP_WETH[config.chainId], AddressZero].includes(address)
    ? Ether.onChain(config.chainId)
    : new Token(config.chainId, address, await contract.decimals());
};

export const solve = async (
  tokenIn: string,
  tokenOut: string,
  amountIn: string,
  provider: Provider
): Promise<SolutionDetails> => {
  const router = new AlphaRouter({
    chainId: config.chainId,
    provider: provider as any,
  });

  const fromToken = await getToken(tokenIn, provider);
  const toToken = await getToken(tokenOut, provider);

  const route = await router.route(
    CurrencyAmount.fromRawAmount(fromToken, amountIn),
    toToken,
    TradeType.EXACT_INPUT,
    {
      type: SwapType.UNIVERSAL_ROUTER,
      slippageTolerance: new Percent(5, 100),
    }
  );

  return {
    to: route!.methodParameters!.to,
    data: route!.methodParameters!.calldata,
  };
};
