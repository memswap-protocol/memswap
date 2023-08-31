import { AddressZero } from "@ethersproject/constants";
import axios from "axios";

import { MEMSWAP_WETH } from "../../common/addresses";
import { config } from "../config";
import { SolutionDetails } from "../types";

const ZEROEX_ETH = "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee";

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
        buyToken: tokenOut === AddressZero ? ZEROEX_ETH : tokenOut,
        sellToken:
          tokenIn === MEMSWAP_WETH[config.chainId] ? ZEROEX_ETH : tokenIn,
        sellAmount: amountIn,
      },
      headers: {
        "0x-Api-Key": config.zeroExApiKey,
      },
    }
  );

  return {
    callTo: swapData.to,
    approveTo: swapData.to,
    data: swapData.data,
    amountOut: swapData.buyAmount,
    tokenOutToEthRate: swapData.buyTokenToEthRate,
    gasUsed: swapData.estimatedGas,
  };
};
