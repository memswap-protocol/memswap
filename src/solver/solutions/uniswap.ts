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

  const chainId = await provider.getNetwork().then((n) => n.chainId);

  // The core Uniswap SDK misses the WETH9 address for some chains (eg. Sepolia)
  if (!WETH9[chainId]) {
    WETH9[chainId] = new Token(
      chainId,
      REGULAR_WETH,
      await contract.decimals(),
      "WETH",
      "Wrapped Ether"
    );
  }

  return [MEMSWAP_WETH, AddressZero].includes(address)
    ? Ether.onChain(chainId)
    : new Token(chainId, address, await contract.decimals());
};

export const solve = async (
  tokenIn: string,
  tokenOut: string,
  amountIn: string,
  provider: Provider
): Promise<SolutionDetails> => {
  const chainId = await provider.getNetwork().then((n) => n.chainId);
  const router = new AlphaRouter({
    chainId,
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
