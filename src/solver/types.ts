import { IntentERC20, SolutionERC20 } from "../common/types";

export type Call = {
  to: string;
  data: string;
  value: string;
};

export type SellSolutionDataERC20 = {
  calls: Call[];
  minBuyAmount: string;
  buyTokenToEthRate: string;
  gasUsed: string;
};

export type BuySolutionDataERC20 = {
  calls: Call[];
  maxSellAmount: string;
  sellTokenToEthRate: string;
  gasUsed: string;
};

export type SolutionDetailsERC20 =
  | {
      kind: "sell";
      data: SellSolutionDataERC20;
    }
  | {
      kind: "buy";
      data: BuySolutionDataERC20;
    };

export type CachedSolutionERC20 = {
  intent: IntentERC20;
  solution: SolutionERC20;
  approvalTxOrTxHash?: string;
};
