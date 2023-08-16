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

export type IntentOrigin = "approve" | "deposit-and-approve" | "unknown";

export type TxData = {
  from: string;
  to: string;
  data: string;
};
