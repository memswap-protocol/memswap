import { HardhatUserConfig } from "hardhat/config";

import "@nomiclabs/hardhat-ethers";
import "@nomiclabs/hardhat-etherscan";
import "@nomiclabs/hardhat-waffle";
import "hardhat-tracer";

const config: HardhatUserConfig = {
  solidity: "0.8.19",
  networks: {
    hardhat: {
      chainId: 1,
      forking: {
        url: String(process.env.RPC_URL),
        blockNumber: Number(process.env.BLOCK_NUMBER),
      },
    },
    localhost: {
      url: "http://127.0.0.1:8545",
    },
    goerli: {
      url: String(process.env.RPC_URL),
      accounts: process.env.DEPLOYER_PK ? [process.env.DEPLOYER_PK] : undefined,
    },
  },
  etherscan: {
    apiKey: String(process.env.ETHERSCAN_API_KEY),
  },
};

export default config;
