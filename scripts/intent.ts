import { Interface, defaultAbiCoder } from "@ethersproject/abi";
import { AddressZero } from "@ethersproject/constants";
import { Contract } from "@ethersproject/contracts";
import { JsonRpcProvider } from "@ethersproject/providers";
import { parseUnits } from "@ethersproject/units";
import { Wallet } from "@ethersproject/wallet";
import axios from "axios";

import {
  MATCHMAKER,
  MEMSWAP,
  MEMSWAP_WETH,
  REGULAR_WETH,
} from "../src/common/addresses";
import { getEIP712Domain, getEIP712TypesForIntent } from "../src/common/utils";

// Required env variables:
// - JSON_URL: url for the http provider
// - MAKER_PK: private key of the maker

const main = async () => {
  const provider = new JsonRpcProvider(process.env.JSON_URL!);
  const maker = new Wallet(process.env.MAKER_PK!);

  const chainId = await provider.getNetwork().then((n) => n.chainId);
  const CURRENCIES = {
    ETH_IN: MEMSWAP_WETH[chainId],
    ETH_OUT: AddressZero,
    WETH: REGULAR_WETH[chainId],
    USDC:
      chainId === 1
        ? "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48"
        : "0x07865c6e87b9f70255377e024ace6630c1eaa37f",
  };

  const tokenIn = CURRENCIES.USDC;
  const tokenOut = CURRENCIES.ETH_OUT;

  const amountIn = parseUnits("16", 6);
  const amountOut = parseUnits("0.004", 18);
  // Create intent
  const intent = {
    tokenIn,
    tokenOut,
    maker: maker.address,
    matchmaker: MATCHMAKER[chainId],
    source: AddressZero,
    feeBps: 0,
    surplusBps: 0,
    deadline: await provider
      .getBlock("latest")
      .then((b) => b!.timestamp + 3600 * 24),
    isPartiallyFillable: false,
    amountIn: amountIn.toString(),
    endAmountOut: amountOut.toString(),
    startAmountBps: 0,
    expectedAmountBps: 0,
  };
  (intent as any).signature = await maker._signTypedData(
    getEIP712Domain(chainId),
    getEIP712TypesForIntent(),
    intent
  );

  const memswapWeth = new Contract(
    MEMSWAP_WETH[chainId],
    new Interface([
      "function balanceOf(address owner) view returns (uint256)",
      "function approve(address spender, uint256 amount)",
      "function depositAndApprove(address spender, uint256 amount)",
    ]),
    provider
  );

  // Generate approval transaction
  const approveMethod =
    tokenIn === MEMSWAP_WETH[chainId] &&
    (await memswapWeth.balanceOf(maker.address)).lt(amountIn)
      ? "depositAndApprove"
      : "approve";
  const data =
    memswapWeth.interface.encodeFunctionData(approveMethod, [
      MEMSWAP[chainId],
      amountIn,
    ]) +
    defaultAbiCoder
      .encode(
        [
          "address",
          "address",
          "address",
          "address",
          "address",
          "uint16",
          "uint16",
          "uint32",
          "bool",
          "uint128",
          "uint128",
          "uint16",
          "uint16",
          "bytes",
        ],
        [
          intent.tokenIn,
          intent.tokenOut,
          intent.maker,
          intent.matchmaker,
          intent.source,
          intent.feeBps,
          intent.surplusBps,
          intent.deadline,
          intent.isPartiallyFillable,
          intent.amountIn,
          intent.endAmountOut,
          intent.startAmountBps,
          intent.expectedAmountBps,
          (intent as any).signature,
        ]
      )
      .slice(2);

  const currentBaseFee = await provider
    .getBlock("pending")
    .then((b) => b!.baseFeePerGas!);
  const nextBaseFee = currentBaseFee.add(currentBaseFee.mul(2500).div(10000));
  const maxPriorityFeePerGas = parseUnits("0.02", "gwei");

  // const tx = await maker.connect(provider).sendTransaction({
  //   to: tokenIn,
  //   data,
  //   value: approveMethod === "depositAndApprove" ? amountIn : 0,
  //   maxFeePerGas: nextBaseFee.add(maxPriorityFeePerGas),
  //   maxPriorityFeePerGas: maxPriorityFeePerGas,
  // });

  // console.log(`Approval transaction relayed: ${tx.hash}`);

  const tx = await maker.connect(provider).signTransaction({
    from: maker.address,
    to: tokenIn,
    data,
    value: approveMethod === "depositAndApprove" ? amountIn : 0,
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
