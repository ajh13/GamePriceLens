import { GameRecognition, PriceQuote } from "./GamePriceTypes";

interface PriceChartingProduct {
  status?: string;
  id?: string | number;
  upc?: string;
  "product-name"?: string;
  "console-name"?: string;
  "loose-price"?: string | number;
  "cib-price"?: string | number;
  "new-price"?: string | number;
  "box-only-price"?: string | number;
  "error-message"?: string;
}

/**
 * Direct PriceCharting client for private/BYO-token use.
 *
 * The token is supplied at runtime and retained only in this object's memory.
 * Never print it, expose it as an Inspector input, or persist it in Lens assets.
 */
export class PriceChartingDirectClient {
  private internetModule: InternetModule = require("LensStudio:InternetModule");

  constructor(private readonly token: string) {
    if (!/^[A-Za-z0-9]{40}$/.test(token)) {
      throw new Error("Enter a valid 40-character PriceCharting API token");
    }
  }

  async lookup(recognition: GameRecognition): Promise<PriceQuote> {
    const response = await this.internetModule.fetch(this.buildEndpoint(recognition), {
      method: "GET",
      headers: { Accept: "application/json" },
    });
    const payload = (await response.json()) as PriceChartingProduct;

    if (response.status !== 200 || payload.status === "error") {
      throw new Error(payload["error-message"] || `PriceCharting returned HTTP ${response.status}`);
    }

    return this.normalize(payload);
  }

  private buildEndpoint(recognition: GameRecognition): string {
    const params: string[] = [`t=${encodeURIComponent(this.token)}`];
    if (recognition.upc) {
      params.push(`upc=${encodeURIComponent(recognition.upc)}`);
    } else {
      const query = [recognition.title, recognition.platform]
        .filter((part) => !!part)
        .join(" ");
      params.push(`q=${encodeURIComponent(query)}`);
    }
    return `https://www.pricecharting.com/api/product?${params.join("&")}`;
  }

  private normalize(product: PriceChartingProduct): PriceQuote {
    const id = String(product.id || "");
    if (!id || !product["product-name"]) {
      throw new Error("PriceCharting did not return a matching product");
    }

    return {
      id,
      productName: String(product["product-name"]),
      consoleName: String(product["console-name"] || "Unknown platform"),
      upc: product.upc ? String(product.upc) : null,
      prices: {
        loose: this.toCents(product["loose-price"]),
        complete: this.toCents(product["cib-price"]),
        new: this.toCents(product["new-price"]),
        boxOnly: this.toCents(product["box-only-price"]),
      },
      currency: "USD",
      sourceUrl: `https://www.pricecharting.com/game/${encodeURIComponent(id)}`,
      fetchedAt: new Date().toISOString(),
    };
  }

  private toCents(value: string | number | undefined): number | null {
    if (value === undefined || value === null || value === "") {
      return null;
    }
    const cents = Number.parseInt(String(value), 10);
    return Number.isFinite(cents) ? cents : null;
  }
}
