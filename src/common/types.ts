export enum Protocol {
  ERC20,
  ERC721,
}

export type IntentERC20 = {
  isBuy: boolean;
  buyToken: string;
  sellToken: string;
  maker: string;
  solver: string;
  source: string;
  feeBps: number;
  surplusBps: number;
  startTime: number;
  endTime: number;
  nonce: string;
  isPartiallyFillable: boolean;
  isSmartOrder: boolean;
  amount: string;
  expectedAmount: string;
  startAmountBps: number;
  endAmountBps: number;
  signature: string;
};

export type IntentERC721 = IntentERC20 & {
  isCriteriaOrder: boolean;
  tokenIdOrCriteria: string;
};

export type SolutionERC20 = {
  // On-chain data
  data: string;
  fillAmount: string;
};

export type TokenDetails = {
  tokenId: string;
  criteriaProof: string[];
};

export type SolutionERC721 = {
  // On-chain data
  data: string;
  fillTokenDetails: TokenDetails[];
  // Off-chain data
  // ERC721 solutions are not self-contained like ERC20 (might depend on multiple pre-transactions)
  txs: TxData[];
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
