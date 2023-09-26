export const config = {
  chainId: Number(process.env.CHAIN_ID),
  jsonUrl: process.env.JSON_URL!,
  flashbotsSignerPk: process.env.FLASHBOTS_SIGNER_PK!,
  bloxrouteAuth: process.env.BLOXROUTE_AUTH,
  reservoirApiKey: process.env.RESERVOIR_API_KEY!,
};
