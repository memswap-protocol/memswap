import { Interface } from "@ethersproject/abi";
import { AddressZero } from "@ethersproject/constants";
import axios from "axios";

import { MEMETH } from "../../common/addresses";
import { config } from "../config";

const ZEROEX_ETH = "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee";

// TODO: Update logic to cover new intent structure
export const solve = async (
  tokenIn: string,
  tokenOut: string,
  amountIn: string
) => {
  const inETH = tokenIn === MEMETH[config.chainId];

  const { data: swapData } = await axios.get(
    config.chainId === 1
      ? "https://api.0x.org/swap/v1/quote"
      : "https://goerli.api.0x.org/swap/v1/quote",
    {
      params: {
        buyToken: tokenOut === AddressZero ? ZEROEX_ETH : tokenOut,
        sellToken: inETH ? ZEROEX_ETH : tokenIn,
        sellAmount: amountIn,
      },
      headers: {
        "0x-Api-Key": config.zeroExApiKey,
      },
    }
  );

  return {
    calls: [
      {
        to: tokenIn,
        data: new Interface([
          "function approve(address spender, uint256 amount)",
          "function withdraw(uint256 amount)",
        ]).encodeFunctionData(
          inETH ? "withdraw" : "approve",
          inETH ? [amountIn] : [swapData.to, amountIn]
        ),
        value: "0",
      },
      {
        to: swapData.to,
        data: swapData.data,
        value: inETH ? amountIn : "0",
      },
    ],
    minAmountOut: swapData.buyAmount,
    tokenOutToEthRate: swapData.buyTokenToEthRate,
    gasUsed: swapData.estimatedGas,
  };
};
