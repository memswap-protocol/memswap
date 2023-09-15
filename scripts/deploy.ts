import { Interface } from "@ethersproject/abi";
import { SignerWithAddress } from "@nomiclabs/hardhat-ethers/signers";
import hre, { ethers } from "hardhat";

import {
  MEMSWAP_ERC20,
  MEMSWAP_ERC721,
  MEMSWAP_NFT,
  SOLVER,
} from "../src/common/addresses";

const deployContract = async (
  deployer: SignerWithAddress,
  name: string,
  constructorArguments: any[] = []
) => {
  const contract = await ethers
    .getContractFactory(name, deployer)
    .then((factory: { deploy: (...args: any[]) => any }) =>
      factory.deploy(...constructorArguments)
    );
  console.log(`${name} deployed at ${contract.address.toLowerCase()}`);

  await new Promise((resolve) => setTimeout(resolve, 60 * 1000));

  await hre.run("verify:verify", {
    address: contract.address,
    constructorArguments,
  });

  return contract.address;
};

const main = async () => {
  const [deployer] = await ethers.getSigners();
  const chainId = await ethers.provider.getNetwork().then((n) => n.chainId);

  // Common
  // await deployContract(deployer, "MEMETH");

  // MemswapNFT
  // MEMSWAP_NFT[chainId] = await deployContract(deployer, "Memswap", [
  //   deployer.address,
  //   "https://test-tokens-metadata.vercel.app/api/erc721/",
  //   "https://test-tokens-metadata.vercel.app/api/erc721/contract",
  // ]);

  // MemswapERC20
  // MEMSWAP_ERC20[chainId] = await deployContract(deployer, "MemswapERC20", [
  //   MEMSWAP_NFT[chainId],
  // ]);

  // MemswapERC721
  // MEMSWAP_ERC721[chainId] = await deployContract(deployer, "MemswapERC721", [
  //   MEMSWAP_NFT[chainId],
  // ]);

  // SolutionProxy
  // await deployContract(deployer, "SolutionProxy", [
  //   SOLVER[chainId],
  //   MEMSWAP_ERC20[chainId],
  //   MEMSWAP_ERC721[chainId],
  // ]);

  // Set MemswapERC20 and MemswapERC721 as minters
  // await deployer.sendTransaction({
  //   to: MEMSWAP_NFT[chainId],
  //   data: new Interface([
  //     "function setIsAllowedToMint(address[] minters, bool[] allowed)",
  //   ]).encodeFunctionData("setIsAllowedToMint", [
  //     [MEMSWAP_ERC20[chainId], MEMSWAP_ERC721[chainId]],
  //     [true, true],
  //   ]),
  // });
};

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
