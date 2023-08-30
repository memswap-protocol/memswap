import { Interface } from "@ethersproject/abi";
import { Provider } from "@ethersproject/abstract-provider";
import { AddressZero } from "@ethersproject/constants";
import { Contract } from "@ethersproject/contracts";
import { parseUnits } from "@ethersproject/units";
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

  const ethToken = await getToken(AddressZero, provider);
  const fromToken = await getToken(tokenIn, provider);
  const toToken = await getToken(tokenOut, provider);

  const [actualRoute, tokenOutToEthRate] = await Promise.all([
    router.route(
      CurrencyAmount.fromRawAmount(fromToken, amountIn),
      toToken,
      TradeType.EXACT_INPUT,
      {
        type: SwapType.UNIVERSAL_ROUTER,
        slippageTolerance: new Percent(5, 100),
      }
    ),
    [
      MEMSWAP_WETH[config.chainId],
      REGULAR_WETH[config.chainId],
      AddressZero,
    ].includes(tokenIn)
      ? "1"
      : router
          .route(
            CurrencyAmount.fromRawAmount(
              ethToken,
              parseUnits("1", 18).toString()
            ),
            fromToken,
            TradeType.EXACT_INPUT,
            {
              type: SwapType.UNIVERSAL_ROUTER,
              slippageTolerance: new Percent(5, 100),
            }
          )
          .then((r) => r!.quote.toFixed()),
  ]);

  return {
    to: actualRoute!.methodParameters!.to,
    data: actualRoute!.methodParameters!.calldata,
    amountOut: parseUnits(
      actualRoute!.quote.toExact(),
      actualRoute!.quote.currency.decimals
    ).toString(),
    tokenOutToEthRate,
  };
};
