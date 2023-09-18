import { Interface } from "@ethersproject/abi";
import { Provider } from "@ethersproject/abstract-provider";
import { BigNumber } from "@ethersproject/bignumber";
import { AddressZero } from "@ethersproject/constants";
import { Contract } from "@ethersproject/contracts";
import { Wallet } from "@ethersproject/wallet";
import axios from "axios";

import { MEMETH, SOLUTION_PROXY } from "../../common/addresses";
import { IntentERC721, TxData } from "../../common/types";
import { bn } from "../../common/utils";
import { config } from "../config";
import { Call, SolutionDetailsERC721 } from "../types";

const getReservoirBaseUrl = () =>
  config.chainId === 1
    ? "https://api.reservoir.tools"
    : "https://api-goerli.reservoir.tools";

export const getEthConversion = async (token: string) =>
  token === MEMETH[config.chainId]
    ? "1"
    : await axios
        .get(
          `${getReservoirBaseUrl()}/currencies/conversion/v1?from=${AddressZero}&to=${token}`
        )
        .then((response) => response.data.conversion);

export const solve = async (
  intent: IntentERC721,
  fillAmount: string,
  provider: Provider
): Promise<SolutionDetailsERC721> => {
  const solver = new Wallet(config.solverPk);
  const quantity = Number(fillAmount);

  const requestOptions = {
    items: [
      {
        collection: intent.buyToken,
        quantity,
        fillType: "trade",
      },
    ],
    taker: solver.address,
    currency: AddressZero,
    skipBalanceCheck: true,
  };

  let useMultiTxs = intent.sellToken !== MEMETH[config.chainId];

  // When solving Blur orders, we must use multi-tx filling
  const onlyPathResult = await axios
    .post(
      `${getReservoirBaseUrl()}/execute/buy/v7`,
      {
        ...requestOptions,
        onlyPath: true,
      },
      {
        headers: {
          "X-Api-Key": config.reservoirApiKey,
        },
      }
    )
    .then((r) => r.data);
  if (onlyPathResult.path.some((item: any) => item.source === "blur.io")) {
    useMultiTxs = true;
  }

  const result = await axios
    .post(
      `${getReservoirBaseUrl()}/execute/buy/v7`,
      {
        ...requestOptions,
        taker: useMultiTxs ? solver.address : intent.maker,
        relayer: useMultiTxs ? undefined : solver.address,
      },
      {
        headers: {
          "X-Api-Key": config.reservoirApiKey,
        },
      }
    )
    .then((r) => r.data);
  if (useMultiTxs) {
    // Handle the Blur auth step
    const firstStep = result.steps[0];
    if (firstStep.id === "auth") {
      const item = firstStep.items[0];
      if (item.status === "incomplete") {
        const message = item.data.sign.message;
        const messageSignature = await solver.signMessage(message);

        await axios.post(
          `${getReservoirBaseUrl()}${
            item.data.post.endpoint
          }?signature=${messageSignature}`,
          item.data.post.body
        );

        return solve(intent, fillAmount, provider);
      }
    }
  }

  for (const step of result.steps.filter((s: any) => s.id !== "sale")) {
    if (
      step.items.length &&
      step.items.some((item: any) => item.status === "incomplete")
    ) {
      throw new Error("Multi-step sales not supported");
    }
  }

  const saleStep = result.steps.find((s: any) => s.id === "sale");
  if (saleStep.items.length > 1) {
    throw new Error("Multi-transaction sales not supported");
  }

  const saleTx = saleStep.items[0].data;

  const tokenIds = result.path.map((item: any) => item.tokenId);
  const price = result.path
    .map((item: any) => bn(item.buyInRawQuote ?? item.rawQuote))
    .reduce((a: BigNumber, b: BigNumber) => a.add(b));

  // TODO: Optimizations:
  // - transfer directly to the memswap contract where possible
  const gasUsed = 100000 + 75000 * quantity + 50000 * quantity;

  const calls: Call[] = [];
  const txs: TxData[] = [];
  if (useMultiTxs) {
    const contract = new Contract(
      intent.buyToken,
      new Interface([
        "function isApprovedForAll(address owner, address operator) view returns (bool)",
        "function setApprovalForAll(address operator, bool approved)",
        "function transferFrom(address from, address to, uint256 tokenId)",
      ]),
      provider
    );

    let approvalTxData: TxData | undefined;
    const isApproved = await contract.isApprovedForAll(
      solver.address,
      SOLUTION_PROXY[config.chainId]
    );
    if (!isApproved) {
      approvalTxData = {
        from: solver.address,
        to: intent.buyToken,
        data: contract.interface.encodeFunctionData("setApprovalForAll", [
          SOLUTION_PROXY[config.chainId],
          true,
        ]),
        gasLimit: 100000,
      };
    }

    // Sale tx
    txs.push({
      ...saleTx,
      gasLimit: gasUsed,
    });

    // Optional approval tx
    if (approvalTxData) {
      txs.push(approvalTxData);
    }

    // Transfer calls
    for (const tokenId of tokenIds) {
      calls.push({
        to: intent.buyToken,
        data: contract.interface.encodeFunctionData("transferFrom", [
          solver.address,
          intent.maker,
          tokenId,
        ]),
        value: "0",
      });
    }
  } else {
    // Withdraw/unwrap tx
    calls.push({
      to: intent.sellToken,
      data: new Interface([
        "function withdraw(uint256 amount)",
      ]).encodeFunctionData("withdraw", [price]),
      value: "0",
    });

    // Sale tx
    calls.push({
      to: saleTx.to,
      data: saleTx.data,
      value: saleTx.value,
    });
  }

  return {
    kind: "buy",
    data: {
      calls,
      txs,
      tokenIds,
      maxSellAmountInEth: price.toString(),
      sellTokenToEthRate: await getEthConversion(intent.sellToken),
      gasUsed,
    },
  };
};
