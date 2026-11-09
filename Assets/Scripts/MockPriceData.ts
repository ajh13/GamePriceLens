import { PriceQuote } from "./GamePriceTypes";

export const MOCK_PRICE_QUOTE: PriceQuote = {
  id: "mock-zelda-totk-switch",
  productName: "The Legend of Zelda: Tears of the Kingdom",
  consoleName: "Nintendo Switch",
  upc: "045496590420",
  prices: {
    loose: 3512,
    complete: 4235,
    new: 5899,
    boxOnly: 1199,
  },
  currency: "USD",
  sourceUrl: "https://www.pricecharting.com/",
  fetchedAt: "2026-11-07T00:00:00.000Z",
};
