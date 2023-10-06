import { config as commonConfig } from "../common/config";

export const config = {
  port: process.env.PORT!,
  redisUrl: process.env.REDIS_URL!,
  matchmakerPk: process.env.MATCHMAKER_PK!,
  knownSolversERC20: JSON.parse(
    process.env.KNOWN_SOLVERS_ERC20 ?? "[]"
  ) as string[],
  knownSolversERC721: JSON.parse(
    process.env.KNOWN_SOLVERS_ERC721 ?? "[]"
  ) as string[],
  tenderlyGatewayKey: process.env.TENDERLY_GATEWAY_KEY,
  ...commonConfig,
};
