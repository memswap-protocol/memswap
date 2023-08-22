export type Intent = {
  tokenIn: string;
  tokenOut: string;
  maker: string;
  filler: string;
  referrer: string;
  referrerFeeBps: number;
  referrerSurplusBps: number;
  deadline: number;
  isPartiallyFillable: boolean;
  amountIn: string;
  startAmountOut: string;
  expectedAmountOut: string;
  endAmountOut: string;
  signature: string;
};

export type IntentOrigin = "approve" | "deposit-and-approve" | "unknown";

export type TxData = {
  from: string;
  to: string;
  data: string;
};
