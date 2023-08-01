import {
  FlashbotsBundleProvider,
  FlashbotsBundleResolution,
} from "@flashbots/ethers-provider-bundle";
import axios from "axios";
import { Interface } from "ethers/lib/utils";
import { ethers } from "hardhat";

const MEMSWAP = "0xd085A295543e21f200DB0480DAC26546a6F1674c";

const main = async () => {
  const chainId = await ethers.provider.getNetwork().then((n) => n.chainId);

  await new Promise((resolve) => setTimeout(resolve, 1000 * 60));

  const maker = new ethers.Wallet(process.env.MAKER_PK!);
  const taker = new ethers.Wallet(process.env.TAKER_PK!);

  const wsProvider = new ethers.providers.WebSocketProvider(
    process.env.WS_URL!
  );
  wsProvider.on("pending", (tx) => {
    wsProvider.getTransaction(tx).then(async (tx) => {
      if (
        tx?.data?.startsWith("0x095ea7b3") &&
        tx?.from?.toLowerCase() === maker.address.toLowerCase()
      ) {
        const data = "0x" + tx.data.slice(2 + 4 * 2 + 32 * 2 + 32 * 2);
        if (data.length > 0) {
          const result = new ethers.utils.AbiCoder().decode(
            [
              "address",
              "address",
              "address",
              "uint256",
              "uint256",
              "uint256",
              "uint256",
              "bytes",
            ],
            data
          );

          const intent = {
            maker: result[0],
            tokenIn: result[1],
            tokenOut: result[2],
            amountIn: result[3],
            startAmountOut: result[4],
            endAmountOut: result[5],
            deadline: result[6],
            signature: result[7],
          };

          const flashbotsProvider = await FlashbotsBundleProvider.create(
            ethers.provider,
            new ethers.Wallet(
              "0x2000000000000000000000000000000000000000000000000000000000000000"
            ),
            "https://relay-goerli.flashbots.net"
          );

          const { data: swapData } = await axios.get(
            "https://goerli.api.0x.org/swap/v1/quote",
            {
              params: {
                buyToken: tokenOut,
                sellToken: tokenIn,
                sellAmount: amountIn,
              },
              headers: {
                "0x-Api-Key": "e519f152-3749-49ea-a8f3-2964bb0f90ac",
              },
            }
          );

          const signedBundle = await flashbotsProvider.signBundle([
            {
              signedTransaction: ethers.utils.serializeTransaction(
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
              signer: taker,
              transaction: {
                from: taker.address,
                to: MEMSWAP,
                data: new ethers.utils.Interface([
                  `
                    function executeIntent(
                      (
                        address maker,
                        address tokenIn,
                        address tokenOut,
                        uint256 amountIn,
                        uint256 startAmountOut,
                        uint256 endAmountOut,
                        uint256 deadline,
                        bytes signature
                      ) intent,
                      address fillContract,
                      bytes fillData
                    )
                  `,
                ]).encodeFunctionData("executeIntent", [
                  intent,
                  swapData.to,
                  swapData.data,
                ]),
                type: 2,
                gasLimit: 1000000,
                chainId: 5,
                maxFeePerGas: await ethers.provider
                  .getBlock("pending")
                  .then((b) =>
                    b!.baseFeePerGas!.add(ethers.utils.parseUnits("5", "gwei"))
                  ),
                maxPriorityFeePerGas: ethers.utils.parseUnits("5", "gwei"),
              },
            },
          ]);

          let blockNumber = await ethers.provider
            .getBlock("latest")
            .then((b) => b.number + 1);

          const bundleReceipt = await flashbotsProvider.sendRawBundle(
            signedBundle,
            blockNumber
          );
          console.log(JSON.stringify(bundleReceipt, null, 2));

          for (let i = 1; i <= 30; i++) {
            console.log(">>>>>> ", i);

            const bundleSubmission = await flashbotsProvider.sendRawBundle(
              signedBundle,
              blockNumber + i
            );
            console.log("bundle submitted, waiting", bundleReceipt.bundleHash);

            const waitResponse = await bundleSubmission.wait();
            console.log(
              `Wait Response: ${FlashbotsBundleResolution[waitResponse]}`
            );
            if (
              waitResponse === FlashbotsBundleResolution.BundleIncluded ||
              waitResponse === FlashbotsBundleResolution.AccountNonceTooHigh
            ) {
              console.log("Bundle included!");
              process.exit(0);
            }
          }
        }
      }
    });
  });

  const tokenIn = "0xb4fbf271143f4fbf7b91a5ded31805e42b2208d6";
  const tokenOut = "0x07865c6e87b9f70255377e024ace6630c1eaa37f";
  const amountIn = ethers.utils.parseEther("0.001");
  const amountOut = ethers.utils.parseUnits("0.1", 6);

  // Create intent
  const intent = {
    maker: maker.address,
    tokenIn,
    tokenOut,
    amountIn,
    startAmountOut: amountOut,
    endAmountOut: amountOut,
    deadline: await ethers.provider
      .getBlock("latest")
      .then((b) => b!.timestamp + 3600 * 24),
  };
  (intent as any).signature = await maker._signTypedData(
    {
      name: "Memswap",
      version: "1.0",
      chainId,
      verifyingContract: MEMSWAP,
    },
    {
      Intent: [
        {
          name: "maker",
          type: "address",
        },
        {
          name: "tokenIn",
          type: "address",
        },
        {
          name: "tokenOut",
          type: "address",
        },
        {
          name: "amountIn",
          type: "uint256",
        },
        {
          name: "startAmountOut",
          type: "uint256",
        },
        {
          name: "endAmountOut",
          type: "uint256",
        },
        {
          name: "deadline",
          type: "uint256",
        },
      ],
    },
    intent
  );

  // Generate approval transaction
  const data =
    new ethers.utils.Interface([
      "function approve(address spender, uint256 amount)",
    ]).encodeFunctionData("approve", [MEMSWAP, amountIn]) +
    new ethers.utils.AbiCoder()
      .encode(
        [
          "address",
          "address",
          "address",
          "uint256",
          "uint256",
          "uint256",
          "uint256",
          "bytes",
        ],
        [
          intent.maker,
          intent.tokenIn,
          intent.tokenOut,
          intent.amountIn,
          intent.startAmountOut,
          intent.endAmountOut,
          intent.deadline,
          (intent as any).signature,
        ]
      )
      .slice(2);

  const tx = {
    from: maker.address,
    to: tokenIn,
    data,
    nonce: await ethers.provider.getTransactionCount(maker.address),
    type: 2,
    chainId,
    gasLimit: 100000,
    maxFeePerGas: await ethers.provider
      .getBlock("pending")
      .then((b) => b!.baseFeePerGas!),
    maxPriorityFeePerGas: ethers.utils.parseUnits("1", "wei"),
  };

  const rawTx = await maker.signTransaction(tx as any);

  await ethers.provider.send("eth_sendRawTransaction", [rawTx]);
  console.log("Transaction relayed");
};

main();
