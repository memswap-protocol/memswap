import { Interface } from "@ethersproject/abi";
import { AddressZero, MaxUint256 } from "@ethersproject/constants";
import { Contract } from "@ethersproject/contracts";
import { JsonRpcProvider } from "@ethersproject/providers";
import { parseEther, parseUnits } from "@ethersproject/units";
import { Wallet } from "@ethersproject/wallet";
import axios from "axios";
import { Queue, Worker } from "bullmq";
import { randomUUID } from "crypto";

import { MEMETH } from "../../common/addresses";
import { logger } from "../../common/logger";
import { bn } from "../../common/utils";
import { config } from "../config";
import { redis } from "../redis";
import * as solutions from "../solutions";

const COMPONENT = "inventory-manager";

export const queue = new Queue(COMPONENT, {
  connection: redis.duplicate(),
  defaultJobOptions: {
    attempts: 5,
    removeOnComplete: 10000,
    removeOnFail: 10000,
  },
});

const worker = new Worker(
  COMPONENT,
  async (job) => {
    const { address } = job.data as { address: string };
    if (address === AddressZero) {
      return;
    }

    try {
      const provider = new JsonRpcProvider(config.jsonUrl);
      const solver = new Wallet(config.solverPk).connect(provider);

      const contract = new Contract(
        address,
        new Interface([
          "function balanceOf(address owner) view returns (uint256)",
          "function allowance(address owner, address spender) view returns (uint256)",
          "function approve(address spender, uint256 amount)",
          "function withdraw(uint256 amount)",
        ]),
        provider
      );

      const token = await solutions.uniswap.getToken(address, provider);
      const ethPrice = await solutions.reservoir.getEthConversion(address);

      const balanceInToken = await contract.balanceOf(solver.address);
      const balanceInEth = bn(balanceInToken)
        .mul(parseEther("1"))
        .div(parseUnits(ethPrice, token.decimals));

      // Must have at least 0.01 ETH worth of tokens
      if (balanceInEth.gte(parseEther("0.01"))) {
        const latestBaseFee = await provider
          .getBlock("pending")
          .then((b) => b.baseFeePerGas!);
        // Gas price should be lower than 25 gwei
        if (latestBaseFee <= parseUnits("25", "gwei")) {
          logger.info(
            COMPONENT,
            JSON.stringify({
              msg: `Liquidating ${address} inventory`,
              address,
              balance: balanceInToken.toString(),
            })
          );

          if (address === MEMETH[config.chainId]) {
            // Withdraw
            await contract.connect(solver).withdraw(balanceInToken);
          } else {
            // Swap

            const { data: swapData } = await axios.get(
              config.chainId === 1
                ? "https://api.0x.org/swap/v1/quote"
                : "https://goerli.api.0x.org/swap/v1/quote",
              {
                params: {
                  buyToken: solutions.zeroex.ZEROEX_ETH,
                  sellToken: address,
                  sellAmount: balanceInToken.toString(),
                },
                headers: {
                  "0x-Api-Key": config.zeroExApiKey,
                },
              }
            );

            const allowance = await contract.allowance(
              solver.address,
              swapData.allowanceTarget
            );
            if (allowance.lt(balanceInToken)) {
              const tx = await contract
                .connect(solver)
                .approve(swapData.allowanceTarget, MaxUint256);
              await tx.wait();
            }

            const txData = {
              to: swapData.to,
              data: swapData.data,
              // Explicit gas limit to avoid "out-of-gas" errors
              gasLimit: 700000,
            };

            await solver.estimateGas(txData);
            await solver.sendTransaction(txData);
          }
        }
      }
    } catch (error: any) {
      logger.error(
        COMPONENT,
        JSON.stringify({ msg: "Job failed", error, stack: error.stack })
      );
      throw error;
    }
  },
  { connection: redis.duplicate(), concurrency: 2000 }
);
worker.on("error", (error) => {
  logger.error(COMPONENT, JSON.stringify({ msg: "Worker errored", error }));
});

export const addToQueue = async (address: string, force?: boolean) =>
  queue.add(
    randomUUID(),
    { address },
    {
      delay: force ? undefined : 3600 * 1000,
      jobId: force ? undefined : address,
    }
  );
