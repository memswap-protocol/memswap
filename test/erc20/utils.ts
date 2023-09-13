import { defaultAbiCoder } from "@ethersproject/abi";
import { TypedDataSigner } from "@ethersproject/abstract-signer";
import { BigNumberish } from "@ethersproject/bignumber";
import { hexConcat } from "@ethersproject/bytes";
import { AddressZero } from "@ethersproject/constants";
import { _TypedDataEncoder } from "@ethersproject/hash";
import { keccak256 } from "@ethersproject/keccak256";
import { SignerWithAddress } from "@nomiclabs/hardhat-ethers/signers";
import { MerkleTree } from "merkletreejs";

// Contract utilities

export type Intent = {
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
  nonce: BigNumberish;
  isPartiallyFillable: boolean;
  isSmartOrder: boolean;
  amount: BigNumberish;
  endAmount: BigNumberish;
  startAmountBps: number;
  expectedAmountBps: number;
  signature?: string;
};

export type Authorization = {
  intentHash: string;
  solver: string;
  fillAmountToCheck: BigNumberish;
  executeAmountToCheck: BigNumberish;
  blockDeadline: number;
  signature?: string;
};

export const getIntentHash = (intent: any) =>
  _TypedDataEncoder.hashStruct("Intent", INTENT_EIP712_TYPES, intent);

export const signAuthorization = async (
  signer: SignerWithAddress,
  contract: string,
  authorization: any
) =>
  signer._signTypedData(
    EIP712_DOMAIN(contract, await signer.getChainId()),
    AUTHORIZATION_EIP712_TYPES,
    authorization
  );

export const signIntent = async (
  signer: SignerWithAddress,
  contract: string,
  intent: any
) =>
  signer._signTypedData(
    EIP712_DOMAIN(contract, await signer.getChainId()),
    INTENT_EIP712_TYPES,
    intent
  );

export const EIP712_DOMAIN = (contract: string, chainId: number) => ({
  name: "MemswapERC20",
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
};

export const INTENT_EIP712_TYPES = {
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
};

// Bulk-signing utilities

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

  const types = { ...INTENT_EIP712_TYPES };
  (types as any).BatchIntent = [
    { name: "tree", type: `Intent${`[2]`.repeat(height)}` },
  ];
  const encoder = _TypedDataEncoder.from(types);

  const hashElement = (element: any) => encoder.hashStruct("Intent", element);
  const elements = [...intents];
  const leaves = elements.map((i) => hashElement(i));

  const defaultElement: Intent = {
    isBuy: false,
    buyToken: AddressZero,
    sellToken: AddressZero,
    maker: AddressZero,
    solver: AddressZero,
    source: AddressZero,
    feeBps: 0,
    surplusBps: 0,
    startTime: 0,
    endTime: 0,
    nonce: 0,
    isPartiallyFillable: false,
    isSmartOrder: false,
    amount: 0,
    endAmount: 0,
    startAmountBps: 0,
    expectedAmountBps: 0,
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
