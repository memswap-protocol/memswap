export const config = {
  jsonUrl: process.env.JSON_URL!,
  wsUrl: process.env.WS_URL!,
  redisUrl: process.env.REDIS_URL!,
  flashbotsSignerPk: process.env.FLASHBOTS_SIGNER_PK!,
  solverPk: process.env.SOLVER_PK!,
  matchmakerBaseUrl: process.env.MATCHMAKER_BASE_URL!,
  zeroExApiKey: process.env.ZERO_EX_API_KEY!,
  port: process.env.PORT!,
};
