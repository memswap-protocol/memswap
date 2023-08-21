import { BigNumber, BigNumberish } from "@ethersproject/bignumber";
import { ethers } from "hardhat";

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
