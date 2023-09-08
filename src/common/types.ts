export enum Protocol {
  ERC20,
  ERC721,
}

export type IntentERC20 = {
  isBuy: boolean;
  buyToken: string;
  sellToken: string;
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
  hasDynamicSignature: boolean;
  signature: string;
};

export type IntentERC721 = IntentERC20 & {
  hasCriteria: boolean;
  tokenIdOrCriteria: string;
};

export type SolutionERC20 = {
  data: string;
  fillAmounts: string[];
  executeAmounts: string[];
};

export type TokenDetails = {
  tokenId: string;
  criteriaProof: string[];
};

export type SolutionERC721 = {
  // ERC721 solutions are not self-contained like ERC20
  // (might depend on multiple pre-transactions)
  txs: TxData[];
  data: string;
  fillTokenDetails: TokenDetails[][];
  executeAmounts: string[];
};

export type Authorization = {
  intentHash: string;
  solver: string;
  fillAmountToCheck: string;
  executeAmountToCheck: string;
  blockDeadline: number;
  signature?: string;
};

export type TxData = {
  from: string;
  to: string;
  data: string;
  gasLimit?: number;
};
