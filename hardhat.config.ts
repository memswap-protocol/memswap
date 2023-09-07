import { HardhatUserConfig } from "hardhat/config";

import "@nomiclabs/hardhat-ethers";
import "@nomiclabs/hardhat-etherscan";
import "@nomiclabs/hardhat-waffle";
import "hardhat-gas-reporter";
import "hardhat-tracer";

const config: HardhatUserConfig = {
  solidity: {
    version: "0.8.19",
    settings: {
      viaIR: true,
      optimizer: {
        enabled: true,
        runs: 200,
      },
    },
  },
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
    upstream: {
      url: String(process.env.RPC_URL),
      accounts: process.env.DEPLOYER_PK ? [process.env.DEPLOYER_PK] : undefined,
    },
  },
  etherscan: {
    apiKey: String(process.env.ETHERSCAN_API_KEY),
  },
  gasReporter: {
    enabled: process.env.REPORT_GAS ? true : false,
  },
};

export default config;
