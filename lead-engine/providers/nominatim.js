const { MemoryCache } = require("../cache");
const { RateLimiter } = require("../rateLimiter");
const { fetchJson } = require("../httpClient");

const cache = new MemoryCache(1000 * 60 * 60 * 24);
const limiter = new RateLimiter({ intervalMs: 1100, concurrency: 1 });

function parseState(result) {
  const address = result.address || {};
  return address.state || address.region || "";
}

function parseCity(result) {
  const address = result.address || {};
  return address.city || address.town || address.village || address.hamlet || address.county || "";
}

async function geocodeArea(area) {
  const query = `${area}, United States`;
  const key = `nominatim:${query.toLowerCase()}`;
  const cached = cache.get(key);
  if (cached) return { ...cached, cached: true };

  const url = new URL("https://nominatim.openstreetmap.org/search");
  url.searchParams.set("q", query);
  url.searchParams.set("format", "jsonv2");
  url.searchParams.set("addressdetails", "1");
  url.searchParams.set("countrycodes", "us");
  url.searchParams.set("limit", "1");

  const results = await limiter.run(() => fetchJson(url.toString()));
  if (!Array.isArray(results) || results.length === 0) {
    throw new Error(`Could not find a U.S. city or area for "${area}"`);
  }

  const result = results[0];
  const [south, north, west, east] = (result.boundingbox || []).map(Number);
  const payload = {
    query,
    city: parseCity(result),
    state: parseState(result),
    displayName: result.display_name || area,
    lat: Number(result.lat),
    lon: Number(result.lon),
    bbox: { south, west, north, east },
    source: "Nominatim"
  };

  cache.set(key, payload);
  return payload;
}

module.exports = { geocodeArea };
