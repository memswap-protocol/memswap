import { Intent, Solution } from "../common/types";

export type SolutionDetails = {
  to: string;
  data: string;
  amountOut?: string;
  tokenOutToEthRate?: string;
};

export type CachedSolution = {
  intent: Intent;
  solution: Solution;
  approvalTxHash?: string;
};
