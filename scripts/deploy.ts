import { SignerWithAddress } from "@nomiclabs/hardhat-ethers/signers";
import hre, { ethers } from "hardhat";

const deployContract = async (deployer: SignerWithAddress, name: string) => {
  const contract = await ethers
    .getContractFactory(name, deployer)
    .then((factory) => factory.deploy());
  console.log(`${name} deployed at ${contract.address.toLowerCase()}`);

  await new Promise((resolve) => setTimeout(resolve, 60 * 1000));

  await hre.run("verify:verify", {
    address: contract.address,
    constructorArguments: [],
  });
};

const main = async () => {
  const [deployer] = await ethers.getSigners();

  //await deployContract(deployer, "Memswap");
  await deployContract(deployer, "WETH2");
  await deployContract(deployer, "ZeroExFiller");
};

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
