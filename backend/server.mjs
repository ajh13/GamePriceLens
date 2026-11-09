import { createServer } from "node:http";

const PORT = Number.parseInt(process.env.PORT ?? "8787", 10);
const TOKEN = process.env.PRICECHARTING_TOKEN ?? "";
const CACHE_TTL_MS = Number.parseInt(process.env.CACHE_TTL_SECONDS ?? "21600", 10) * 1000;

const cache = new Map();
let upstreamQueue = Promise.resolve();
let lastUpstreamStartedAt = 0;

function sendJson(response, status, body) {
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "Access-Control-Allow-Origin": "*",
  });
  response.end(JSON.stringify(body));
}

function nullableCents(value) {
  if (value === undefined || value === null || value === "") return null;
  const cents = Number.parseInt(String(value), 10);
  return Number.isFinite(cents) ? cents : null;
}

function normalizeProduct(product) {
  const id = String(product.id ?? "");
  return {
    id,
    productName: String(product["product-name"] ?? ""),
    consoleName: String(product["console-name"] ?? ""),
    upc: product.upc ? String(product.upc) : null,
    prices: {
      loose: nullableCents(product["loose-price"]),
      complete: nullableCents(product["cib-price"]),
      new: nullableCents(product["new-price"]),
      boxOnly: nullableCents(product["box-only-price"]),
    },
    currency: "USD",
    sourceUrl: id ? `https://www.pricecharting.com/game/${encodeURIComponent(id)}` : "https://www.pricecharting.com/",
    fetchedAt: new Date().toISOString(),
  };
}

function enqueueUpstream(task) {
  const run = upstreamQueue.then(async () => {
    const waitMs = Math.max(0, 1000 - (Date.now() - lastUpstreamStartedAt));
    if (waitMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, waitMs));
    }
    lastUpstreamStartedAt = Date.now();
    return task();
  });
  upstreamQueue = run.catch(() => undefined);
  return run;
}

async function lookupPrice({ upc, query }) {
  const cacheKey = upc ? `upc:${upc}` : `query:${query.toLowerCase()}`;
  const cached = cache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.value;
  }

  if (!TOKEN) {
    const error = new Error("Server is missing PRICECHARTING_TOKEN");
    error.statusCode = 503;
    throw error;
  }

  const params = new URLSearchParams({ t: TOKEN });
  if (upc) params.set("upc", upc);
  else params.set("q", query);

  const upstreamUrl = `https://www.pricecharting.com/api/product?${params.toString()}`;
  const product = await enqueueUpstream(async () => {
    const response = await fetch(upstreamUrl, {
      method: "GET",
      headers: { Accept: "application/json" },
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok || data.status === "error") {
      const error = new Error(data["error-message"] ?? `PriceCharting returned HTTP ${response.status}`);
      error.statusCode = response.status === 404 ? 404 : 502;
      throw error;
    }
    return data;
  });

  const normalized = normalizeProduct(product);
  cache.set(cacheKey, { value: normalized, expiresAt: Date.now() + CACHE_TTL_MS });
  return normalized;
}

const server = createServer(async (request, response) => {
  try {
    const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`);

    if (request.method === "GET" && url.pathname === "/health") {
      sendJson(response, 200, { status: "ok", configured: Boolean(TOKEN) });
      return;
    }

    if (request.method === "GET" && url.pathname === "/v1/prices") {
      const upc = (url.searchParams.get("upc") ?? "").replace(/\D/g, "");
      const query = (url.searchParams.get("query") ?? "").trim();
      if ((upc && query) || (!upc && !query)) {
        sendJson(response, 400, { error: "Provide exactly one of upc or query" });
        return;
      }
      if (upc && (upc.length < 8 || upc.length > 14)) {
        sendJson(response, 400, { error: "UPC must contain 8–14 digits" });
        return;
      }
      if (query.length > 160) {
        sendJson(response, 400, { error: "Query is too long" });
        return;
      }

      const result = await lookupPrice({ upc, query });
      sendJson(response, 200, result);
      return;
    }

    sendJson(response, 404, { error: "Not found" });
  } catch (error) {
    console.error("[GamePriceLensProxy]", error);
    sendJson(response, error.statusCode ?? 500, { error: error.message ?? "Unexpected server error" });
  }
});

server.listen(PORT, () => {
  console.log(`GamePriceLens proxy listening on http://localhost:${PORT}`);
});
