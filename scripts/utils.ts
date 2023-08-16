import { BigNumber, BigNumberish } from "@ethersproject/bignumber";

// --- Types ---

export type Intent = {
  maker: string;
  filler: string;
  tokenIn: string;
  tokenOut: string;
  referrer: string;
  referrerFeeBps: number;
  referrerSurplusBps: number;
  deadline: number;
  amountIn: string;
  startAmountOut: string;
  expectedAmountOut: string;
  endAmountOut: string;
  signature: string;
};

// --- Constants ---

export const FILLER = "0x2f8e1f5516b423801c26cf455a02988b3a01627f";
export const MEMSWAP = "0x90d4ecf99ad7e8ac74994c5181ca78b279ca9f8e";
export const WETH2 = "0xe6ea2a148c13893a8eedd57c75043055a8924c5f";

// --- EIP712 ---

export const getEIP712Domain = (chainId: number) => ({
  name: "Memswap",
  version: "1.0",
  chainId,
  verifyingContract: MEMSWAP,
});

export const getEIP712Types = () => ({
  Intent: [
    {
      name: "maker",
      type: "address",
    },
    {
      name: "filler",
      type: "address",
    },
    {
      name: "tokenIn",
      type: "address",
    },
    {
      name: "tokenOut",
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

// --- Misc ---

export const bn = (value: BigNumberish) => BigNumber.from(value);
