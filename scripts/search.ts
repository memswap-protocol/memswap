import { Interface, defaultAbiCoder } from "@ethersproject/abi";
import { BigNumber, BigNumberish } from "@ethersproject/bignumber";
import { TransactionResponse } from "@ethersproject/abstract-provider";
import { JsonRpcProvider, WebSocketProvider } from "@ethersproject/providers";
import { serialize } from "@ethersproject/transactions";
import { parseUnits } from "@ethersproject/units";
import { Wallet } from "@ethersproject/wallet";
import {
  FlashbotsBundleProvider,
  FlashbotsBundleResolution,
} from "@flashbots/ethers-provider-bundle";
import axios from "axios";

// Required env variables:
// - WS_URL: url for the websocket provider
// - JSON_URL: url for the http provider
// - FILLER_PK: private key of the filler

type Intent = {
  maker: string;
  filler: string;
  tokenIn: string;
  tokenOut: string;
  referrer: string;
  referrerFeeBps: number;
  referrerSlippageBps: number;
  deadline: number;
  amountIn: string;
  startAmountOut: string;
  endAmountOut: string;
  signature: string;
};

const bn = (value: BigNumberish) => BigNumber.from(value);

const MEMSWAP = "";
const ETH_ESCROW = "";

// Listen to pending mempool transactions
const wsProvider = new WebSocketProvider(process.env.WS_URL!);
wsProvider.on("pending", (tx) =>
  wsProvider.getTransaction(tx).then(async (tx) => {
    if (!tx || !tx.data || !tx.from) {
      return;
    }

    // Try to decode any intent appended at the end of the calldata

    let restOfCalldata: string | undefined;
    if (tx.data.startsWith("0x095ea7b3")) {
      const iface = new Interface([
        "function approve(address spender, uint256 amount)",
      ]);
      const spender = iface
        .decodeFunctionData("approve", tx.data)
        .spender.toLowerCase();
      if (spender === MEMSWAP) {
        restOfCalldata = "0x" + tx.data.slice(2 + 4 * 2 + 32 * 2 + 32 * 2);
      }
    } else if (
      tx.data.startsWith("0xd0e30db0") &&
      tx.to?.toLowerCase() === ETH_ESCROW
    ) {
      restOfCalldata = "0x" + tx.data.slice(2 + 4 * 2);
    }

    let intent: Intent | undefined;
    if (restOfCalldata && restOfCalldata.length > 2) {
      try {
        const result = defaultAbiCoder.decode(
          [
            "address",
            "address",
            "address",
            "address",
            "address",
            "uint32",
            "uint32",
            "uint32",
            "uint128",
            "uint128",
            "uint128",
            "bytes",
          ],
          restOfCalldata
        );

        intent = {
          maker: result[0].toLowerCase(),
          filler: result[1].toLowerCase(),
          tokenIn: result[2].toLowerCase(),
          tokenOut: result[3].toLowerCase(),
          referrer: result[4].toLowerCase(),
          referrerFeeBps: result[5].toNumber(),
          referrerSlippageBps: result[6].toNumber(),
          deadline: result[7].toNumber(),
          amountIn: result[8].toString(),
          startAmountOut: result[9].toString(),
          endAmountOut: result[10].toString(),
          signature: result[11].toLowerCase(),
        };
      } catch {
        // Skip errors
      }
    }

    if (intent) {
      await fill(tx, intent);
    }
  })
);

// Fill intent
const fill = async (tx: TransactionResponse, intent: Intent) => {
  const provider = new JsonRpcProvider(process.env.JSON_URL!);
  const filler = new Wallet(process.env.FILLER_PK!);

  const flashbotsProvider = await FlashbotsBundleProvider.create(
    provider,
    new Wallet(
      "0x2000000000000000000000000000000000000000000000000000000000000000"
    ),
    "https://relay-goerli.flashbots.net"
  );

  const { data: swapData } = await axios.get(
    "https://goerli.api.0x.org/swap/v1/quote",
    {
      params: {
        buyToken: intent.tokenOut,
        sellToken: intent.tokenIn,
        sellAmount: intent.amountIn,
      },
      headers: {
        "0x-Api-Key": "e519f152-3749-49ea-a8f3-2964bb0f90ac",
      },
    }
  );

  const currentBaseFee = await provider
    .getBlock("pending")
    .then((b) => b!.baseFeePerGas!);
  // TODO: Compute dynamically
  const maxPriorityFeePerGas = parseUnits("10", "gwei");

  const signedBundle = await flashbotsProvider.signBundle([
    {
      signedTransaction: serialize(
        {
          to: tx.to,
          nonce: tx.nonce,
          gasLimit: tx.gasLimit,
          data: tx.data,
          value: tx.value,
          chainId: tx.chainId,
          type: tx.type,
          accessList: tx.accessList,
          maxPriorityFeePerGas: tx.maxPriorityFeePerGas,
          maxFeePerGas: tx.maxFeePerGas,
        },
        {
          v: tx.v!,
          r: tx.r!,
          s: tx.s!,
        }
      ),
    },
    {
      signer: filler,
      transaction: {
        from: filler.address,
        to: MEMSWAP,
        data: new Interface([
          `
            function execute(
              (
                address maker,
                address filler,
                address tokenIn,
                address tokenOut,
                address referrer,
                uint32 referredFeeBps,
                uint32 referrerSlippageBps,
                uint32 deadline,
                uint128 amountIn,
                uint128 startAmountOut,
                uint128 endAmountOut,
                bytes signature
              ) intent,
              address fillContract,
              bytes fillData
            )
          `,
        ]).encodeFunctionData("execute", [intent, swapData.to, swapData.data]),
        type: 2,
        // TODO: Estimate dynamically
        gasLimit: 1000000,
        chainId: await provider.getNetwork().then((n) => n.chainId),
        maxFeePerGas: currentBaseFee.add(maxPriorityFeePerGas).toString(),
        maxPriorityFeePerGas: maxPriorityFeePerGas.toString(),
      },
    },
  ]);

  const latestBlock = await provider.getBlock("latest");
  for (let i = 1; i <= 10; i++) {
    const blockNumber = latestBlock.number + i;
    const blockTimestamp = latestBlock.timestamp + i * 14;

    const minimumAmountOut = bn(intent.startAmountOut).sub(
      bn(intent.startAmountOut)
        .sub(intent.endAmountOut)
        .div(intent.deadline - blockTimestamp)
    );
    const actualAmountOut = swapData.amountOut;
    const fillerProfitInETH = bn(actualAmountOut)
      .sub(minimumAmountOut)
      .mul(swapData.buyTokenToEthRate);
    // const fillerProfit;

    console.log(`Trying to send bundle for block ${blockNumber}`);

    const receipt = await flashbotsProvider.sendRawBundle(
      signedBundle,
      blockNumber
    );
    const hash = (receipt as any).bundleHash;

    console.log(`Bundle ${hash} submitted in block ${blockNumber}, waiting...`);

    const waitResponse = await (receipt as any).wait();
    if (
      waitResponse === FlashbotsBundleResolution.BundleIncluded ||
      waitResponse === FlashbotsBundleResolution.AccountNonceTooHigh
    ) {
      console.log(`Bundle ${hash} included in block ${blockNumber}`);
    } else {
      console.log(
        `Bundle ${hash} not included in block ${blockNumber} (${waitResponse})`
      );
    }
  }
};

const main = async () => {
  // const tokenIn = "0xb4fbf271143f4fbf7b91a5ded31805e42b2208d6";
  // const tokenOut = "0x07865c6e87b9f70255377e024ace6630c1eaa37f";
  // const amountIn = ethers.utils.parseEther("0.001");
  // const amountOut = ethers.utils.parseUnits("0.1", 6);
  // // Create intent
  // const intent = {
  //   maker: maker.address,
  //   tokenIn,
  //   tokenOut,
  //   amountIn,
  //   startAmountOut: amountOut,
  //   endAmountOut: amountOut,
  //   deadline: await ethers.provider
  //     .getBlock("latest")
  //     .then((b) => b!.timestamp + 3600 * 24),
  // };
  // (intent as any).signature = await maker._signTypedData(
  //   {
  //     name: "Memswap",
  //     version: "1.0",
  //     chainId,
  //     verifyingContract: MEMSWAP,
  //   },
  //   {
  //     Intent: [
  //       {
  //         name: "maker",
  //         type: "address",
  //       },
  //       {
  //         name: "tokenIn",
  //         type: "address",
  //       },
  //       {
  //         name: "tokenOut",
  //         type: "address",
  //       },
  //       {
  //         name: "amountIn",
  //         type: "uint256",
  //       },
  //       {
  //         name: "startAmountOut",
  //         type: "uint256",
  //       },
  //       {
  //         name: "endAmountOut",
  //         type: "uint256",
  //       },
  //       {
  //         name: "deadline",
  //         type: "uint256",
  //       },
  //     ],
  //   },
  //   intent
  // );
  // // Generate approval transaction
  // const data =
  //   new ethers.utils.Interface([
  //     "function approve(address spender, uint256 amount)",
  //   ]).encodeFunctionData("approve", [MEMSWAP, amountIn]) +
  //   new ethers.utils.AbiCoder()
  //     .encode(
  //       [
  //         "address",
  //         "address",
  //         "address",
  //         "uint256",
  //         "uint256",
  //         "uint256",
  //         "uint256",
  //         "bytes",
  //       ],
  //       [
  //         intent.maker,
  //         intent.tokenIn,
  //         intent.tokenOut,
  //         intent.amountIn,
  //         intent.startAmountOut,
  //         intent.endAmountOut,
  //         intent.deadline,
  //         (intent as any).signature,
  //       ]
  //     )
  //     .slice(2);
  // const tx = {
  //   from: maker.address,
  //   to: tokenIn,
  //   data,
  //   nonce: await ethers.provider.getTransactionCount(maker.address),
  //   type: 2,
  //   chainId,
  //   gasLimit: 100000,
  //   maxFeePerGas: await ethers.provider
  //     .getBlock("pending")
  //     .then((b) => b!.baseFeePerGas!),
  //   maxPriorityFeePerGas: ethers.utils.parseUnits("1", "wei"),
  // };
  // const rawTx = await maker.signTransaction(tx as any);
  // await ethers.provider.send("eth_sendRawTransaction", [rawTx]);
  // console.log("Transaction relayed");
};

main();
