import axios from "axios";

import { WETH2 } from "../../common/addresses";
import { config } from "../config";
import { Solution } from "../types";

export const solve = async (
  tokenIn: string,
  tokenOut: string,
  amountIn: string
): Promise<Solution> => {
  const { data: swapData } = await axios.get(
    "https://goerli.api.0x.org/swap/v1/quote",
    {
      params: {
        buyToken: tokenOut,
        sellToken:
          tokenIn === WETH2
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
