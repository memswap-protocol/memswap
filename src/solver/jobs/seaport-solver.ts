import { Interface } from "@ethersproject/abi";
import { BigNumber } from "@ethersproject/bignumber";
import { JsonRpcProvider } from "@ethersproject/providers";
import { parseEther, parseUnits } from "@ethersproject/units";
import { Wallet } from "@ethersproject/wallet";
import { FlashbotsBundleRawTransaction } from "@flashbots/ethers-provider-bundle";
import * as Sdk from "@reservoir0x/sdk";
import { constructOfferCounterOrderAndFulfillments } from "@reservoir0x/sdk/dist/seaport-base/helpers";
import SeaportV15Abi from "@reservoir0x/sdk/dist/seaport-v1.5/abis/Exchange.json";
import { Queue, Worker } from "bullmq";
import { randomUUID } from "crypto";

import { logger } from "../../common/logger";
import { getFlashbotsProvider, relayViaBloxroute } from "../../common/tx";
import { bn, now } from "../../common/utils";
import { config } from "../config";
import { redis } from "../redis";
import { directSolve } from "../solutions/reservoir";

const COMPONENT = "seaport-solver";

export const getGasCost = async (
  provider: JsonRpcProvider,
  maxPriorityFeePerGas = parseUnits("1", "gwei")
) => {
  // Approximations for gas costs
  const purchaseGasCost = 250000;
  const matchGasCost = 250000;
  const approveGasCost = 50000;
  const unwrapGasCost = 50000;

  const latestBaseFee = await provider
    .getBlock("pending")
    .then((b) => b!.baseFeePerGas!);

  return latestBaseFee
    .add(maxPriorityFeePerGas)
    .mul(purchaseGasCost + matchGasCost + approveGasCost + unwrapGasCost);
};

export const updateStatus = async (
  hash: string,
  status: "pending" | "success" | "failure",
  details?: string
) => {
  await redis.set(
    `status:${hash}`,
    JSON.stringify({
      status,
      details,
      time: Math.floor(Date.now() / 1000),
    })
  );
};

export const queue = new Queue(COMPONENT, {
  connection: redis.duplicate(),
  defaultJobOptions: {
    attempts: 10,
    removeOnComplete: 10000,
    removeOnFail: 10000,
  },
});

const worker = new Worker(
  COMPONENT,
  async (job) => {
    const data = job.data as {
      order: Sdk.SeaportBase.Types.OrderComponents;
    };

    try {
      const perfTime1 = performance.now();

      const provider = new JsonRpcProvider(config.jsonUrl);
      const flashbotsProvider = await getFlashbotsProvider();

      const perfTime2 = performance.now();

      const solver = new Wallet(config.solverPk);

      const order = new Sdk.SeaportV15.Order(config.chainId, data.order);
      const orderHash = order.hash();

      try {
        await order.checkSignature();
      } catch {
        const msg = "Order has invalid signature";
        logger.info(
          COMPONENT,
          JSON.stringify({
            msg,
            order: data.order,
            orderHash,
          })
        );

        await updateStatus(orderHash, "failure", msg);
        return;
      }

      const perfTime3 = performance.now();

      const info = order.getInfo();
      if (!info) {
        const msg = "Invalid order format";
        logger.info(
          COMPONENT,
          JSON.stringify({
            msg,
            order: data.order,
            orderHash,
          })
        );

        await updateStatus(orderHash, "failure", msg);
        return;
      }

      if (info.side !== "buy") {
        const msg = "Wrong order side";
        logger.info(
          COMPONENT,
          JSON.stringify({
            msg,
            order: data.order,
            orderHash,
          })
        );

        await updateStatus(orderHash, "failure", msg);
        return;
      }

      if (
        order.params.conduitKey.toLowerCase() !==
        Sdk.SeaportBase.Addresses.OpenseaConduitKey[config.chainId]
      ) {
        const msg = "Wrong conduit";
        logger.info(
          COMPONENT,
          JSON.stringify({
            msg,
            order: data.order,
            orderHash,
          })
        );

        await updateStatus(orderHash, "failure", msg);
        return;
      }

      if (!info.tokenId) {
        const msg = "Invalid order format";
        logger.info(
          COMPONENT,
          JSON.stringify({
            msg,
            order: data.order,
            orderHash,
          })
        );

        await updateStatus(orderHash, "failure", msg);
        return;
      }

      if (info.tokenKind !== "erc721") {
        const msg = "Unsupported token kind";
        logger.info(
          COMPONENT,
          JSON.stringify({
            msg,
            order: data.order,
            orderHash,
          })
        );

        await updateStatus(orderHash, "failure", msg);
        return;
      }

      if (info.amount !== "1") {
        const msg = "Unsupported amount";
        logger.info(
          COMPONENT,
          JSON.stringify({
            msg,
            order: data.order,
            orderHash,
          })
        );

        await updateStatus(orderHash, "failure", msg);
        return;
      }

      if (info.paymentToken !== Sdk.Common.Addresses.WNative[config.chainId]) {
        const msg = "Unsupported payment token";
        logger.info(
          COMPONENT,
          JSON.stringify({
            msg,
            order: data.order,
            orderHash,
          })
        );

        await updateStatus(orderHash, "failure", msg);
        return;
      }

      if (order.params.startTime > now()) {
        const msg = "Order not started";
        logger.info(
          COMPONENT,
          JSON.stringify({
            msg,
            now: now(),
            order: data.order,
            orderHash,
          })
        );

        await updateStatus(orderHash, "failure", msg);
        return;
      }

      if (order.params.endTime <= now()) {
        const msg = "Order expired";
        logger.info(
          COMPONENT,
          JSON.stringify({
            msg,
            now: now(),
            order: data.order,
            orderHash,
          })
        );

        await updateStatus(orderHash, "failure", msg);
        return;
      }

      {
        const msg = "Generating and triggering solution";
        logger.info(
          COMPONENT,
          JSON.stringify({
            msg,
            order: data.order,
            orderHash,
          })
        );

        await updateStatus(orderHash, "pending", msg);
      }

      const fillData = await directSolve(
        `${info.contract}:${info.tokenId}`.toLowerCase(),
        info.amount,
        provider
      );

      // Cost of purchasing
      const purchaseCost = fillData.path
        .map((item: any) => bn(item.buyInRawQuote ?? item.rawQuote))
        .reduce((a: BigNumber, b: BigNumber) => a.add(b));

      const balance = await provider.getBalance(solver.address);
      if (balance.lt(purchaseCost.add(parseEther("0.05")))) {
        const msg = "Purchase cost too high";
        logger.info(
          COMPONENT,
          JSON.stringify({
            msg,
            order: data.order,
            orderHash,
          })
        );

        await updateStatus(orderHash, "failure", msg);
        return;
      }

      // Compute total cost of solving
      const maxPriorityFeePerGas = parseUnits("1", "gwei");
      const totalCost = purchaseCost.add(
        await getGasCost(provider, maxPriorityFeePerGas)
      );

      // Compute total amount received by solving
      const otherFees = info.fees
        .filter(
          (f) => f.recipient.toLowerCase() !== solver.address.toLowerCase()
        )
        .map((f) => bn(f.amount))
        .reduce((a, b) => a.add(b), bn(0));
      const totalReceived = bn(info.price).sub(otherFees);

      if (totalCost.gte(totalReceived)) {
        const msg = "Order not profitable";
        logger.info(
          COMPONENT,
          JSON.stringify({
            msg,
            totalCost: totalCost.toString(),
            totalReceived: totalReceived.toString(),
            order: data.order,
            orderHash,
          })
        );

        await updateStatus(orderHash, "failure", msg);
        return;
      }

      const perfTime4 = performance.now();

      // Just in case, set to 30% more than the pending block's base fee
      const estimatedBaseFee = await provider.getBlock("pending").then((b) => {
        // Handle weird issue when the base fee gets returned in gwei rather than wei
        const converted =
          b!.baseFeePerGas!.toString().length <= 3
            ? parseUnits(b!.baseFeePerGas!.toString(), "gwei")
            : b!.baseFeePerGas!;
        return converted.add(converted.mul(3000).div(10000));
      });

      // Get the current nonce for the solver
      let nonce = await provider.getTransactionCount(solver.address);

      const txs: FlashbotsBundleRawTransaction[] = [];

      // Generate sale tx
      txs.push({
        signedTransaction: await solver.signTransaction({
          to: fillData.saleTx.to,
          nonce: nonce++,
          gasLimit: 300000,
          data: fillData.saleTx.data,
          value: fillData.saleTx.value,
          chainId: config.chainId,
          type: 2,
          maxFeePerGas: estimatedBaseFee.add(maxPriorityFeePerGas).toString(),
          maxPriorityFeePerGas: maxPriorityFeePerGas.toString(),
        }),
      });

      // Generate approval tx (if needed)
      const nft = new Sdk.Common.Helpers.Erc721(provider, info.contract);
      const conduit = new Sdk.SeaportV15.Exchange(config.chainId).deriveConduit(
        order.params.conduitKey
      );
      if (!(await nft.isApproved(solver.address, conduit))) {
        txs.push({
          signedTransaction: await solver.signTransaction({
            to: info.contract,
            nonce: nonce++,
            gasLimit: 100000,
            data: nft.approveTransaction(solver.address, conduit).data,
            value: "0",
            chainId: config.chainId,
            type: 2,
            maxFeePerGas: estimatedBaseFee.add(maxPriorityFeePerGas).toString(),
            maxPriorityFeePerGas: maxPriorityFeePerGas.toString(),
          }),
        });
      }

      // Generate match tx
      const { order: counterOrder, fulfillments } =
        constructOfferCounterOrderAndFulfillments(
          order.params,
          solver.address,
          {
            counter: await new Sdk.SeaportV15.Exchange(
              config.chainId
            ).getCounter(provider, solver.address),
            tips: [],
            tokenId: info.tokenId,
          }
        );
      txs.push({
        signedTransaction: await solver.signTransaction({
          to: Sdk.SeaportV15.Addresses.Exchange[config.chainId],
          nonce: nonce++,
          gasLimit: 350000,
          data: new Interface(SeaportV15Abi).encodeFunctionData(
            "matchAdvancedOrders",
            [
              [
                {
                  parameters: {
                    ...order.params,
                    totalOriginalConsiderationItems:
                      order.params.consideration.length,
                  },
                  signature: order.params.signature!,
                  extraData: "0x",
                  numerator: "1",
                  denominator: "1",
                },
                {
                  parameters: counterOrder.parameters,
                  signature: counterOrder.signature,
                  extraData: "0x",
                  numerator: "1",
                  denominator: "1",
                },
              ],
              [],
              fulfillments,
              solver.address,
            ]
          ),
          value: "0",
          chainId: config.chainId,
          type: 2,
          maxFeePerGas: estimatedBaseFee.add(maxPriorityFeePerGas).toString(),
          maxPriorityFeePerGas: maxPriorityFeePerGas.toString(),
        }),
      });

      // Generate unwrap tx
      txs.push({
        signedTransaction: await solver.signTransaction({
          to: Sdk.Common.Addresses.WNative[config.chainId],
          nonce: nonce++,
          gasLimit: 100000,
          data: new Interface([
            "function withdraw(uint256 amount)",
          ]).encodeFunctionData("withdraw", [totalReceived]),
          value: "0",
          chainId: config.chainId,
          type: 2,
          maxFeePerGas: estimatedBaseFee.add(maxPriorityFeePerGas).toString(),
          maxPriorityFeePerGas: maxPriorityFeePerGas.toString(),
        }),
      });

      const perfTime5 = performance.now();

      const targetBlock =
        (await provider.getBlock("latest").then((b) => b.number)) + 1;

      // Relay
      await relayViaBloxroute(
        orderHash,
        provider,
        flashbotsProvider,
        txs,
        [],
        targetBlock,
        COMPONENT
      );
      await updateStatus(orderHash, "success");

      const perfTime6 = performance.now();

      logger.info(
        COMPONENT,
        JSON.stringify({
          msg: "Performance measurements for seaport-solver",
          time12: (perfTime2 - perfTime1) / 1000,
          time23: (perfTime3 - perfTime2) / 1000,
          time34: (perfTime4 - perfTime3) / 1000,
          time45: (perfTime5 - perfTime4) / 1000,
          time56: (perfTime6 - perfTime5) / 1000,
        })
      );
    } catch (error: any) {
      logger.error(
        COMPONENT,
        JSON.stringify({
          msg: "Job failed",
          error: error.response?.data
            ? JSON.stringify(error.response.data)
            : error,
          stack: error.stack,
        })
      );
      throw error;
    }
  },
  { connection: redis.duplicate(), concurrency: 10 }
);
worker.on("error", (error) => {
  logger.error(
    COMPONENT,
    JSON.stringify({
      msg: "Worker errored",
      error,
    })
  );
});

export const addToQueue = async (
  order: Sdk.SeaportBase.Types.OrderComponents
) =>
  queue.add(
    randomUUID(),
    { order },
    { jobId: new Sdk.SeaportV15.Order(config.chainId, order).hash() }
  );
