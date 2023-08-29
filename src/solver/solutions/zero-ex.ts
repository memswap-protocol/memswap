import axios from "axios";

import { MEMSWAP_WETH } from "../../common/addresses";
import { config } from "../config";
import { SolutionDetails } from "../types";

export const solve = async (
  tokenIn: string,
  tokenOut: string,
  amountIn: string
): Promise<SolutionDetails> => {
  const { data: swapData } = await axios.get(
    config.chainId === 1
      ? "https://api.0x.org/swap/v1/quote"
      : "https://goerli.api.0x.org/swap/v1/quote",
    {
      params: {
        buyToken: tokenOut,
        sellToken:
          tokenIn === MEMSWAP_WETH[config.chainId]
            ? "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee"
            : tokenIn,
        sellAmount: amountIn,
      },
      headers: {
        "0x-Api-Key": config.zeroExApiKey,
      },
    }
  );

  return {
    to: swapData.to,
    data: swapData.data,
    amountOut: swapData.buyAmount,
    tokenOutToEthRate: swapData.buyTokenToEthRate,
  };
};
