import { Interface } from "@ethersproject/abi";
import { AddressZero } from "@ethersproject/constants";
import axios from "axios";

import { MEMETH } from "../../common/addresses";
import { IntentERC20 } from "../../common/types";
import { bn } from "../../common/utils";
import { config } from "../config";
import { SolutionDetailsERC20 } from "../types";

export const ZEROEX_ETH = "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee";

export const solve = async (
  intent: IntentERC20,
  fillAmount: string
): Promise<SolutionDetailsERC20> => {
  const inETH = intent.sellToken === MEMETH[config.chainId];
  if (intent.isBuy) {
    // Buy fixed amount of `buyToken` for variable amount of `sellToken`

    const { data: swapData } = await axios.get(
      config.chainId === 1
        ? "https://api.0x.org/swap/v1/quote"
        : "https://goerli.api.0x.org/swap/v1/quote",
      {
        params: {
          buyToken:
            intent.buyToken === AddressZero ? ZEROEX_ETH : intent.buyToken,
          sellToken: inETH ? ZEROEX_ETH : intent.sellToken,
          buyAmount: fillAmount,
        },
        headers: {
          "0x-Api-Key": config.zeroExApiKey,
        },
      }
    );

    // Adjust the sell amount based on the slippage (which defaults to 1%)
    const sellAmount = bn(swapData.sellAmount).add(1).mul(10100).div(10000);

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
              inETH ? [sellAmount] : [swapData.to, sellAmount]
            ),
            value: "0",
          },
          {
            to: swapData.to,
            data: swapData.data,
            value: inETH ? sellAmount.toString() : "0",
          },
        ],
        maxSellAmount: sellAmount.toString(),
        sellTokenToEthRate: swapData.sellTokenToEthRate,
        gasUsed: swapData.estimatedGas,
      },
    };
  } else {
    // Sell fixed amount of `sellToken` for variable amount of `buyToken`

    const { data: swapData } = await axios.get(
      config.chainId === 1
        ? "https://api.0x.org/swap/v1/quote"
        : "https://goerli.api.0x.org/swap/v1/quote",
      {
        params: {
          buyToken:
            intent.buyToken === AddressZero ? ZEROEX_ETH : intent.buyToken,
          sellToken: inETH ? ZEROEX_ETH : intent.sellToken,
          sellAmount: fillAmount,
        },
        headers: {
          "0x-Api-Key": config.zeroExApiKey,
        },
      }
    );

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
              inETH ? [fillAmount] : [swapData.to, fillAmount]
            ),
            value: "0",
          },
          {
            to: swapData.to,
            data: swapData.data,
            value: inETH ? fillAmount : "0",
          },
        ],
        minBuyAmount: swapData.buyAmount,
        buyTokenToEthRate: swapData.buyTokenToEthRate,
        gasUsed: swapData.estimatedGas,
      },
    };
  }
};
