# GamePriceLens implementation plan

## Goal

Let a SPECS wearer look at a video-game case or cartridge, initiate one scan, and see an attributed current PriceCharting value in under five seconds on a normal connection.

## Recommended architecture

```text
SPECS camera
    │ high-resolution still
    ▼
Recognition provider
    ├─ visible UPC → exact lookup
    └─ title + platform → ranked text lookup
    │
    ▼
GamePriceLens HTTPS proxy
    ├─ request validation
    ├─ cache and 1 request/second upstream throttle
    └─ PriceCharting API token (server-only)
    │
    ▼
Head-locked result card
```

For private prototypes, the proxy branch may be replaced by a direct PriceCharting request using a token entered by the wearer. The token stays in memory and is cleared when the Lens session ends.

## Recognition strategy

### Milestone 1 — mock and manual-query prototype

Use the existing mock recognizer and mock quote to finish interaction, layout, and state transitions without external dependencies. Add an optional debug text query for emulator testing.

### Milestone 2 — cloud vision MVP

Capture a 512–1024 px still through `CameraModule.requestImage()`. Use Snap's Remote Service Gateway with a vision-capable model to return strict JSON:

```json
{
  "upc": "045496590420",
  "title": "The Legend of Zelda: Tears of the Kingdom",
  "platform": "Nintendo Switch",
  "format": "case",
  "confidence": 0.97
}
```

This one path handles both readable barcodes and front-label/cartridge recognition. Require a deliberate pinch before capture and show a clear processing state because the frame is sensitive user data.

### Milestone 3 — local-first recognition

Train a small SnapML detector/classifier on the highest-volume platforms and titles. Keep cloud vision as fallback for unknown games. A local model reduces latency and data transfer, but it needs a curated dataset, versioning, and accuracy evaluation. Avoid a single classifier with thousands of game SKUs; use staged recognition: package type/platform → OCR or embedding retrieval → exact catalog match.

## Lens state machine

`READY → CAPTURING → RECOGNIZING → LOOKING_UP → RESULT`

Any network, permission, or confidence failure transitions to `ERROR`, with a short recovery action that returns to `READY`.

## API contract

### Request

`GET /v1/prices?upc=045496590420`

or

`GET /v1/prices?query=zelda%20tears%20of%20the%20kingdom%20nintendo%20switch`

Exactly one of `upc` or `query` is required.

### Response

```json
{
  "id": "12345",
  "productName": "The Legend of Zelda: Tears of the Kingdom",
  "consoleName": "Nintendo Switch",
  "upc": "045496590420",
  "prices": {
    "loose": 3512,
    "complete": 4235,
    "new": 5899,
    "boxOnly": 1199
  },
  "currency": "USD",
  "sourceUrl": "https://www.pricecharting.com/game/12345",
  "fetchedAt": "2026-11-07T20:00:00.000Z"
}
```

All price fields are integer cents. Missing values are `null`.

## UX requirements

- Center reticle with the instruction “Frame the full case or cartridge.”
- One deliberate pinch to capture; no continuous image transmission.
- Progress labels that match the state machine.
- Result card with game title, platform, recognition confidence, and Loose/CIB/New prices.
- “Not sure” confirmation when visual confidence is below 0.85.
- Retry and alternate-match affordances.
- PriceCharting attribution linked to the returned product URL if the commercial agreement requests it.

## Privacy and security

- Never embed the PriceCharting token in Lens assets, source, logs, or MCP config.
- In BYO-token mode, accept the token only through a masked field and keep it in memory for the current session; do not persist it.
- Do not include the token in error messages, analytics, screenshots, or debug output.
- Request camera + internet permissions through the supported SPECS flow and explain why a still is processed.
- Prefer Remote Service Gateway for camera-derived cloud AI processing.
- Log IDs and timing, not image data or API secrets.
- Cache server results and enforce the PriceCharting one-request-per-second limit.
- Obtain PriceCharting's commercial permission before publishing the Lens to other users.

## Milestones and acceptance criteria

### M0 — project bootstrap

- [x] Lens Studio project exists.
- [x] Lens Studio MCP server is running and project config is generated.
- [x] CLAD is installed in Codex.
- [x] Backend contract and Lens-side client are scaffolded.
- [ ] Target platform is SPECS and preview is SPECS 27 (complete through MCP after reload).

### M1 — interactive mock

- [ ] Head-locked SPECS UI renders at a comfortable depth.
- [ ] Scan action drives every state in order.
- [ ] Mock result shows correctly formatted Loose/CIB/New prices.
- [ ] No TypeScript or runtime Logger errors.

### M2 — live pricing

- [ ] Proxy is deployed over HTTPS with the token stored as an environment secret.
- [ ] Exact UPC lookup returns a normalized result.
- [ ] Title/platform fallback returns the intended first match or an ambiguity response.
- [ ] Cache prevents duplicate upstream requests.
- [ ] PriceCharting attribution and licensing requirements are satisfied.

### M3 — live recognition

- [ ] Deliberate capture and permission UX work on a physical SPECS device.
- [ ] Barcode recognition accuracy is at least 95% on the test set.
- [ ] Case/cartridge top-1 accuracy is at least 85%; top-3 is at least 95%.
- [ ] Median end-to-end latency is under five seconds.
- [ ] Low-confidence results require confirmation.

### M4 — release hardening

- [ ] Offline, timeout, rate-limit, permission-denied, and no-match paths are tested.
- [ ] No secret or captured image appears in logs.
- [ ] Performance is profiled on device.
- [ ] Lens passes SPECS packaging and publish checks.
