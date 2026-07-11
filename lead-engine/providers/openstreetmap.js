const { MemoryCache } = require("../cache");
const { RateLimiter } = require("../rateLimiter");
const { fetchJson } = require("../httpClient");
const { getTradeConfig } = require("../trades");

const cache = new MemoryCache(1000 * 60 * 60 * 6);
const limiter = new RateLimiter({ intervalMs: 1200, concurrency: 1 });
const ENDPOINTS = [
  "https://overpass-api.de/api/interpreter",
  "https://overpass.private.coffee/api/interpreter",
  "https://overpass.kumi.systems/api/interpreter",
  "https://overpass.osm.ch/api/interpreter"
];

function escRegex(value) {
  return String(value || "").replace(/["\\]/g, "\\$&");
}

function compactBbox(bbox) {
  return [bbox.south, bbox.west, bbox.north, bbox.east]
    .map(value => Number(value).toFixed(5))
    .join(",");
}

function buildQuery({ trade, bbox, limit }) {
  const config = getTradeConfig(trade);
  const regex = escRegex(config.osmRegex);
  const box = compactBbox(bbox);
  const cappedLimit = Math.max(20, Math.min((Number(limit) || 10) * 6, 120));

  return `[out:json][timeout:8];
(
  nwr["name"~"${regex}",i](${box});
  nwr["craft"~"${regex}",i](${box});
  nwr["office"~"company|contractor",i]["name"~"${regex}",i](${box});
  nwr["shop"~"${regex}",i](${box});
  nwr["service"~"${regex}",i](${box});
  nwr["description"~"${regex}",i](${box});
);
out center tags ${cappedLimit};`;
}

function readTag(tags, names) {
  for (const name of names) {
    if (tags && tags[name]) return tags[name];
  }
  return "";
}

function addressFromTags(tags, fallbackArea) {
  const parts = [
    readTag(tags, ["addr:housenumber"]),
    readTag(tags, ["addr:street"]),
    readTag(tags, ["addr:city"]),
    readTag(tags, ["addr:state"]),
    readTag(tags, ["addr:postcode"])
  ].filter(Boolean);
  return parts.length ? parts.join(" ") : fallbackArea;
}

function cityFromTags(tags, fallback) {
  return readTag(tags, ["addr:city", "is_in:city"]) || fallback.city || "";
}

function stateFromTags(tags, fallback) {
  return readTag(tags, ["addr:state"]) || fallback.state || "";
}

function osmUrl(element) {
  return `https://www.openstreetmap.org/${element.type}/${element.id}`;
}

function normalizeElement(element, context) {
  const tags = element.tags || {};
  const lat = element.lat || (element.center && element.center.lat) || null;
  const lon = element.lon || (element.center && element.center.lon) || null;
  const website = readTag(tags, ["website", "contact:website", "url"]);
  const facebook = readTag(tags, ["facebook", "contact:facebook", "brand:facebook", "social:facebook"]);
  const phone = readTag(tags, ["phone", "contact:phone", "mobile", "contact:mobile"]);
  const email = readTag(tags, ["email", "contact:email"]);
  const business = readTag(tags, ["name", "operator", "brand"]);

  return {
    business,
    trade: context.trade,
    city: cityFromTags(tags, context.location),
    state: stateFromTags(tags, context.location),
    country: context.location.country || "",
    countryCode: context.location.countryCode || "",
    area: addressFromTags(tags, context.location.displayName),
    address: addressFromTags(tags, context.location.displayName),
    phone,
    website,
    facebook,
    email,
    latitude: lat,
    longitude: lon,
    mapsUrl: osmUrl(element),
    osmUrl: osmUrl(element),
    source: "OpenStreetMap",
    sourceId: `${element.type}/${element.id}`,
    rating: 0,
    reviews: 0,
    tags
  };
}

async function requestOverpass(query) {
  let lastError;
  for (const endpoint of ENDPOINTS) {
    try {
      return await limiter.run(() => fetchJson(endpoint, {
        method: "POST",
        signal: AbortSignal.timeout(8000),
        headers: { "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8" },
        body: `data=${encodeURIComponent(query)}`
      }, { retries: 0, retryDelayMs: 1000, timeoutMs: 8000 }));
    } catch (error) {
      lastError = error;
      console.warn(JSON.stringify({
        time: new Date().toISOString(),
        level: "warn",
        message: "overpass_endpoint_failed",
        endpoint,
        error: error.message
      }));
    }
  }
  throw lastError || new Error("OpenStreetMap search failed");
}

async function searchOpenStreetMap({ trade, location, count }) {
  const key = `osm:${trade}:${compactBbox(location.bbox)}:${count}`;
  const cached = cache.get(key);
  if (cached) return { leads: cached, cached: true };

  const query = buildQuery({ trade, bbox: location.bbox, limit: count });
  const payload = await requestOverpass(query);
  const leads = (payload.elements || [])
    .map(element => normalizeElement(element, { trade, location }))
    .filter(lead => lead.business);

  cache.set(key, leads);
  return { leads, cached: false };
}

module.exports = { searchOpenStreetMap };
