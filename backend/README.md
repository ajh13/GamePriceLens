# GamePriceLens PriceCharting proxy

This dependency-free Node 20+ server keeps the PriceCharting API token off SPECS, normalizes responses, caches repeated lookups, and serializes upstream calls to respect the one-request-per-second limit.

## Run locally

```bash
cp .env.example .env
set -a; source .env; set +a
node server.mjs
```

## Endpoints

- `GET /health`
- `GET /v1/prices?upc=<UPC>`
- `GET /v1/prices?query=<title and platform>`

Price values are returned as integer cents. Deploy behind HTTPS before using it from SPECS.

## Production checklist

- Store `PRICECHARTING_TOKEN` as a host-managed secret.
- Add edge rate limiting and abuse protection.
- Use a shared cache if you run more than one server instance.
- Restrict logs to request IDs, lookup keys, status, and latency.
- Confirm the PriceCharting commercial license and required attribution.
