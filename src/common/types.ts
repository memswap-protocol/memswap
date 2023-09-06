export enum Side {
  BUY,
  SELL,
}

export type Intent = {
  side: Side;
  tokenIn: string;
  tokenOut: string;
  maker: string;
  matchmaker: string;
  source: string;
  feeBps: number;
  surplusBps: number;
  startTime: number;
  endTime: number;
  nonce: string;
  isPartiallyFillable: boolean;
  amount: string;
  endAmount: string;
  startAmountBps: number;
  expectedAmountBps: number;
  hasDynamicSignature: string;
  signature: string;
};

export type Authorization = {
  intentHash: string;
  solver: string;
  fillAmountToCheck: string;
  executeAmountToCheck: string;
  blockDeadline: number;
  signature?: string;
};

export type Solution = {
  data: string;
  fillAmounts: string[];
  executeAmounts: string[];
};

export type TxData = {
  from: string;
  to: string;
  data: string;
};
