const { MemoryCache } = require("../cache");
const { RateLimiter } = require("../rateLimiter");

const cache = new MemoryCache(1000 * 60 * 60 * 12);
const limiter = new RateLimiter({ intervalMs: 1200, concurrency: 1 });
const BRAVE_ENDPOINT = "https://api.search.brave.com/res/v1/web/search";

const DIRECTORY_HOSTS = [
  "angi.com",
  "bbb.org",
  "facebook.com",
  "homeadvisor.com",
  "instagram.com",
  "linkedin.com",
  "mapquest.com",
  "nextdoor.com",
  "thumbtack.com",
  "yelp.com",
  "yellowpages.com"
];

function configured() {
  return Boolean(process.env.BRAVE_SEARCH_API_KEY);
}

function cleanTitle(value = "") {
  return String(value || "")
    .replace(/\s+\|.*$/g, "")
    .replace(/\s+-\s+(Home|Official Site|Website).*$/i, "")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeHost(url = "") {
  try {
    return new URL(url).hostname.replace(/^www\./, "").toLowerCase();
  } catch {
    return "";
  }
}

function isDirectoryUrl(url = "") {
  const host = normalizeHost(url);
  return !host || DIRECTORY_HOSTS.some(domain => host === domain || host.endsWith(`.${domain}`));
}

function firstValue(...values) {
  for (const value of values) {
    if (Array.isArray(value) && value.length) return value[0];
    if (value) return value;
  }
  return "";
}

function addressText(location = {}, fallback = "") {
  const address = location.address || location.postal_address || location.street_address || {};
  if (typeof address === "string") return address;
  return [
    address.streetAddress || address.street_address,
    address.addressLocality || address.locality || address.city,
    address.addressRegion || address.region || address.state,
    address.postalCode || address.postal_code
  ].filter(Boolean).join(", ") || fallback;
}

function cityStateFromLocation(location = {}, fallback = {}) {
  const address = location.address || location.postal_address || {};
  return {
    city: location.city || address.addressLocality || address.locality || address.city || fallback.city || "",
    state: location.state || address.addressRegion || address.region || address.state || fallback.state || ""
  };
}

async function braveSearch(query, { count = 10, local = true } = {}) {
  if (!configured()) return null;
  const key = `brave:${query}:${count}:${local}`;
  const cached = cache.get(key);
  if (cached) return cached;

  const url = new URL(BRAVE_ENDPOINT);
  url.searchParams.set("q", query);
  url.searchParams.set("country", "US");
  url.searchParams.set("search_lang", "en");
  url.searchParams.set("ui_lang", "en-US");
  url.searchParams.set("safesearch", "moderate");
  url.searchParams.set("count", String(Math.max(1, Math.min(Number(count) || 10, 20))));
  url.searchParams.set("extra_snippets", "true");
  if (local) url.searchParams.set("enable_rich_callback", "1");

  const payload = await limiter.run(async () => {
    const response = await fetch(url, {
      headers: {
        Accept: "application/json",
        "X-Subscription-Token": process.env.BRAVE_SEARCH_API_KEY
      },
      signal: AbortSignal.timeout(12000)
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.message || data.error || `Brave Search failed with ${response.status}`);
    return data;
  });

  cache.set(key, payload);
  return payload;
}

function normalizeLocationResult(result = {}, context = {}) {
  const cityState = cityStateFromLocation(result, context.location || {});
  const coordinates = result.coordinates || result.geo || {};
  const website = firstValue(result.url, result.website, result.contact?.website, result.links?.website);
  const phone = firstValue(result.phone, result.telephone, result.contact?.phone);
  return {
    business: cleanTitle(result.title || result.name),
    trade: context.trade,
    city: cityState.city,
    state: cityState.state,
    area: addressText(result, context.location?.displayName || ""),
    address: addressText(result, context.location?.displayName || ""),
    phone,
    website: isDirectoryUrl(website) ? "" : website,
    facebook: /facebook\.com/i.test(website) ? website : "",
    email: "",
    latitude: coordinates.latitude || coordinates.lat || null,
    longitude: coordinates.longitude || coordinates.lng || coordinates.lon || null,
    mapsUrl: result.url || "",
    source: "Brave Search",
    sourceId: result.id || result.url || "",
    rating: Number(result.rating?.ratingValue || result.rating || 0),
    reviews: Number(result.rating?.reviewCount || result.reviews || 0),
    description: result.description || ""
  };
}

function normalizeWebResult(result = {}, context = {}) {
  const url = result.url || "";
  return {
    business: cleanTitle(result.title || context.trade),
    trade: context.trade,
    city: context.location?.city || "",
    state: context.location?.state || "",
    area: context.location?.displayName || "",
    address: context.location?.displayName || "",
    phone: "",
    website: isDirectoryUrl(url) ? "" : url,
    facebook: /facebook\.com/i.test(url) ? url : "",
    email: "",
    latitude: null,
    longitude: null,
    mapsUrl: url,
    source: "Brave Web Search",
    sourceId: url,
    rating: 0,
    reviews: 0,
    description: [result.description, ...(result.extra_snippets || [])].filter(Boolean).join(" ")
  };
}

async function searchBrave({ trade, location, count }) {
  if (!configured()) return { leads: [], cached: false, disabled: true };
  const query = `${trade} companies in ${location.city || location.displayName} ${location.state || ""}`;
  const payload = await braveSearch(query, { count: Math.min(Number(count) || 10, 20), local: true });
  const locations = payload?.locations?.results || [];
  const web = payload?.web?.results || [];
  const leads = [
    ...locations.map(result => normalizeLocationResult(result, { trade, location })),
    ...web.map(result => normalizeWebResult(result, { trade, location }))
  ].filter(lead => lead.business && (lead.website || lead.phone || lead.address));
  return { leads, cached: false, source: "Brave Search" };
}

async function findOfficialWebsite(lead = {}) {
  if (!configured() || !lead.business) return lead;
  const cityState = [lead.city, lead.state].filter(Boolean).join(" ");
  const query = `"${lead.business}" ${cityState} official website ${lead.trade || ""}`;
  const payload = await braveSearch(query, { count: 5, local: false });
  const results = payload?.web?.results || [];
  const official = results.find(result => result.url && !isDirectoryUrl(result.url));
  const facebook = results.find(result => /facebook\.com/i.test(result.url || ""));
  if (official?.url) return { ...lead, website: lead.website && !isDirectoryUrl(lead.website) ? lead.website : official.url, braveWebsiteSource: official.url };
  if (!lead.facebook && facebook?.url) return { ...lead, facebook: facebook.url, website: lead.website || facebook.url, braveWebsiteSource: facebook.url };
  return lead;
}

async function enrichWithBraveWebsites(leads = [], { limit = 12 } = {}) {
  if (!configured()) return leads;
  const output = [];
  let enriched = 0;
  for (const lead of leads) {
    if (enriched < limit && (!lead.website || isDirectoryUrl(lead.website))) {
      try {
        output.push(await findOfficialWebsite(lead));
        enriched += 1;
        continue;
      } catch {}
    }
    output.push(lead);
  }
  return output;
}

module.exports = {
  configured,
  enrichWithBraveWebsites,
  searchBrave
};
