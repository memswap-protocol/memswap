import { Interface, defaultAbiCoder } from "@ethersproject/abi";
import { AddressZero } from "@ethersproject/constants";
import { Contract } from "@ethersproject/contracts";
import { JsonRpcProvider } from "@ethersproject/providers";
import { parseUnits } from "@ethersproject/units";
import { Wallet } from "@ethersproject/wallet";
import axios from "axios";

import {
  MATCHMAKER,
  MEMSWAP_ERC20,
  MEMSWAP_ERC721,
  USDC,
  WETH2,
  WETH9,
} from "../src/common/addresses";
import {
  getEIP712Domain,
  getEIP712TypesForIntent,
  now,
} from "../src/common/utils";
import { IntentERC20, IntentERC721, Protocol } from "../src/common/types";

// Required env variables:
// - JSON_URL: url for the http provider
// - MAKER_PK: private key of the maker

const main = async () => {
  const provider = new JsonRpcProvider(process.env.JSON_URL!);
  const maker = new Wallet(process.env.MAKER_PK!);

  const chainId = await provider.getNetwork().then((n) => n.chainId);
  const CURRENCIES = {
    ETH_IN: WETH2[chainId],
    ETH_OUT: AddressZero,
    WETH: WETH9[chainId],
    USDC: USDC[chainId],
  };

  const buyToken = "0x77566d540d1e207dff8da205ed78750f9a1e7c55";
  const sellToken = CURRENCIES.ETH_IN;

  // Create intent
  const intent: IntentERC721 = {
    isBuy: true,
    buyToken,
    sellToken,
    maker: maker.address,
    matchmaker: AddressZero,
    source: AddressZero,
    feeBps: 0,
    surplusBps: 0,
    startTime: now(),
    endTime: await provider
      .getBlock("latest")
      .then((b) => b!.timestamp + 3600 * 24),
    nonce: "0",
    isPartiallyFillable: false,
    hasCriteria: true,
    tokenIdOrCriteria: "0",
    amount: "1",
    endAmount: parseUnits("0.015", 18).toString(),
    startAmountBps: 1000,
    expectedAmountBps: 500,
    hasDynamicSignature: false,
    // Mock value to pass type checks
    signature: "0x",
  };
  intent.signature = await maker._signTypedData(
    getEIP712Domain(chainId, Protocol.ERC721),
    getEIP712TypesForIntent(Protocol.ERC721),
    intent
  );

  const memswapWeth = new Contract(
    WETH2[chainId],
    new Interface([
      "function balanceOf(address owner) view returns (uint256)",
      "function approve(address spender, uint256 amount)",
      "function depositAndApprove(address spender, uint256 amount)",
    ]),
    provider
  );

  const amountToApprove = !intent.isBuy ? intent.amount : intent.endAmount;

  // Generate approval transaction
  const approveMethod =
    sellToken === WETH2[chainId] &&
    (await memswapWeth.balanceOf(maker.address)).lt(amountToApprove)
      ? "depositAndApprove"
      : "approve";
  const data =
    memswapWeth.interface.encodeFunctionData(approveMethod, [
      MEMSWAP_ERC721[chainId],
      amountToApprove,
    ]) +
    defaultAbiCoder
      .encode(
        [
          "bool",
          "address",
          "address",
          "address",
          "address",
          "address",
          "uint16",
          "uint16",
          "uint32",
          "uint32",
          "uint256",
          "bool",
          "bool",
          "uint256",
          "uint128",
          "uint128",
          "uint16",
          "uint16",
          "bool",
          "bytes",
        ],
        [
          intent.isBuy,
          intent.buyToken,
          intent.sellToken,
          intent.maker,
          intent.matchmaker,
          intent.source,
          intent.feeBps,
          intent.surplusBps,
          intent.startTime,
          intent.endTime,
          intent.nonce,
          intent.isPartiallyFillable,
          intent.hasCriteria,
          intent.tokenIdOrCriteria,
          intent.amount,
          intent.endAmount,
          intent.startAmountBps,
          intent.expectedAmountBps,
          intent.hasDynamicSignature,
          intent.signature,
        ]
      )
      .slice(2);

  const currentBaseFee = await provider
    .getBlock("pending")
    .then((b) => b!.baseFeePerGas!);
  const nextBaseFee = currentBaseFee.add(currentBaseFee.mul(3000).div(10000));
  const maxPriorityFeePerGas = parseUnits("0.02", "gwei");

  const tx = await maker.connect(provider).sendTransaction({
    to: sellToken,
    data,
    value: approveMethod === "depositAndApprove" ? amountToApprove : 0,
    maxFeePerGas: nextBaseFee.add(maxPriorityFeePerGas),
    maxPriorityFeePerGas: maxPriorityFeePerGas,
  });

  console.log(`Approval transaction relayed: ${tx.hash}`);

  // const tx = await maker.connect(provider).signTransaction({
  //   from: maker.address,
  //   to: sellToken,
  //   data,
  //   value: approveMethod === "depositAndApprove" ? amountToApprove : 0,
  //   maxFeePerGas: nextBaseFee.add(maxPriorityFeePerGas),
  //   maxPriorityFeePerGas: maxPriorityFeePerGas,
  //   type: 2,
  //   nonce: await provider.getTransactionCount(maker.address),
  //   gasLimit: 100000,
  //   chainId,
  // });

  // await axios.post(`${process.env.MATCHMAKER_BASE_URL}/intents/private`, {
  //   intent,
  //   approvalTxOrTxHash: tx,
  // });
};

main();
