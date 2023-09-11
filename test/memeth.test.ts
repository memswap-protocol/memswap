import { Contract } from "@ethersproject/contracts";
import { parseEther } from "@ethersproject/units";
import { SignerWithAddress } from "@nomiclabs/hardhat-ethers/signers";
import { expect } from "chai";
import { ethers } from "hardhat";

describe("MEMETH", async () => {
  let chainId: number;

  let deployer: SignerWithAddress;
  let alice: SignerWithAddress;
  let bob: SignerWithAddress;

  let memeth: Contract;

  beforeEach(async () => {
    chainId = await ethers.provider.getNetwork().then((n) => n.chainId);

    [deployer, alice, bob] = await ethers.getSigners();

    memeth = await ethers
      .getContractFactory("MEMETH")
      .then((factory) => factory.deploy());
  });

  it("Deposit and approve", async () => {
    const depositAmount = parseEther("0.1");
    const approveAmount = parseEther("0.09");

    await expect(
      memeth
        .connect(alice)
        .depositAndApprove(bob.address, approveAmount, { value: depositAmount })
    )
      .to.emit(memeth, "Deposit")
      .withArgs(bob.address, depositAmount)
      .to.emit(memeth, "Approval")
      .withArgs(alice.address, bob.address, approveAmount);
  });
});
