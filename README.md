# GamePriceLens for SPECS

Work-in-progress Lens Studio project for identifying physical video games from cases, cartridges, discs, or UPC-A/EAN-13 barcodes, then opening PriceCharting's public website in an in-Lens WebView. The active flow does not require a PriceCharting API key or extract prices from the website.

## Current status: not hardware-ready

This is a development snapshot, not a finished release. The latest device test crashes during UIKit button initialization with `OpacityFactor uniform is missing from material`. UIKit reports creation with Lens Studio 5.25 build 26100705; the project was last saved using 5.24.1.26100516. That mismatch is a lead, not a confirmed root cause. Prior shader repair attempts did not resolve the failure.

Other unverified or failing areas include WebView readiness, in-Lens website navigation, real-game visual recognition accuracy, camera permissions, and hardware interactions. See `Assets/Tests/desktop-validation.json` for earlier validation details; the startup crash above supersedes that report's UI observations. No universal recognition or pricing accuracy is claimed.

## Implementation

- `Assets/Scripts/GamePriceMain.ts`: barcode-first scan flow with Gemini vision fallback.
- `Assets/Scripts/BarcodeScanner.ts`: local UPC-A/EAN-13 decoding and checksum validation.
- `Assets/Scripts/RecognitionValidation.ts`: recognition validation and PriceCharting search URL generation.
- `Assets/Scripts/GamePricePanelUI.ts`: spatial UI and lazy WebView initialization.
- `Assets/Tests/`: synthetic barcode and recognition-validation tests plus disabled diagnostic probes.

The older mock/direct-token/proxy scaffolding and optional `backend/` are retained as part of this snapshot; they are not the active WebView flow. Documents in `docs/` describe earlier plans, not completion guarantees.

## Open and configure

1. Clone the repository and open `GamePriceLens.esproj` in a compatible Lens Studio version. The project targets SPECS 27 and uses experimental APIs.
2. Allow Lens Studio to import assets and regenerate its cache and type definitions.
3. Configure your own Remote Service Gateway credentials through Lens Studio. All populated token fields in the published scene have been cleared. Never commit tokens, signing keys, or editor snapshots.
4. Resolve the startup crash before expecting the Lens to launch on hardware.

Bundled third-party Lens Studio packages remain subject to their respective terms; this repository does not relicense those dependencies. No additional license is granted by this snapshot.

## Tests

With Node.js and TypeScript available as required by the test scripts:

```sh
node Assets/Tests/barcode.test.mjs
node Assets/Tests/recognition.test.mjs
```

These tests do not establish that the Lens launches or works on a device.

## Public snapshot hygiene

Local editor configuration, caches, generated support files, signing keys, and the credential-bearing virtual-scene snapshot are excluded. The authored scene is included with credential values cleared. The original local working project is not changed by publishing this sanitized copy.
