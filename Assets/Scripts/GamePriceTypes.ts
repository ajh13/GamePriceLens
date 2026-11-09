export type RecognitionSource = "barcode" | "visual" | "manual" | "mock";

export interface GameRecognition {
  source: RecognitionSource;
  upc?: string;
  title: string;
  platform?: string;
  format?: "case" | "cartridge" | "disc" | "unknown";
  confidence: number;
}

export interface PriceBreakdown {
  loose: number | null;
  complete: number | null;
  new: number | null;
  boxOnly: number | null;
}

export interface PriceQuote {
  id: string;
  productName: string;
  consoleName: string;
  upc: string | null;
  prices: PriceBreakdown;
  currency: "USD";
  sourceUrl: string;
  fetchedAt: string;
}

export interface RecognitionProvider {
  recognize(image: Texture | null): Promise<GameRecognition>;
}
