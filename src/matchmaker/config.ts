export const config = {
  chainId: Number(process.env.CHAIN_ID),
  jsonUrl: process.env.JSON_URL!,
  redisUrl: process.env.REDIS_URL!,
  flashbotsSignerPk: process.env.FLASHBOTS_SIGNER_PK!,
  matchmakerPk: process.env.MATCHMAKER_PK!,
  knownSolvers: JSON.parse(process.env.KNOWN_SOLVERS ?? "[]") as string[],
  port: process.env.PORT!,
};
