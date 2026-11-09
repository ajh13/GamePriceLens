import { GameRecognition, RecognitionProvider } from "./GamePriceTypes";

/** Deterministic provider used to build and test the Lens without cloud services. */
export class MockRecognitionProvider implements RecognitionProvider {
  async recognize(_image: Texture | null): Promise<GameRecognition> {
    return {
      source: "mock",
      upc: "045496590420",
      title: "The Legend of Zelda: Tears of the Kingdom",
      platform: "Nintendo Switch",
      format: "case",
      confidence: 0.98,
    };
  }
}
