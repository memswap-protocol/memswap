import { Interface } from "@ethersproject/abi";
import { Provider } from "@ethersproject/abstract-provider";
import { AddressZero } from "@ethersproject/constants";
import { Contract } from "@ethersproject/contracts";
import { parseUnits } from "@ethersproject/units";
import {
  WETH9 as UniswapWETH9,
  Currency,
  CurrencyAmount,
  Ether,
  Percent,
  Token,
  TradeType,
} from "@uniswap/sdk-core";
import { AlphaRouter, SwapType } from "@uniswap/smart-order-router";

import { PERMIT2, WETH2, WETH9 } from "../../common/addresses";
import { Intent, Side } from "../../common/types";
import { now } from "../../common/utils";
import { config } from "../config";
import { Call, SolutionDetails } from "../types";

export const getToken = async (
  address: string,
  provider: Provider
): Promise<Currency> => {
  const contract = new Contract(
    address,
    new Interface(["function decimals() view returns (uint8)"]),
    provider
  );

  // The core Uniswap SDK misses the WETH9 address for some chains (eg. Sepolia)
  if (!UniswapWETH9[config.chainId]) {
    UniswapWETH9[config.chainId] = new Token(
      config.chainId,
      WETH9[config.chainId],
      await contract.decimals(),
      "WETH",
      "Wrapped Ether"
    );
  }

  return [WETH2[config.chainId], AddressZero].includes(address)
    ? Ether.onChain(config.chainId)
    : new Token(config.chainId, address, await contract.decimals());
};

export const solve = async (
  intent: Intent,
  fillAmount: string,
  provider: Provider
): Promise<SolutionDetails> => {
  const router = new AlphaRouter({
    chainId: config.chainId,
    provider: provider as any,
  });

  const ethToken = await getToken(AddressZero, provider);
  const fromToken = await getToken(intent.tokenIn, provider);
  const toToken = await getToken(intent.tokenOut, provider);

  const inETH = intent.tokenIn === WETH2[config.chainId];
  if (intent.side === Side.BUY) {
    // Buy `tokenOut` for `tokenIn`

    const [actualRoute, tokenInToEthRate] = await Promise.all([
      router.route(
        CurrencyAmount.fromRawAmount(toToken, fillAmount),
        fromToken,
        TradeType.EXACT_OUTPUT,
        {
          type: SwapType.UNIVERSAL_ROUTER,
          slippageTolerance: new Percent(1, 100),
        }
      ),
      [WETH2[config.chainId], WETH9[config.chainId], AddressZero].includes(
        intent.tokenIn
      )
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
                slippageTolerance: new Percent(1, 100),
              }
            )
            .then((r) => r!.quote.toFixed()),
    ]);

    const maxAmountIn = parseUnits(
      actualRoute!.quote.toExact(),
      actualRoute!.quote.currency.decimals
    );

    return {
      kind: "buy",
      data: {
        calls: [
          {
            to: intent.tokenIn,
            data: new Interface([
              "function approve(address spender, uint256 amount)",
              "function withdraw(uint256 amount)",
            ]).encodeFunctionData(
              inETH ? "withdraw" : "approve",
              inETH ? [maxAmountIn] : [PERMIT2[config.chainId], maxAmountIn]
            ),
            value: "0",
          },
          !inETH
            ? {
                to: PERMIT2[config.chainId],
                data: new Interface([
                  "function approve(address token, address spender, uint160 amount, uint48 expiration)",
                ]).encodeFunctionData("approve", [
                  intent.tokenIn,
                  actualRoute!.methodParameters!.to,
                  maxAmountIn,
                  now() + 3600,
                ]),
                value: "0",
              }
            : undefined,
          {
            to: actualRoute!.methodParameters!.to,
            data: actualRoute!.methodParameters!.calldata,
            value: inETH ? maxAmountIn : "0",
          },
        ].filter(Boolean) as Call[],
        maxAmountIn: maxAmountIn.toString(),
        tokenInToEthRate,
        gasUsed: actualRoute!.estimatedGasUsed.toString(),
      },
    };
  } else {
    // Sell `tokenIn` to `tokenOut`

    const [actualRoute, tokenOutToEthRate] = await Promise.all([
      router.route(
        CurrencyAmount.fromRawAmount(fromToken, fillAmount),
        toToken,
        TradeType.EXACT_INPUT,
        {
          type: SwapType.UNIVERSAL_ROUTER,
          slippageTolerance: new Percent(1, 100),
        }
      ),
      [WETH2[config.chainId], WETH9[config.chainId], AddressZero].includes(
        intent.tokenOut
      )
        ? "1"
        : router
            .route(
              CurrencyAmount.fromRawAmount(
                ethToken,
                parseUnits("1", 18).toString()
              ),
              toToken,
              TradeType.EXACT_INPUT,
              {
                type: SwapType.UNIVERSAL_ROUTER,
                slippageTolerance: new Percent(1, 100),
              }
            )
            .then((r) => r!.quote.toFixed()),
    ]);

    return {
      kind: "sell",
      data: {
        calls: [
          {
            to: intent.tokenIn,
            data: new Interface([
              "function approve(address spender, uint256 amount)",
              "function withdraw(uint256 amount)",
            ]).encodeFunctionData(
              inETH ? "withdraw" : "approve",
              inETH ? [fillAmount] : [PERMIT2[config.chainId], fillAmount]
            ),
            value: "0",
          },
          !inETH
            ? {
                to: PERMIT2[config.chainId],
                data: new Interface([
                  "function approve(address token, address spender, uint160 amount, uint48 expiration)",
                ]).encodeFunctionData("approve", [
                  intent.tokenIn,
                  actualRoute!.methodParameters!.to,
                  fillAmount,
                  now() + 3600,
                ]),
                value: "0",
              }
            : undefined,
          {
            to: actualRoute!.methodParameters!.to,
            data: actualRoute!.methodParameters!.calldata,
            value: inETH ? fillAmount : "0",
          },
        ].filter(Boolean) as Call[],
        minAmountOut: parseUnits(
          actualRoute!.quote.toExact(),
          actualRoute!.quote.currency.decimals
        ).toString(),
        tokenOutToEthRate,
        gasUsed: actualRoute!.estimatedGasUsed.toString(),
      },
    };
  }
};
