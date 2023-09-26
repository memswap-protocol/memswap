import { config as commonConfig } from "../common/config";

export const config = {
  alchemyApiKey: process.env.ALCHEMY_API_KEY!,
  redisUrl: process.env.REDIS_URL!,
  solverPk: process.env.SOLVER_PK!,
  matchmakerBaseUrl: process.env.MATCHMAKER_BASE_URL!,
  solverBaseUrl: process.env.SOLVER_BASE_URL!,
  zeroExApiKey: process.env.ZERO_EX_API_KEY!,
  port: process.env.PORT!,
  ...commonConfig,
};
