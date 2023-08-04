import { Interface, defaultAbiCoder } from "@ethersproject/abi";
import { BigNumber, BigNumberish } from "@ethersproject/bignumber";
import { TransactionResponse } from "@ethersproject/abstract-provider";
import { JsonRpcProvider, WebSocketProvider } from "@ethersproject/providers";
import { serialize } from "@ethersproject/transactions";
import { parseEther, parseUnits } from "@ethersproject/units";
import { Wallet } from "@ethersproject/wallet";
import {
  FlashbotsBundleProvider,
  FlashbotsBundleResolution,
} from "@flashbots/ethers-provider-bundle";
import axios from "axios";
import express from "express";

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
  referrerSurplusBps: number;
  deadline: number;
  amountIn: string;
  startAmountOut: string;
  expectedAmountOut: string;
  endAmountOut: string;
  signature: string;
};

const bn = (value: BigNumberish) => BigNumber.from(value);

const MEMSWAP = "0x69f2888491ea07bb10936aa110a5e0481122efd3";
const WETH2 = "0xe6ea2a148c13893a8eedd57c75043055a8924c5f";
const ZEROEX_FILLER = "0xd04d42429b36ae07dE931beDa07bCAEfA5B31070";

// Listen to pending mempool transactions
const wsProvider = new WebSocketProvider(process.env.WS_URL!);
wsProvider.on("pending", (tx) =>
  wsProvider.getTransaction(tx).then(async (tx) => {
    try {
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
          restOfCalldata = "0x" + tx.data.slice(2 + 2 * (4 + 32 + 32));
        }
      } else if (
        tx.data.startsWith("0x28026ace") &&
        tx.to?.toLowerCase() === WETH2
      ) {
        const iface = new Interface([
          "function depositAndApprove(address spender, uint256 amount)",
        ]);
        const spender = iface
          .decodeFunctionData("depositAndApprove", tx.data)
          .spender.toLowerCase();
        if (spender === MEMSWAP) {
          restOfCalldata = "0x" + tx.data.slice(2 + 2 * (4 + 32 + 32));
        }
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
            referrerFeeBps: result[5],
            referrerSurplusBps: result[6],
            deadline: result[7],
            amountIn: result[8].toString(),
            startAmountOut: result[9].toString(),
            expectedAmountOut: result[10].toString(),
            endAmountOut: result[11].toString(),
            signature: result[12].toLowerCase(),
          };
        } catch {
          // Skip errors
        }
      }

      if (intent) {
        await fill(tx, intent);
      }
    } catch (error) {
      console.error(`Error parsing: ${error}`);
    }
  })
);

// Fill intent
const fill = async (tx: TransactionResponse, intent: Intent) => {
  try {
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

    const latestBlock = await provider.getBlock("latest");
    const chainId = await provider.getNetwork().then((n) => n.chainId);
    for (let i = 1; i <= 10; i++) {
      const blockNumber = latestBlock.number + i;
      const blockTimestamp = latestBlock.timestamp + i * 14;

      const currentBaseFee = await provider
        .getBlock("pending")
        .then((b) => b!.baseFeePerGas!);

      // TODO: Compute both of these dynamically
      const maxPriorityFeePerGas = parseUnits("10", "gwei");
      const gasLimit = 500000;

      const makerTx = {
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
      };
      const fillerTx = {
        signer: filler,
        transaction: {
          from: filler.address,
          to: MEMSWAP,
          value: 0,
          data: new Interface([
            `
              function execute(
                (
                  address maker,
                  address filler,
                  address tokenIn,
                  address tokenOut,
                  address referrer,
                  uint32 referrerFeeBps,
                  uint32 referrerSurplusBps,
                  uint32 deadline,
                  uint128 amountIn,
                  uint128 startAmountOut,
                  uint128 expectedAmountOut,
                  uint128 endAmountOut,
                  bytes signature
                ) intent,
                address fillContract,
                bytes fillData
              )
            `,
          ]).encodeFunctionData("execute", [
            intent,
            ZEROEX_FILLER,
            new Interface([
              "function fill(address to, bytes data, address tokenIn, address tokenOut)",
            ]).encodeFunctionData("fill", [
              swapData.to,
              swapData.data,
              intent.tokenIn,
              intent.tokenOut,
            ]),
          ]),
          type: 2,
          gasLimit,
          chainId,
          maxFeePerGas: currentBaseFee.add(maxPriorityFeePerGas).toString(),
          maxPriorityFeePerGas: maxPriorityFeePerGas.toString(),
        },
      };

      const makerTxAlreadyIncluded = await provider
        .getTransactionReceipt(tx.hash)
        .then((tx) => {
          console.log(JSON.stringify(tx, null, 2));
          return tx && tx.blockNumber;
        });
      const signedBundle = await flashbotsProvider.signBundle(
        makerTxAlreadyIncluded ? [fillerTx] : [makerTx, fillerTx]
      );

      const simulationResult = await flashbotsProvider.simulate(
        signedBundle,
        blockNumber
      );
      // TODO: Stop if the simulation failed

      const minimumAmountOut = bn(intent.startAmountOut).sub(
        bn(intent.startAmountOut)
          .sub(intent.endAmountOut)
          .div(intent.deadline - blockTimestamp)
      );
      const actualAmountOut = swapData.buyAmount;

      const fillerGrossProfitInETH = bn(actualAmountOut)
        .sub(minimumAmountOut)
        .mul(parseEther(swapData.buyTokenToEthRate))
        .div(parseEther("1"));
      const fillerNetProfitInETH = fillerGrossProfitInETH.sub(
        currentBaseFee.add(maxPriorityFeePerGas).mul(gasLimit)
      );
      if (fillerNetProfitInETH.lt(parseEther("0.00001"))) {
        break;
      }

      console.log(`Trying to send bundle for block ${blockNumber}`);

      const receipt = await flashbotsProvider.sendRawBundle(
        signedBundle,
        blockNumber
      );
      const hash = (receipt as any).bundleHash;

      console.log(
        `Bundle ${hash} submitted in block ${blockNumber}, waiting...`
      );

      const waitResponse = await (receipt as any).wait();
      if (
        waitResponse === FlashbotsBundleResolution.BundleIncluded ||
        waitResponse === FlashbotsBundleResolution.AccountNonceTooHigh
      ) {
        console.log(
          `Bundle ${hash} included in block ${blockNumber} (${
            waitResponse === FlashbotsBundleResolution.BundleIncluded
              ? "BundleIncluded"
              : "AccountNonceTooHigh"
          })`
        );
        break;
      } else {
        console.log(
          `Bundle ${hash} not included in block ${blockNumber} (BlockPassedWithoutInclusion)`
        );
      }
    }
  } catch (error) {
    console.error(`Error filling: ${error}`);
  }
};

const app = express();
app.listen(Number(process.env.PORT));
app.get("/lives", (_, res) => {
  return res.json({ message: "yes" });
});
