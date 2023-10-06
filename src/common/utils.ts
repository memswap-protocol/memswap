import { Interface } from "@ethersproject/abi";
import { Provider } from "@ethersproject/abstract-provider";
import { BigNumber, BigNumberish } from "@ethersproject/bignumber";
import { AddressZero } from "@ethersproject/constants";
import { Contract } from "@ethersproject/contracts";
import { _TypedDataEncoder } from "@ethersproject/hash";
import { parseUnits } from "@ethersproject/units";
import {
  WETH9 as UniswapWETH9,
  Currency,
  Ether,
  Token,
} from "@uniswap/sdk-core";

import { MEMETH, MEMSWAP_ERC20, MEMSWAP_ERC721, WETH9 } from "./addresses";
import { config } from "./config";
import { Authorization, IntentERC20, IntentERC721, Protocol } from "./types";

export const AVERAGE_BLOCK_TIME = 12;
export const PESSIMISTIC_BLOCK_TIME = 15;

export const MATCHMAKER_AUTHORIZATION_GAS = 100000;
export const APPROVAL_FOR_ALL_GAS = 100000;

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
    {
      name: "isIncentivized",
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

export const getIncentivizationTip = (
  isBuy: boolean,
  expectedAmount: BigNumberish,
  expectedAmountBps: number,
  executeAmount: BigNumberish
): BigNumber => {
  const defaultSlippage = 50;
  const multiplier = 4;
  const minTip = parseUnits("0.05", "gwei").mul(500000);
  const maxTip = parseUnits("1.5", "gwei").mul(500000);

  const slippage =
    expectedAmountBps === 0 ? defaultSlippage : expectedAmountBps;

  const slippageUnit = bn(expectedAmount).mul(slippage).div(10000);

  if (isBuy) {
    const minValue = bn(expectedAmount).sub(slippageUnit.mul(multiplier));
    const maxValue = bn(expectedAmount).add(slippageUnit);

    if (bn(executeAmount).gte(maxValue)) {
      return minTip;
    } else if (bn(executeAmount).lte(minValue)) {
      return maxTip;
    } else {
      return maxTip.sub(
        bn(executeAmount)
          .sub(minValue)
          .mul(maxTip.sub(minTip))
          .div(maxValue.sub(minValue))
      );
    }
  } else {
    const minValue = bn(expectedAmount).sub(slippageUnit);
    const maxValue = bn(expectedAmount).add(slippageUnit.mul(multiplier));

    if (bn(executeAmount).gte(maxValue)) {
      return minTip;
    } else if (bn(executeAmount).lte(minValue)) {
      return maxTip;
    } else {
      return minTip.add(
        bn(executeAmount)
          .sub(minValue)
          .mul(maxTip.sub(minTip))
          .div(maxValue.sub(minValue))
      );
    }
  }
};

export const getToken = async (
  address: string,
  provider: Provider
): Promise<Currency> => {
  const contract = new Contract(
    address,
    new Interface(["function decimals() view returns (uint8)"]),
    provider
  );

  // The core Uniswap SDK misses the WETH9 address for some chains (eg. Sepolia)
  if (!UniswapWETH9[config.chainId]) {
    UniswapWETH9[config.chainId] = new Token(
      config.chainId,
      WETH9[config.chainId],
      await contract.decimals(),
      "WETH",
      "Wrapped Ether"
    );
  }

  return [MEMETH[config.chainId], AddressZero].includes(address)
    ? Ether.onChain(config.chainId)
    : new Token(config.chainId, address, await contract.decimals());
};
