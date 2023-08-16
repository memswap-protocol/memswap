import { Intent } from "../common/types";

export type IntentFill = {
  intent: Intent;
  fillContract: string;
  fillData: string;
};

export type BestFill = {
  preTxs: string[];
  fill: IntentFill;
  amountReceived: string;
};
