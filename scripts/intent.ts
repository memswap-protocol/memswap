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
  MEMETH,
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
    ETH_IN: MEMETH[chainId],
    ETH_OUT: AddressZero,
    WETH: WETH9[chainId],
    USDC: USDC[chainId],
  };

  const buyToken = CURRENCIES.USDC;
  const sellToken = CURRENCIES.ETH_IN;

  // Create intent
  const intent: IntentERC20 = {
    isBuy: false,
    buyToken,
    sellToken,
    maker: maker.address,
    solver: AddressZero,
    source: AddressZero,
    feeBps: 0,
    surplusBps: 0,
    startTime: now(),
    endTime: await provider
      .getBlock("latest")
      .then((b) => b!.timestamp + 3600 * 24),
    nonce: "0",
    isPartiallyFillable: false,
    isSmartOrder: false,
    amount: parseUnits("0.001", 18).toString(),
    expectedAmount: parseUnits("10000", 6).toString(),
    startAmountBps: 0,
    endAmountBps: 0,
    // Mock value to pass type checks
    signature: "0x",
  };
  intent.signature = await maker._signTypedData(
    getEIP712Domain(chainId, Protocol.ERC20),
    getEIP712TypesForIntent(Protocol.ERC20),
    intent
  );

  const memeth = new Contract(
    MEMETH[chainId],
    new Interface([
      "function balanceOf(address owner) view returns (uint256)",
      "function approve(address spender, uint256 amount)",
      "function depositAndApprove(address spender, uint256 amount)",
    ]),
    provider
  );

  const amountToApprove = !intent.isBuy ? intent.amount : intent.expectedAmount;

  // Generate approval transaction
  const approveMethod =
    sellToken === MEMETH[chainId] &&
    (await memeth.balanceOf(maker.address)).lt(amountToApprove)
      ? "depositAndApprove"
      : "approve";
  const data =
    memeth.interface.encodeFunctionData(approveMethod, [
      MEMSWAP_ERC20[chainId],
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
          "uint128",
          "uint128",
          "uint16",
          "uint16",
          "bytes",
        ],
        [
          intent.isBuy,
          intent.buyToken,
          intent.sellToken,
          intent.maker,
          intent.solver,
          intent.source,
          intent.feeBps,
          intent.surplusBps,
          intent.startTime,
          intent.endTime,
          intent.nonce,
          intent.isPartiallyFillable,
          intent.isSmartOrder,
          intent.amount,
          intent.expectedAmount,
          intent.startAmountBps,
          intent.endAmountBps,
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
