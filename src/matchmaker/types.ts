import { IntentERC20, IntentERC721 } from "../common/types";

export type Solution = {
  intent: IntentERC20 | IntentERC721;
  solver: string;
  fillAmountToCheck: string;
  executeAmountToCheck: string;
  userTxs: string[];
  txs: string[];
};
