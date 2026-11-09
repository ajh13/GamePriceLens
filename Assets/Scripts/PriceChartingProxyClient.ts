import { GameRecognition, PriceQuote } from "./GamePriceTypes";

export class PriceChartingProxyClient {
  private internetModule: InternetModule = require("LensStudio:InternetModule");

  constructor(private readonly baseUrl: string) {}

  async lookup(recognition: GameRecognition): Promise<PriceQuote> {
    const endpoint = this.buildEndpoint(recognition);
    const response = await this.internetModule.fetch(endpoint, {
      method: "GET",
      headers: { Accept: "application/json" },
    });

    if (response.status !== 200) {
      const detail = await response.text();
      throw new Error(`Price lookup failed (${response.status}): ${detail}`);
    }

    const payload = (await response.json()) as PriceQuote;
    this.validate(payload);
    return payload;
  }

  private buildEndpoint(recognition: GameRecognition): string {
    const root = this.baseUrl.replace(/\/$/, "");
    if (recognition.upc) {
      return `${root}/v1/prices?upc=${encodeURIComponent(recognition.upc)}`;
    }

    const query = [recognition.title, recognition.platform]
      .filter((part) => !!part)
      .join(" ");
    return `${root}/v1/prices?query=${encodeURIComponent(query)}`;
  }

  private validate(value: PriceQuote): void {
    if (!value || !value.id || !value.productName || !value.prices) {
      throw new Error("Price proxy returned an invalid response");
    }
  }
}
