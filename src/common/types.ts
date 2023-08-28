export type Intent = {
  tokenIn: string;
  tokenOut: string;
  maker: string;
  matchmaker: string;
  source: string;
  feeBps: number;
  surplusBps: number;
  deadline: number;
  isPartiallyFillable: boolean;
  amountIn: string;
  endAmountOut: string;
  startAmountBps: number;
  expectedAmountBps: number;
  signature: string;
};

export type IntentOrigin = "approval" | "irrelevant";

export type TxData = {
  from: string;
  to: string;
  data: string;
};
