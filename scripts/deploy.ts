import hre, { ethers } from "hardhat";

const main = async () => {
  const [deployer] = await ethers.getSigners();

  const contract = await ethers
    .getContractFactory("Memswap", deployer)
    .then((factory) => factory.deploy());
  await contract.waitForDeployment();
  await hre.run("verify:verify", {
    address: await contract.getAddress(),
    constructorArguments: [],
  });
};

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
