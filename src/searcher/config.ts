export const config = {
  jsonUrl: process.env.JSON_URL!,
  wsUrl: process.env.WS_URL!,
  redisUrl: process.env.REDIS_URL!,
  flashbotsSignerPk: process.env.FLASHBOTS_SIGNER_PK!,
  searcherPk: process.env.SEARCHER_PK!,
  relayToMatchMaker: process.env.RELAY_TO_MATCHMAKER!,
  matchMakerBaseUrl: process.env.MATCH_MAKER_BASE_URL!,
  zeroExApiKey: process.env.ZERO_EX_API_KEY!,
  port: process.env.PORT!,
};
