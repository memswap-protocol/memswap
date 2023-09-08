import { Interface } from "@ethersproject/abi";
import { BigNumber } from "@ethersproject/bignumber";
import { AddressZero } from "@ethersproject/constants";
import { Wallet } from "@ethersproject/wallet";
import axios from "axios";

import { MEMSWAP_ERC721, SOLUTION_PROXY_ERC721 } from "../../common/addresses";
import { IntentERC721 } from "../../common/types";
import { bn } from "../../common/utils";
import { config } from "../config";
import { SolutionDetailsERC721 } from "../types";

export const solve = async (
  intent: IntentERC721,
  fillAmount: string
): Promise<SolutionDetailsERC721> => {
  // TODO: Handle multi-step / incomplete responses

  const solver = new Wallet(config.solverPk);
  const quantity = Number(fillAmount);

  const reservoirBaseUrl =
    config.chainId === 1
      ? "https://api.reservoir.tools"
      : "https://api-goerli.reservoir.tools";

  const result = await axios
    .post(`${reservoirBaseUrl}/execute/buy/v7`, {
      items: [
        {
          collection: intent.buyToken,
          quantity,
          fillType: "trade",
        },
      ],
      taker: solver.address,
      currency: AddressZero,
    })
    .then((r) => r.data);

  const tx = result.steps[0].items[0].data;
  const price = result.path
    .map((item: any) => bn(item.buyInRawQuote ?? item.rawQuote))
    .reduce((a: BigNumber, b: BigNumber) => a.add(b));

  // TODO: Optimizations:
  // - transfer directly to the memswap contract where possible
  const gasUsed = 100000 + 75000 * quantity + 50000 * quantity;

  return {
    kind: "buy",
    data: {
      calls: [],
      txs: [
        {
          ...tx,
          gasLimit: gasUsed,
        },
        ...result.path.map((item: any) => ({
          to: intent.buyToken,
          data: new Interface([
            "function transferFrom(address from, address to, uint256 tokenId)",
          ]).encodeFunctionData("transferFrom", [
            solver.address,
            SOLUTION_PROXY_ERC721[config.chainId],
            item.tokenId,
          ]),
          value: "0",
          gasLimit: 100000,
        })),
      ],
      tokenIds: result.path.map((item: any) => item.tokenId),
      maxSellAmountInEth: price.toString(),
      sellTokenToEthRate: await axios
        .get(
          `${reservoirBaseUrl}/currencies/conversion/v1?from=${AddressZero}&to=${intent.sellToken}`
        )
        .then((response) => response.data.conversion),
      gasUsed,
    },
  };
};
