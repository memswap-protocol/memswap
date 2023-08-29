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

export type Authorization = {
  intentHash: string;
  authorizedSolver: string;
  maxAmountIn: string;
  minAmountOut: string;
  blockDeadline: number;
  isPartiallyFillable: boolean;
  signature?: string;
};

export type Solution = {
  to: string;
  data: string;
  amount: string;
};

export type TxData = {
  from: string;
  to: string;
  data: string;
};
