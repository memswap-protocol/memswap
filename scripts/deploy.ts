import { SignerWithAddress } from "@nomiclabs/hardhat-ethers/signers";
import hre, { ethers } from "hardhat";

import { MEMSWAP, MEMSWAP_WETH } from "../src/common/addresses";

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

  deployer;
};

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
