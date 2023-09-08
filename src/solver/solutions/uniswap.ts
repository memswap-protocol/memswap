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
import { IntentERC20 } from "../../common/types";
import { now } from "../../common/utils";
import { config } from "../config";
import { Call, SolutionDetailsERC20 } from "../types";

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
  intent: IntentERC20,
  fillAmount: string,
  provider: Provider
): Promise<SolutionDetailsERC20> => {
  const router = new AlphaRouter({
    chainId: config.chainId,
    provider: provider as any,
  });

  const ethToken = await getToken(AddressZero, provider);
  const fromToken = await getToken(intent.sellToken, provider);
  const toToken = await getToken(intent.buyToken, provider);

  const inETH = intent.sellToken === WETH2[config.chainId];
  if (intent.isBuy) {
    // Buy fixed amount of `buyToken` for variable amount of `sellToken`

    const [actualRoute, sellTokenToEthRate] = await Promise.all([
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
        intent.sellToken
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
            to: intent.sellToken,
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
                  intent.sellToken,
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
        maxSellAmount: maxAmountIn.toString(),
        sellTokenToEthRate,
        gasUsed: actualRoute!.estimatedGasUsed.toNumber(),
      },
    };
  } else {
    // Sell fixed amount of `sellToken` for variable amount of `buyToken`

    const [actualRoute, buyTokenToEthRate] = await Promise.all([
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
        intent.buyToken
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
            to: intent.sellToken,
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
                  intent.sellToken,
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
        minBuyAmount: parseUnits(
          actualRoute!.quote.toExact(),
          actualRoute!.quote.currency.decimals
        ).toString(),
        buyTokenToEthRate,
        gasUsed: actualRoute!.estimatedGasUsed.toNumber(),
      },
    };
  }
};
