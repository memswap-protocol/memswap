import { BigNumber } from "@ethersproject/bignumber";
import { AddressZero } from "@ethersproject/constants";
import { Contract } from "@ethersproject/contracts";
import { SignerWithAddress } from "@nomiclabs/hardhat-ethers/signers";
import axios from "axios";
import { expect } from "chai";
import { ethers } from "hardhat";

describe("Memswap", async () => {
  let chainId: number;

  let alice: SignerWithAddress;
  let bob: SignerWithAddress;
  let carol: SignerWithAddress;

  let memswap: Contract;
  let zeroExFiller: Contract;

  beforeEach(async () => {
    chainId = await ethers.provider.getNetwork().then((n) => n.chainId);

    [alice, bob, carol] = await ethers.getSigners();

    memswap = await ethers
      .getContractFactory("Memswap")
      .then((factory) => factory.deploy());
    zeroExFiller = await ethers
      .getContractFactory("ZeroExFiller")
      .then((factory) => factory.deploy());
  });

  it("Basic filling", async () => {
    const weth = new Contract(
      "0xb4fbf271143f4fbf7b91a5ded31805e42b2208d6",
      new ethers.utils.Interface([
        "function deposit() payable",
        "function approve(address, uint256)",
        "function balanceOf(address) view returns (uint256)",
      ]),
      ethers.provider
    );
    const usdc = new Contract(
      "0x07865c6e87b9f70255377e024ace6630c1eaa37f",
      new ethers.utils.Interface([
        "function balanceOf(address) view returns (uint256)",
      ]),
      ethers.provider
    );

    await (weth.connect(alice) as any).deposit({
      value: ethers.utils.parseEther("0.5"),
    });
    await (weth.connect(alice) as any).approve(
      memswap.address,
      ethers.utils.parseEther("0.5")
    );

    const order = {
      maker: alice.address,
      filler: AddressZero,
      tokenIn: weth.address,
      tokenOut: usdc.address,
      referrer: carol.address,
      referrerFeeBps: 0,
      referrerSlippageBps: 10,
      deadline: await ethers.provider
        .getBlock("latest")
        .then((b) => b!.timestamp + 60),
      amountIn: ethers.utils.parseEther("0.5"),
      startAmountOut: ethers.utils.parseUnits("500", 6),
      endAmountOut: ethers.utils.parseUnits("500", 6),
    };
    (order as any).signature = await alice._signTypedData(
      {
        name: "Memswap",
        version: "1.0",
        chainId,
        verifyingContract: memswap.address,
      },
      {
        Intent: [
          {
            name: "maker",
            type: "address",
          },
          {
            name: "filler",
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
            name: "referrer",
            type: "address",
          },
          {
            name: "referrerFeeBps",
            type: "uint32",
          },
          {
            name: "referrerSlippageBps",
            type: "uint32",
          },
          {
            name: "deadline",
            type: "uint32",
          },
          {
            name: "amountIn",
            type: "uint128",
          },
          {
            name: "startAmountOut",
            type: "uint128",
          },
          {
            name: "endAmountOut",
            type: "uint128",
          },
        ],
      },
      order
    );

    const { data: swapData } = await axios.get(
      "https://goerli.api.0x.org/swap/v1/quote",
      {
        params: {
          buyToken: order.tokenOut,
          sellToken: order.tokenIn,
          sellAmount: order.amountIn,
        },
        headers: {
          "0x-Api-Key": "e519f152-3749-49ea-a8f3-2964bb0f90ac",
        },
      }
    );

    console.log(JSON.stringify(swapData, null, 2));

    const makerBalanceBefore = await usdc.balanceOf(order.maker);
    const referrerBalanceBefore = await usdc.balanceOf(order.referrer);

    await memswap
      .connect(bob)
      .execute(
        order,
        zeroExFiller.address,
        zeroExFiller.interface.encodeFunctionData("fill", [
          swapData.to,
          swapData.data,
          order.tokenIn,
          order.tokenOut,
        ])
      );

    const makerBalanceAfter = await usdc.balanceOf(order.maker);
    const referrerBalanceAfter = await usdc.balanceOf(order.referrer);

    console.log(makerBalanceAfter.sub(makerBalanceBefore));
    console.log(referrerBalanceAfter.sub(referrerBalanceBefore));
  });
});
