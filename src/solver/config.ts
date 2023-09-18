export const config = {
  chainId: Number(process.env.CHAIN_ID),
  jsonUrl: process.env.JSON_URL!,
  alchemyApiKey: process.env.ALCHEMY_API_KEY!,
  redisUrl: process.env.REDIS_URL!,
  flashbotsSignerPk: process.env.FLASHBOTS_SIGNER_PK!,
  solverPk: process.env.SOLVER_PK!,
  matchmakerBaseUrl: process.env.MATCHMAKER_BASE_URL!,
  solverBaseUrl: process.env.SOLVER_BASE_URL!,
  zeroExApiKey: process.env.ZERO_EX_API_KEY!,
  reservoirApiKey: process.env.RESERVOIR_API_KEY!,
  bloxrouteAuth: process.env.BLOXROUTE_AUTH,
  port: process.env.PORT!,
};
