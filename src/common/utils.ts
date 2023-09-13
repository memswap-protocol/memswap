import { Interface } from "@ethersproject/abi";
import { Provider } from "@ethersproject/abstract-provider";
import { BigNumber, BigNumberish } from "@ethersproject/bignumber";
import { Contract } from "@ethersproject/contracts";
import { _TypedDataEncoder } from "@ethersproject/hash";

import { MEMSWAP_ERC20, MEMSWAP_ERC721 } from "./addresses";
import { Authorization, IntentERC20, IntentERC721, Protocol } from "./types";

export const AVERAGE_BLOCK_TIME = 12;
export const PESSIMISTIC_BLOCK_TIME = 15;

export const bn = (value: BigNumberish) => BigNumber.from(value);

export const now = () => Math.floor(Date.now() / 1000);

export const isTxIncluded = async (txHash: string, provider: Provider) =>
  provider.getTransactionReceipt(txHash).then((tx) => tx && tx.status === 1);

export const isERC721Intent = (intent: IntentERC20 | IntentERC721) =>
  "isCriteriaOrder" in intent;

export const isIntentFilled = async (
  intent: IntentERC20 | IntentERC721,
  chainId: number,
  provider: Provider
) => {
  const memswap = new Contract(
    isERC721Intent(intent) ? MEMSWAP_ERC721[chainId] : MEMSWAP_ERC20[chainId],
    new Interface([
      `function intentStatus(bytes32 intentHash) view returns (
        (
          bool isValidated,
          bool isCancelled,
          uint128 amountFilled
        )
      )`,
    ]),
    provider
  );

  const intentHash = getIntentHash(intent);
  const result = await memswap.intentStatus(intentHash);
  if (result.amountFilled.gte(intent.amount)) {
    return true;
  }

  return false;
};

export const getAuthorizationHash = (authorization: Authorization) =>
  _TypedDataEncoder.hashStruct(
    "Authorization",
    getEIP712TypesForAuthorization(),
    authorization
  );

export const getIntentHash = (intent: IntentERC20 | IntentERC721) =>
  _TypedDataEncoder.hashStruct(
    "Intent",
    getEIP712TypesForIntent(
      isERC721Intent(intent) ? Protocol.ERC721 : Protocol.ERC20
    ),
    intent
  );

export const getEIP712Domain = (chainId: number, protocol: Protocol) => ({
  name: protocol === Protocol.ERC20 ? "MemswapERC20" : "MemswapERC721",
  version: "1.0",
  chainId,
  verifyingContract:
    protocol === Protocol.ERC20
      ? MEMSWAP_ERC20[chainId]
      : MEMSWAP_ERC721[chainId],
});

export const getEIP712TypesForAuthorization = () => ({
  Authorization: [
    {
      name: "intentHash",
      type: "bytes32",
    },
    {
      name: "solver",
      type: "address",
    },
    {
      name: "fillAmountToCheck",
      type: "uint128",
    },
    {
      name: "executeAmountToCheck",
      type: "uint128",
    },
    {
      name: "blockDeadline",
      type: "uint32",
    },
  ],
});

export const getEIP712TypesForIntent = (protocol: Protocol) => ({
  Intent: [
    {
      name: "isBuy",
      type: "bool",
    },
    {
      name: "buyToken",
      type: "address",
    },
    {
      name: "sellToken",
      type: "address",
    },
    {
      name: "maker",
      type: "address",
    },
    {
      name: "solver",
      type: "address",
    },
    {
      name: "source",
      type: "address",
    },
    {
      name: "feeBps",
      type: "uint16",
    },
    {
      name: "surplusBps",
      type: "uint16",
    },
    {
      name: "startTime",
      type: "uint32",
    },
    {
      name: "endTime",
      type: "uint32",
    },
    {
      name: "nonce",
      type: "uint256",
    },
    {
      name: "isPartiallyFillable",
      type: "bool",
    },
    {
      name: "isSmartOrder",
      type: "bool",
    },
    ...(protocol === Protocol.ERC721
      ? [
          {
            name: "isCriteriaOrder",
            type: "bool",
          },
          {
            name: "tokenIdOrCriteria",
            type: "uint256",
          },
        ]
      : []),
    {
      name: "amount",
      type: "uint128",
    },
    {
      name: "endAmount",
      type: "uint128",
    },
    {
      name: "startAmountBps",
      type: "uint16",
    },
    {
      name: "expectedAmountBps",
      type: "uint16",
    },
  ],
});
