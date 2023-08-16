export const config = {
  jsonUrl: process.env.JSON_URL!,
  wsUrl: process.env.WS_URL!,
  redisUrl: process.env.REDIS_URL!,
  searcherPk: process.env.SEARCHER_PK!,
  relayToMatchMaker: process.env.RELAY_TO_MATCHMAKER!,
  matchMakerBaseUrl: process.env.MATCH_MAKER_BASE_URL!,
  port: process.env.PORT!,
};
