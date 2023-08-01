import { SignerWithAddress } from "@nomiclabs/hardhat-ethers/signers";
import axios from "axios";
import { Contract } from "ethers";
import { ethers } from "hardhat";

describe("Memswap", async () => {
  let chainId: number;

  let deployer: SignerWithAddress;
  let alice: SignerWithAddress;
  let bob: SignerWithAddress;

  let memswap: Contract;

  beforeEach(async () => {
    chainId = await ethers.provider.getNetwork().then((n) => n.chainId);

    [deployer, alice, bob] = await ethers.getSigners();

    memswap = await ethers
      .getContractFactory("Memswap")
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
      tokenIn: weth.address,
      tokenOut: usdc.address,
      amountIn: ethers.utils.parseEther("0.5"),
      startAmountOut: ethers.utils.parseUnits("500", 6),
      endAmountOut: ethers.utils.parseUnits("500", 6),
      deadline: await ethers.provider
        .getBlock("latest")
        .then((b) => b!.timestamp + 60),
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

    await (memswap.connect(bob) as any).executeIntent(
      order,
      swapData.to,
      swapData.data
    );
  });
});
