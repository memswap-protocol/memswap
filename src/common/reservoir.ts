import { AddressZero } from "@ethersproject/constants";
import axios from "axios";

import { MEMETH } from "./addresses";
import { config } from "./config";

export const getReservoirBaseUrl = () =>
  config.chainId === 1
    ? "https://api.reservoir.tools"
    : "https://api-goerli.reservoir.tools";

export const getEthConversion = async (token: string) =>
  token === MEMETH[config.chainId]
    ? "1"
    : await axios
        .get(
          `${getReservoirBaseUrl()}/currencies/conversion/v1?from=${AddressZero}&to=${token}`
        )
        .then((response) => response.data.conversion);
