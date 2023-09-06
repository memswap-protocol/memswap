import { Intent, Solution } from "../common/types";

export type Call = {
  to: string;
  data: string;
  value: string;
};

export type SellSolutionData = {
  calls: Call[];
  minAmountOut: string;
  tokenOutToEthRate: string;
  gasUsed: string;
};

export type BuySolutionData = {
  calls: Call[];
  maxAmountIn: string;
  tokenInToEthRate: string;
  gasUsed: string;
};

export type SolutionDetails =
  | {
      kind: "sell";
      data: SellSolutionData;
    }
  | {
      kind: "buy";
      data: BuySolutionData;
    };

export type CachedSolution = {
  intent: Intent;
  solution: Solution;
  approvalTxOrTxHash?: string;
};
