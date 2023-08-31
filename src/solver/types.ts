import { Intent, Solution } from "../common/types";

export type Call = {
  to: string;
  data: string;
  value: string;
};

export type SolutionDetails = {
  calls: Call[];
  minAmountOut: string;
  tokenOutToEthRate: string;
  gasUsed: string;
};

export type CachedSolution = {
  intent: Intent;
  solution: Solution;
  approvalTxOrTxHash?: string;
};
