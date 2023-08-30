import { Intent, Solution } from "../common/types";

export type SolutionDetails = {
  to: string;
  data: string;
  amountOut?: string;
  tokenOutToEthRate?: string;
  gasUsed?: string;
};

export type CachedSolution = {
  intent: Intent;
  solution: Solution;
  approvalTxOrTxHash?: string;
};
