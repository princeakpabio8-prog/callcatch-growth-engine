const { MemoryCache } = require("../cache");
const { RateLimiter } = require("../rateLimiter");
const { fetchJson } = require("../httpClient");

const cache = new MemoryCache(1000 * 60 * 60 * 24);
const limiter = new RateLimiter({ intervalMs: 1100, concurrency: 1 });

function parseState(result) {
  const address = result.address || {};
  return address.state || address.region || address.county || "";
}

function parseCity(result) {
  const address = result.address || {};
  return address.city || address.town || address.village || address.hamlet || address.county || "";
}

function countryName(value = "") {
  const key = String(value || "").trim().toLowerCase();
  const countries = {
    us: "United States",
    usa: "United States",
    "united states": "United States",
    ca: "Canada",
    canada: "Canada",
    uk: "United Kingdom",
    gb: "United Kingdom",
    "united kingdom": "United Kingdom",
    europe: "Europe",
    eu: "Europe"
  };
  return countries[key] || value || "United States";
}

function countryCodes(value = "") {
  const key = String(value || "").trim().toLowerCase();
  if (["us", "usa", "united states"].includes(key)) return "us";
  if (["ca", "canada"].includes(key)) return "ca";
  if (["uk", "gb", "united kingdom"].includes(key)) return "gb";
  if (["europe", "eu"].includes(key)) return "gb,ie,fr,de,nl,be,es,it,pt,se,no,dk,fi,ch,at,pl";
  return "";
}

function shortCountryCode(value = "") {
  const country = countryName(value).toLowerCase();
  if (country === "canada") return "CA";
  if (country === "united kingdom") return "GB";
  if (country === "europe") return "EU";
  return "US";
}

async function geocodeArea(area, options = {}) {
  const country = countryName(options.country || options.countryCode || "");
  const query = /europe/i.test(country) ? area : `${area}, ${country}`;
  const key = `nominatim:${query.toLowerCase()}:${country.toLowerCase()}`;
  const cached = cache.get(key);
  if (cached) return { ...cached, cached: true };

  const url = new URL("https://nominatim.openstreetmap.org/search");
  url.searchParams.set("q", query);
  url.searchParams.set("format", "jsonv2");
  url.searchParams.set("addressdetails", "1");
  const codes = countryCodes(country);
  if (codes) url.searchParams.set("countrycodes", codes);
  url.searchParams.set("limit", "1");

  const results = await limiter.run(() => fetchJson(url.toString()));
  if (!Array.isArray(results) || results.length === 0) {
    throw new Error(`Could not find a city or area for "${area}" in ${country}`);
  }

  const result = results[0];
  const [south, north, west, east] = (result.boundingbox || []).map(Number);
  const payload = {
    query,
    city: parseCity(result),
    state: parseState(result),
    country,
    countryCode: shortCountryCode(country),
    countryCodes: countryCodes(country),
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
