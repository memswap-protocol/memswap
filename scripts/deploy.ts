import { SignerWithAddress } from "@nomiclabs/hardhat-ethers/signers";
import hre, { ethers } from "hardhat";

import { MEMSWAP_ERC20, MEMSWAP_ERC721, SOLVER } from "../src/common/addresses";

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
};

const main = async () => {
  const [deployer] = await ethers.getSigners();
  const chainId = await ethers.provider.getNetwork().then((n) => n.chainId);

  // Common
  // await deployContract(deployer, "MEMETH");

  // MemswapERC20
  // await deployContract(deployer, "MemswapERC20");
  // await deployContract(deployer, "SolutionProxyERC20", [
  //   SOLVER[chainId],
  //   MEMSWAP_ERC20[chainId],
  // ]);

  // MemswapERC721
  // await deployContract(deployer, "MemswapERC721");
  await deployContract(deployer, "SolutionProxyERC721", [
    SOLVER[chainId],
    MEMSWAP_ERC721[chainId],
  ]);
};

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
