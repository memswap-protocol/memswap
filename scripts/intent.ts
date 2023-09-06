import { Interface, defaultAbiCoder } from "@ethersproject/abi";
import { AddressZero } from "@ethersproject/constants";
import { Contract } from "@ethersproject/contracts";
import { JsonRpcProvider } from "@ethersproject/providers";
import { parseUnits } from "@ethersproject/units";
import { Wallet } from "@ethersproject/wallet";
import axios from "axios";

import { MATCHMAKER, MEMSWAP, WETH2, WETH9 } from "../src/common/addresses";
import {
  getEIP712Domain,
  getEIP712TypesForIntent,
  now,
} from "../src/common/utils";
import { Side } from "../src/common/types";

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
    USDC:
      chainId === 1
        ? "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48"
        : "0x07865c6e87b9f70255377e024ace6630c1eaa37f",
  };

  const tokenIn = CURRENCIES.ETH_IN;
  const tokenOut = CURRENCIES.USDC;

  // Create intent
  const intent = {
    side: Side.BUY,
    tokenIn,
    tokenOut,
    maker: maker.address,
    matchmaker: MATCHMAKER[chainId],
    source: AddressZero,
    feeBps: 0,
    surplusBps: 0,
    startTime: now(),
    endTime: await provider
      .getBlock("latest")
      .then((b) => b!.timestamp + 3600 * 24),
    nonce: 0,
    isPartiallyFillable: false,
    amount: parseUnits("1000", 6).toString(),
    endAmount: parseUnits("0.01", 18).toString(),
    startAmountBps: 5000,
    expectedAmountBps: 3000,
    hasDynamicSignature: false,
  };
  (intent as any).signature = await maker._signTypedData(
    getEIP712Domain(chainId),
    getEIP712TypesForIntent(),
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

  const amountToApprove =
    intent.side === Side.SELL ? intent.amount : intent.endAmount;

  // Generate approval transaction
  const approveMethod =
    tokenIn === WETH2[chainId] &&
    (await memswapWeth.balanceOf(maker.address)).lt(amountToApprove)
      ? "depositAndApprove"
      : "approve";
  const data =
    memswapWeth.interface.encodeFunctionData(approveMethod, [
      MEMSWAP[chainId],
      amountToApprove,
    ]) +
    defaultAbiCoder
      .encode(
        [
          "uint8",
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
          "uint128",
          "uint128",
          "uint16",
          "uint16",
          "bool",
          "bytes",
        ],
        [
          intent.side,
          intent.tokenIn,
          intent.tokenOut,
          intent.maker,
          intent.matchmaker,
          intent.source,
          intent.feeBps,
          intent.surplusBps,
          intent.startTime,
          intent.endTime,
          intent.nonce,
          intent.isPartiallyFillable,
          intent.amount,
          intent.endAmount,
          intent.startAmountBps,
          intent.expectedAmountBps,
          intent.hasDynamicSignature,
          (intent as any).signature,
        ]
      )
      .slice(2);

  const currentBaseFee = await provider
    .getBlock("pending")
    .then((b) => b!.baseFeePerGas!);
  const nextBaseFee = currentBaseFee.add(currentBaseFee.mul(3000).div(10000));
  const maxPriorityFeePerGas = parseUnits("0.02", "gwei");

  // const tx = await maker.connect(provider).sendTransaction({
  //   to: tokenIn,
  //   data,
  //   value: approveMethod === "depositAndApprove" ? amountToApprove : 0,
  //   maxFeePerGas: nextBaseFee.add(maxPriorityFeePerGas),
  //   maxPriorityFeePerGas: maxPriorityFeePerGas,
  // });

  // console.log(`Approval transaction relayed: ${tx.hash}`);

  const tx = await maker.connect(provider).signTransaction({
    from: maker.address,
    to: tokenIn,
    data,
    value: approveMethod === "depositAndApprove" ? amountToApprove : 0,
    maxFeePerGas: nextBaseFee.add(maxPriorityFeePerGas),
    maxPriorityFeePerGas: maxPriorityFeePerGas,
    type: 2,
    nonce: await provider.getTransactionCount(maker.address),
    gasLimit: 100000,
    chainId,
  });

  await axios.post(`${process.env.MATCHMAKER_BASE_URL}/intents/private`, {
    intent,
    approvalTxOrTxHash: tx,
  });
};

main();
