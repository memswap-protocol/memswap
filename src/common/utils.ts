import { Provider } from "@ethersproject/abstract-provider";
import { BigNumber, BigNumberish } from "@ethersproject/bignumber";

import { MEMSWAP } from "./addresses";

export const bn = (value: BigNumberish) => BigNumber.from(value);

export const now = () => Math.floor(Date.now() / 1000);

export const isTxIncluded = async (txHash: string, provider: Provider) =>
  provider.getTransactionReceipt(txHash).then((tx) => tx && tx.status === 1);

export const getEIP712Domain = (chainId: number) => ({
  name: "Memswap",
  version: "1.0",
  chainId,
  verifyingContract: MEMSWAP,
});

export const getEIP712Types = () => ({
  Intent: [
    {
      name: "tokenIn",
      type: "address",
    },
    {
      name: "tokenOut",
      type: "address",
    },
    {
      name: "maker",
      type: "address",
    },
    {
      name: "filler",
      type: "address",
    },
    {
      name: "referrer",
      type: "address",
    },
    {
      name: "referrerFeeBps",
      type: "uint32",
    },
    {
      name: "referrerSurplusBps",
      type: "uint32",
    },
    {
      name: "deadline",
      type: "uint32",
    },
    {
      name: "isPartiallyFillable",
      type: "bool",
    },
    {
      name: "amountIn",
      type: "uint128",
    },
    {
      name: "startAmountOut",
      type: "uint128",
    },
    {
      name: "expectedAmountOut",
      type: "uint128",
    },
    {
      name: "endAmountOut",
      type: "uint128",
    },
  ],
});
