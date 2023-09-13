export const config = {
  chainId: Number(process.env.CHAIN_ID),
  jsonUrl: process.env.JSON_URL!,
  redisUrl: process.env.REDIS_URL!,
  flashbotsSignerPk: process.env.FLASHBOTS_SIGNER_PK!,
  matchmakerPk: process.env.MATCHMAKER_PK!,
  knownSolversERC20: JSON.parse(
    process.env.KNOWN_SOLVERS_ERC20 ?? "[]"
  ) as string[],
  knownSolversERC721: JSON.parse(
    process.env.KNOWN_SOLVERS_ERC721 ?? "[]"
  ) as string[],
  port: process.env.PORT!,
};
