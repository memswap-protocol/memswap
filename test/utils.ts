import { defaultAbiCoder } from "@ethersproject/abi";
import { TypedDataSigner } from "@ethersproject/abstract-signer";
import { BigNumber, BigNumberish } from "@ethersproject/bignumber";
import { hexConcat } from "@ethersproject/bytes";
import { AddressZero } from "@ethersproject/constants";
import { _TypedDataEncoder } from "@ethersproject/hash";
import { keccak256 } from "@ethersproject/keccak256";
import { ethers } from "hardhat";
import { MerkleTree } from "merkletreejs";

// Misc

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

// Bulk-signing

export const bulkSign = async (
  signer: TypedDataSigner,
  intents: any[],
  contract: string,
  chainId: number
) => {
  const { signatureData, proofs } = getBulkSignatureDataWithProofs(
    intents,
    contract,
    chainId
  );

  const signature = await signer._signTypedData(
    signatureData.domain,
    signatureData.types,
    signatureData.value
  );

  intents.forEach((intent, i) => {
    intent.signature = encodeBulkOrderProofAndSignature(
      i,
      proofs[i],
      signature
    );
  });
};

const getBulkSignatureDataWithProofs = (
  intents: any[],
  contract: string,
  chainId: number
) => {
  const height = Math.max(Math.ceil(Math.log2(intents.length)), 1);
  const size = Math.pow(2, height);

  const types = { ...INTENT_EIP712_HASH };
  (types as any).BatchIntent = [
    { name: "tree", type: `Intent${`[2]`.repeat(height)}` },
  ];
  const encoder = _TypedDataEncoder.from(types);

  const hashElement = (element: any) => encoder.hashStruct("Intent", element);
  const elements = [...intents];
  const leaves = elements.map((i) => hashElement(i));

  const defaultElement = {
    tokenIn: AddressZero,
    tokenOut: AddressZero,
    maker: AddressZero,
    filler: AddressZero,
    referrer: AddressZero,
    referrerFeeBps: 0,
    referrerSurplusBps: 0,
    deadline: 0,
    isPartiallyFillable: false,
    amountIn: 0,
    startAmountOut: 0,
    expectedAmountOut: 0,
    endAmountOut: 0,
  };
  const defaultLeaf = hashElement(defaultElement);

  // Ensure the tree is complete
  while (elements.length < size) {
    elements.push(defaultElement);
    leaves.push(defaultLeaf);
  }

  const hexToBuffer = (value: string) => Buffer.from(value.slice(2), "hex");
  const bufferKeccak = (value: string) => hexToBuffer(keccak256(value));

  const tree = new MerkleTree(leaves.map(hexToBuffer), bufferKeccak, {
    complete: true,
    sort: false,
    hashLeaves: false,
    fillDefaultHash: hexToBuffer(defaultLeaf),
  });

  let chunks: object[] = [...elements];
  while (chunks.length > 2) {
    const newSize = Math.ceil(chunks.length / 2);
    chunks = Array(newSize)
      .fill(0)
      .map((_, i) => chunks.slice(i * 2, (i + 1) * 2));
  }

  return {
    signatureData: {
      signatureKind: "eip712",
      domain: EIP712_DOMAIN(contract, chainId),
      types,
      value: { tree: chunks },
      primaryType: _TypedDataEncoder.getPrimaryType(types),
    },
    proofs: intents.map((_, i) => tree.getHexProof(leaves[i], i)),
  };
};

const encodeBulkOrderProofAndSignature = (
  orderIndex: number,
  merkleProof: string[],
  signature: string
) => {
  return hexConcat([
    signature,
    `0x${orderIndex.toString(16).padStart(6, "0")}`,
    defaultAbiCoder.encode([`uint256[${merkleProof.length}]`], [merkleProof]),
  ]);
};

export const EIP712_DOMAIN = (contract: string, chainId: number) => ({
  name: "Memswap",
  version: "1.0",
  chainId,
  verifyingContract: contract,
});

export const AUTHORIZATION_EIP712_TYPES = {
  Authorization: [
    {
      name: "intentHash",
      type: "bytes32",
    },
    {
      name: "authorizedFiller",
      type: "address",
    },
    {
      name: "maximumAmount",
      type: "uint128",
    },
    {
      name: "blockDeadline",
      type: "uint32",
    },
    {
      name: "isPartiallyFillable",
      type: "bool",
    },
  ],
};

export const INTENT_EIP712_HASH = {
  Intent: [
    {
      name: "tokenIn",
      type: "address",
    },
    {
      name: "tokenOut",
      type: "address",
    },
    {
      name: "maker",
      type: "address",
    },
    {
      name: "filler",
      type: "address",
    },
    {
      name: "referrer",
      type: "address",
    },
    {
      name: "referrerFeeBps",
      type: "uint32",
    },
    {
      name: "referrerSurplusBps",
      type: "uint32",
    },
    {
      name: "deadline",
      type: "uint32",
    },
    {
      name: "isPartiallyFillable",
      type: "bool",
    },
    {
      name: "amountIn",
      type: "uint128",
    },
    {
      name: "startAmountOut",
      type: "uint128",
    },
    {
      name: "expectedAmountOut",
      type: "uint128",
    },
    {
      name: "endAmountOut",
      type: "uint128",
    },
  ],
};
