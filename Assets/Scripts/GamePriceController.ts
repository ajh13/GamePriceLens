import { GameRecognition, PriceQuote, RecognitionProvider } from "./GamePriceTypes";
import { MOCK_PRICE_QUOTE } from "./MockPriceData";
import { MockRecognitionProvider } from "./MockRecognitionProvider";
import { PriceChartingDirectClient } from "./PriceChartingDirectClient";
import { PriceChartingProxyClient } from "./PriceChartingProxyClient";

type ScanState =
  | "READY"
  | "CAPTURING"
  | "RECOGNIZING"
  | "LOOKING_UP"
  | "RESULT"
  | "ERROR";

@component
export class GamePriceController extends BaseScriptComponent {
  @input
  @hint("HTTPS origin of the GamePriceLens proxy. Never put a PriceCharting token here.")
  proxyBaseUrl: string = "https://example.invalid";

  @input
  @hint("Private prototype mode: use a token entered by the wearer instead of the proxy.")
  useDirectPriceCharting: boolean = true;

  @input
  @hint("Use deterministic recognition and price data while building the scene.")
  useMockData: boolean = true;

  @input
  @hint("Run the mock scan automatically when the Lens starts.")
  runMockAtStart: boolean = true;

  @input
  @allowUndefined
  statusText: Text;

  @input
  @allowUndefined
  titleText: Text;

  @input
  @allowUndefined
  platformText: Text;

  @input
  @allowUndefined
  loosePriceText: Text;

  @input
  @allowUndefined
  completePriceText: Text;

  @input
  @allowUndefined
  newPriceText: Text;

  private cameraModule: CameraModule = require("LensStudio:CameraModule");
  private recognitionProvider: RecognitionProvider = new MockRecognitionProvider();
  private runtimePriceChartingToken: string = "";
  private state: ScanState = "READY";
  private busy: boolean = false;

  onAwake(): void {
    this.createEvent("OnStartEvent").bind(() => {
      this.setState("READY", "Frame a game case or cartridge");
      if (this.useMockData && this.runMockAtStart) {
        this.scan();
      }
    });
  }

  /** Bind the SPECS UI Scan button's trigger event to this public method. */
  public async scan(): Promise<void> {
    if (this.busy) {
      return;
    }

    this.busy = true;
    try {
      let image: Texture | null = null;
      if (!this.useMockData) {
        this.setState("CAPTURING", "Capturing image…");
        image = await this.captureStill();
      }

      this.setState("RECOGNIZING", "Recognizing game…");
      const recognition = await this.recognitionProvider.recognize(image);

      this.setState("LOOKING_UP", "Checking current value…");
      const quote = this.useMockData ? MOCK_PRICE_QUOTE : await this.lookupPrice(recognition);

      this.renderResult(recognition, quote);
      this.setState("RESULT", `Match confidence ${Math.round(recognition.confidence * 100)}%`);
    } catch (error) {
      print(`[GamePriceController] scan failed: ${error}`);
      this.setState("ERROR", "Couldn't identify that game. Try again.");
    } finally {
      this.busy = false;
    }
  }

  /**
   * Receive the wearer's token from a masked SPECS keyboard field.
   * The value remains in memory only and is never printed or saved.
   */
  public setPriceChartingToken(token: string): boolean {
    const normalized = (token || "").trim();
    if (!/^[A-Za-z0-9]{40}$/.test(normalized)) {
      this.runtimePriceChartingToken = "";
      this.setState("ERROR", "Token must be 40 letters or numbers");
      return false;
    }

    this.runtimePriceChartingToken = normalized;
    this.setState("READY", "PriceCharting connected for this session");
    return true;
  }

  /** Clear the in-memory token when the wearer disconnects or changes accounts. */
  public clearPriceChartingToken(): void {
    this.runtimePriceChartingToken = "";
    this.setState("READY", "Enter your PriceCharting token to continue");
  }

  /** Restore the capture prompt after a result or error. */
  public resetScan(): void {
    if (this.busy) {
      return;
    }
    this.setState("READY", "Frame a game case or cartridge");
  }

  private async captureStill(): Promise<Texture> {
    const request = CameraModule.createImageRequest();
    const frame = await this.cameraModule.requestImage(request);
    return frame.texture;
  }

  private async lookupPrice(recognition: GameRecognition): Promise<PriceQuote> {
    if (this.useDirectPriceCharting) {
      if (!this.runtimePriceChartingToken) {
        throw new Error("Enter your PriceCharting API token first");
      }
      return new PriceChartingDirectClient(this.runtimePriceChartingToken).lookup(recognition);
    }
    return new PriceChartingProxyClient(this.proxyBaseUrl).lookup(recognition);
  }

  private renderResult(recognition: GameRecognition, quote: PriceQuote): void {
    this.setText(this.titleText, quote.productName || recognition.title);
    this.setText(this.platformText, quote.consoleName || recognition.platform || "Unknown platform");
    this.setText(this.loosePriceText, this.formatPrice("Loose", quote.prices.loose));
    this.setText(this.completePriceText, this.formatPrice("CIB", quote.prices.complete));
    this.setText(this.newPriceText, this.formatPrice("New", quote.prices.new));
  }

  private formatPrice(label: string, cents: number | null): string {
    if (cents === null || cents === undefined) {
      return `${label} —`;
    }
    return `${label} $${(cents / 100).toFixed(2)}`;
  }

  private setState(next: ScanState, message: string): void {
    this.state = next;
    this.setText(this.statusText, message);
    print(`[GamePriceController] ${this.state}: ${message}`);
  }

  private setText(target: Text | undefined, value: string): void {
    if (target) {
      target.text = value;
    }
  }
}
