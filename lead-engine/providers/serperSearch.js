const { MemoryCache } = require("../cache");
const { RateLimiter } = require("../rateLimiter");

const cache = new MemoryCache(1000 * 60 * 60 * 12);
const limiter = new RateLimiter({ intervalMs: 900, concurrency: 2 });
const SERPER_ENDPOINT = "https://google.serper.dev/search";

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
  return Boolean(process.env.SERPER_API_KEY);
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

function cleanTitle(value = "") {
  return String(value || "")
    .replace(/\s+\|.*$/g, "")
    .replace(/\s+-\s+(Home|Official Site|Website).*$/i, "")
    .replace(/\s+/g, " ")
    .trim();
}

async function serperSearch(query, { num = 10 } = {}) {
  if (!configured()) return null;
  const key = `serper:${query}:${num}`;
  const cached = cache.get(key);
  if (cached) return cached;

  const payload = await limiter.run(async () => {
    const response = await fetch(SERPER_ENDPOINT, {
      method: "POST",
      headers: {
        "X-API-KEY": process.env.SERPER_API_KEY,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        q: query,
        gl: "us",
        hl: "en",
        num: Math.max(1, Math.min(Number(num) || 10, 20))
      }),
      signal: AbortSignal.timeout(12000)
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.message || data.error || `Serper search failed with ${response.status}`);
    return data;
  });

  cache.set(key, payload);
  return payload;
}

function resultToLead(result = {}, context = {}) {
  const url = result.link || "";
  const title = cleanTitle(result.title || context.trade);
  return {
    business: title,
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
    source: "Serper Search",
    sourceId: url,
    rating: 0,
    reviews: 0,
    description: result.snippet || ""
  };
}

async function searchSerper({ trade, location, count }) {
  if (!configured()) return { leads: [], cached: false, disabled: true };
  const query = `${trade} companies in ${location.city || location.displayName} ${location.state || ""}`;
  const payload = await serperSearch(query, { num: Math.min(Number(count) || 10, 20) });
  const organic = payload?.organic || [];
  const places = payload?.places || [];
  const organicLeads = organic.map(result => resultToLead(result, { trade, location }));
  const placeLeads = places.map(place => ({
    business: cleanTitle(place.title || place.name),
    trade,
    city: location.city || "",
    state: location.state || "",
    area: place.address || location.displayName || "",
    address: place.address || location.displayName || "",
    phone: place.phoneNumber || place.phone || "",
    website: place.website && !isDirectoryUrl(place.website) ? place.website : "",
    facebook: "",
    email: "",
    latitude: place.latitude || null,
    longitude: place.longitude || null,
    mapsUrl: place.link || "",
    source: "Serper Places",
    sourceId: place.cid || place.link || place.title || "",
    rating: Number(place.rating || 0),
    reviews: Number(place.ratingCount || place.reviews || 0),
    description: place.category || ""
  }));
  return {
    leads: [...placeLeads, ...organicLeads].filter(lead => lead.business && (lead.website || lead.phone || lead.address)),
    cached: false,
    source: "Serper Search"
  };
}

async function findOfficialWebsite(lead = {}) {
  if (!configured() || !lead.business) return lead;
  const cityState = [lead.city, lead.state].filter(Boolean).join(" ");
  const query = `"${lead.business}" ${cityState} official website ${lead.trade || ""}`;
  const payload = await serperSearch(query, { num: 8 });
  const results = payload?.organic || [];
  const official = results.find(result => result.link && !isDirectoryUrl(result.link));
  const facebook = results.find(result => /facebook\.com/i.test(result.link || ""));
  if (official?.link) {
    return {
      ...lead,
      website: lead.website && !isDirectoryUrl(lead.website) ? lead.website : official.link,
      serperWebsiteSource: official.link
    };
  }
  if (!lead.facebook && facebook?.link) {
    return { ...lead, facebook: facebook.link, website: lead.website || facebook.link, serperWebsiteSource: facebook.link };
  }
  return lead;
}

async function enrichWithSerperWebsites(leads = [], { limit = 12 } = {}) {
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
  enrichWithSerperWebsites,
  searchSerper
};
