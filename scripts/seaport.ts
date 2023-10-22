import { AddressZero, HashZero } from "@ethersproject/constants";
import { JsonRpcProvider } from "@ethersproject/providers";
import { randomBytes } from "@ethersproject/random";
import { parseEther } from "@ethersproject/units";
import { Wallet } from "@ethersproject/wallet";
import * as Sdk from "@reservoir0x/sdk";
import axios from "axios";

import { bn } from "../src/common/utils";

// Required env variables:
// - JSON_URL: url for the http provider
// - MAKER_PK: private key of the maker
// - SOLVER_BASE_URL: base url of the solver

const main = async () => {
  const provider = new JsonRpcProvider(process.env.JSON_URL!);
  const maker = new Wallet(process.env.MAKER_PK!);

  const contract = "0x713d83cb05aa0d48cd162ea2dca44a3435bb3392";
  const tokenId = "2528";
  const price = parseEther("0.007");

  const chainId = await provider.getNetwork().then((n) => n.chainId);
  const order = new Sdk.SeaportV15.Order(chainId, {
    offerer: maker.address,
    zone: AddressZero,
    offer: [
      {
        itemType: Sdk.SeaportBase.Types.ItemType.ERC20,
        token: Sdk.Common.Addresses.WNative[chainId],
        identifierOrCriteria: "0",
        startAmount: price.toString(),
        endAmount: price.toString(),
      },
    ],
    consideration: [
      {
        itemType: Sdk.SeaportBase.Types.ItemType.ERC721,
        token: contract,
        identifierOrCriteria: tokenId,
        startAmount: "1",
        endAmount: "1",
        recipient: maker.address,
      },
    ],
    orderType: Sdk.SeaportBase.Types.OrderType.FULL_OPEN,
    startTime: Math.floor(Date.now() / 1000),
    endTime: Math.floor(Date.now() / 1000) + 5 * 60,
    zoneHash: HashZero,
    salt: bn(randomBytes(32)).toHexString(),
    conduitKey: Sdk.SeaportBase.Addresses.OpenseaConduitKey[chainId],
    counter: (
      await new Sdk.SeaportV15.Exchange(chainId).getCounter(
        provider,
        maker.address
      )
    ).toString(),
    totalOriginalConsiderationItems: 1,
  });
  await order.sign(maker);

  await axios.post(`${process.env.SOLVER_BASE_URL}/erc721/seaport`, {
    order: order.params,
  });
};

main();
