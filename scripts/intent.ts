import { Interface, defaultAbiCoder } from "@ethersproject/abi";
import { AddressZero } from "@ethersproject/constants";
import { JsonRpcProvider } from "@ethersproject/providers";
import { parseEther, parseUnits } from "@ethersproject/units";
import { Wallet } from "@ethersproject/wallet";

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

const CURRENCIES = {
  ETH: MEMSWAP_WETH,
  WETH: REGULAR_WETH,
  USDC: "0x07865c6e87b9f70255377e024ace6630c1eaa37f",
};

const main = async () => {
  const provider = new JsonRpcProvider(process.env.JSON_URL!);
  const maker = new Wallet(process.env.MAKER_PK!);

  const tokenIn = CURRENCIES.ETH;
  const tokenOut = CURRENCIES.USDC;

  const amountIn = parseEther("0.001");
  const amountOut = parseUnits("10000", 6);

  const chainId = await provider.getNetwork().then((n) => n.chainId);

  // Create intent
  const intent = {
    tokenIn,
    tokenOut,
    maker: maker.address,
    matchmaker: MATCHMAKER,
    source: AddressZero,
    feeBps: 0,
    surplusBps: 0,
    deadline: await provider
      .getBlock("latest")
      .then((b) => b!.timestamp + 3600 * 24),
    isPartiallyFillable: false,
    amountIn,
    endAmountOut: amountOut,
    startAmountBps: 0,
    expectedAmountBps: 0,
  };
  (intent as any).signature = await maker._signTypedData(
    getEIP712Domain(chainId),
    getEIP712TypesForIntent(),
    intent
  );

  // Generate approval transaction
  const approveMethod =
    tokenIn === MEMSWAP_WETH ? "depositAndApprove" : "approve";
  const data =
    new Interface([
      `function ${approveMethod}(address spender, uint256 amount)`,
    ]).encodeFunctionData(approveMethod, [MEMSWAP, amountIn]) +
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
  const maxPriorityFeePerGas = parseUnits("1", "gwei");
  const tx = await maker.connect(provider).sendTransaction({
    to: tokenIn,
    data,
    value: approveMethod === "depositAndApprove" ? amountIn : 0,
    maxFeePerGas: currentBaseFee.add(maxPriorityFeePerGas),
    maxPriorityFeePerGas: maxPriorityFeePerGas,
  });

  console.log(`Approval transaction relayed: ${tx.hash}`);
};

main();
