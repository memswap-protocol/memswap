import { BigNumber, BigNumberish } from "@ethersproject/bignumber";
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
  PERMIT2,
  USDC,
}

export const signPermit = async (
  signer: SignerWithAddress,
  contract: string,
  permit: any
) =>
  signer._signTypedData(
    EIP712_DOMAIN(contract, await signer.getChainId()),
    PERMIT2_EIP712_TYPES,
    permit
  );

export const EIP712_DOMAIN = (contract: string, chainId: number) => ({
  name: "Permit2",
  chainId,
  verifyingContract: contract,
});

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
