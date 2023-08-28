import { Provider } from "@ethersproject/abstract-provider";
import { BigNumber, BigNumberish } from "@ethersproject/bignumber";
import { _TypedDataEncoder } from "@ethersproject/hash";

import { MEMSWAP } from "./addresses";
import { Intent } from "./types";

export const bn = (value: BigNumberish) => BigNumber.from(value);

export const now = () => Math.floor(Date.now() / 1000);

export const isTxIncluded = async (txHash: string, provider: Provider) =>
  provider.getTransactionReceipt(txHash).then((tx) => tx && tx.status === 1);

export const getIntentHash = (intent: Intent) =>
  _TypedDataEncoder.hashStruct("Intent", getEIP712TypesForIntent(), intent);

export const getEIP712Domain = (chainId: number) => ({
  name: "Memswap",
  version: "1.0",
  chainId,
  verifyingContract: MEMSWAP,
});

export const getEIP712TypesForAuthorization = () => ({
  Authorization: [
    {
      name: "intentHash",
      type: "bytes32",
    },
    {
      name: "authorizedSolver",
      type: "address",
    },
    {
      name: "maxAmountIn",
      type: "uint128",
    },
    {
      name: "minAmountOut",
      type: "uint128",
    },
    {
      name: "blockDeadline",
      type: "uint32",
    },
    {
      name: "isPartiallyFillable",
      type: "bool",
    },
  ],
});

export const getEIP712TypesForIntent = () => ({
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
      name: "matchmaker",
      type: "address",
    },
    {
      name: "source",
      type: "address",
    },
    {
      name: "feeBps",
      type: "uint16",
    },
    {
      name: "surplusBps",
      type: "uint16",
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
      name: "endAmountOut",
      type: "uint128",
    },
    {
      name: "startAmountBps",
      type: "uint16",
    },
    {
      name: "expectedAmountBps",
      type: "uint16",
    },
  ],
});
