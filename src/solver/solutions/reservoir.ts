import { Interface } from "@ethersproject/abi";
import { Provider } from "@ethersproject/abstract-provider";
import { BigNumber } from "@ethersproject/bignumber";
import { AddressZero } from "@ethersproject/constants";
import { Contract } from "@ethersproject/contracts";
import { Wallet } from "@ethersproject/wallet";
import axios from "axios";

import { MEMETH, SOLUTION_PROXY_ERC721 } from "../../common/addresses";
import { IntentERC721, TxData } from "../../common/types";
import { bn } from "../../common/utils";
import { config } from "../config";
import { SolutionDetailsERC721 } from "../types";

export const solve = async (
  intent: IntentERC721,
  fillAmount: string,
  provider: Provider
): Promise<SolutionDetailsERC721> => {
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

  const saleStep = result.steps.find((s: any) => s.id === "sale");

  const firstStep = result.steps[0];
  if (firstStep.id === "auth") {
    const item = firstStep.items[0];
    if (item.status === "incomplete") {
      const message = item.data.sign.message;
      const messageSignature = await solver.signMessage(message);

      await axios.post(
        `${reservoirBaseUrl}${item.data.post.endpoint}?signature=${messageSignature}`,
        item.data.post.body
      );

      return solve(intent, fillAmount, provider);
    }
  }

  const tx = saleStep.items[0].data;
  const price = result.path
    .map((item: any) => bn(item.buyInRawQuote ?? item.rawQuote))
    .reduce((a: BigNumber, b: BigNumber) => a.add(b));

  // TODO: Optimizations:
  // - transfer directly to the memswap contract where possible
  const gasUsed = 100000 + 75000 * quantity + 50000 * quantity;

  const contract = new Contract(
    intent.buyToken,
    new Interface([
      "function isApprovedForAll(address owner, address operator) view returns (bool)",
      "function setApprovalForAll(address operator, bool approved)",
    ]),
    provider
  );

  let approvalTxData: TxData | undefined;
  const isApproved = await contract.isApprovedForAll(
    solver.address,
    SOLUTION_PROXY_ERC721[config.chainId]
  );
  if (!isApproved) {
    approvalTxData = {
      from: solver.address,
      to: intent.buyToken,
      data: contract.interface.encodeFunctionData("setApprovalForAll", [
        SOLUTION_PROXY_ERC721[config.chainId],
        true,
      ]),
      gasLimit: 100000,
    };
  }

  return {
    kind: "buy",
    data: {
      calls: [],
      txs: [
        {
          ...tx,
          gasLimit: gasUsed,
        },
        ...(approvalTxData ? [approvalTxData] : []),
      ],
      tokenIds: result.path.map((item: any) => item.tokenId),
      maxSellAmountInEth: price.toString(),
      sellTokenToEthRate:
        intent.sellToken === MEMETH[config.chainId]
          ? "1"
          : await axios
              .get(
                `${reservoirBaseUrl}/currencies/conversion/v1?from=${AddressZero}&to=${intent.sellToken}`
              )
              .then((response) => response.data.conversion),
      gasUsed,
    },
  };
};
