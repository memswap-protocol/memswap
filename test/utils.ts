import { Interface } from "@ethersproject/abi";
import { BigNumber, BigNumberish } from "@ethersproject/bignumber";
import { Contract } from "@ethersproject/contracts";
import { SignerWithAddress } from "@nomiclabs/hardhat-ethers/signers";
import { ethers } from "hardhat";

// Misc utilities

export const bn = (value: BigNumberish) => BigNumber.from(value);

export const getCurrentTimestamp = async () =>
  ethers.provider.getBlock("latest").then((b) => b!.timestamp);

export const getRandomBoolean = () => Math.random() < 0.5;

export const getRandomInteger = (min: number, max: number) => {
  min = Math.ceil(min);
  max = Math.floor(max);
  return Math.floor(Math.random() * (max - min + 1)) + min;
};

export const getRandomFloat = (min: number, max: number) =>
  (Math.random() * (max - min) + min).toFixed(6);

// Contract utilities

export enum PermitKind {
  EIP2612,
  PERMIT2,
}

export const signPermit2 = async (
  signer: SignerWithAddress,
  contract: string,
  permit: any
) =>
  signer._signTypedData(
    EIP712_DOMAIN_FOR_PERMIT2(contract, await signer.getChainId()),
    PERMIT2_EIP712_TYPES,
    permit
  );

export const signPermitEIP2612 = async (
  signer: SignerWithAddress,
  contract: string,
  permit: any
) =>
  signer._signTypedData(
    await EIP712_DOMAIN_FOR_EIP2612(contract, await signer.getChainId()),
    EIP2612_EIP712_TYPES,
    permit
  );

export const EIP712_DOMAIN_FOR_PERMIT2 = (
  contract: string,
  chainId: number
) => ({
  name: "Permit2",
  chainId,
  verifyingContract: contract,
});

export const EIP712_DOMAIN_FOR_EIP2612 = async (
  contract: string,
  chainId: number
) => {
  const c = new Contract(
    contract,
    new Interface([
      "function name() view returns (string)",
      "function version() view returns (string)",
    ]),
    ethers.provider
  );
  return {
    name: await c.name(),
    version: await c.version(),
    chainId,
    verifyingContract: contract,
  };
};

export const PERMIT2_EIP712_TYPES = {
  PermitSingle: [
    {
      name: "details",
      type: "PermitDetails",
    },
    {
      name: "spender",
      type: "address",
    },
    {
      name: "sigDeadline",
      type: "uint256",
    },
  ],
  PermitDetails: [
    {
      name: "token",
      type: "address",
    },
    {
      name: "amount",
      type: "uint160",
    },
    {
      name: "expiration",
      type: "uint48",
    },
    {
      name: "nonce",
      type: "uint48",
    },
  ],
};

export const EIP2612_EIP712_TYPES = {
  Permit: [
    {
      name: "owner",
      type: "address",
    },
    {
      name: "spender",
      type: "address",
    },
    {
      name: "value",
      type: "uint256",
    },
    {
      name: "nonce",
      type: "uint256",
    },
    {
      name: "deadline",
      type: "uint256",
    },
  ],
};

export const getIncentivizationTip = async (
  memswap: Contract,
  isBuy: boolean,
  expectedAmount: BigNumberish,
  expectedAmountBps: number,
  executeAmount: BigNumberish
): Promise<BigNumber> => {
  const slippage =
    expectedAmountBps === 0
      ? await memswap.defaultSlippage()
      : expectedAmountBps;

  const multiplier = await memswap.multiplier();
  const minTip = await memswap.minTip();
  const maxTip = await memswap.maxTip();

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
