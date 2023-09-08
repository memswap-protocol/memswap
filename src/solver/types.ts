import {
  IntentERC20,
  IntentERC721,
  SolutionERC20,
  SolutionERC721,
  TxData,
} from "../common/types";

export type Call = {
  to: string;
  data: string;
  value: string;
};

// ERC20

export type SellSolutionDataERC20 = {
  calls: Call[];
  minBuyAmount: string;
  buyTokenToEthRate: string;
  gasUsed: number;
};

export type BuySolutionDataERC20 = {
  calls: Call[];
  maxSellAmount: string;
  sellTokenToEthRate: string;
  gasUsed: number;
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

// ERC721

export type BuySolutionDataERC721 = {
  calls: Call[];
  txs: TxData[];
  tokenIds: string[];
  maxSellAmountInEth: string;
  sellTokenToEthRate: string;
  gasUsed: number;
};

export type SolutionDetailsERC721 = {
  kind: "buy";
  data: BuySolutionDataERC721;
};

export type CachedSolutionERC721 = {
  intent: IntentERC721;
  solution: SolutionERC721;
  approvalTxOrTxHash?: string;
};
