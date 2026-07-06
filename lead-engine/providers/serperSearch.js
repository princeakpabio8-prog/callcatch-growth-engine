const { MemoryCache } = require("../cache");
const { RateLimiter } = require("../rateLimiter");
const { getTradeConfig } = require("../trades");

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

function glForLocation(location = {}) {
  const value = String(location.countryCode || location.country || "").toLowerCase();
  if (value.includes("ca") || value.includes("canada")) return "ca";
  if (value.includes("gb") || value.includes("uk") || value.includes("united kingdom")) return "gb";
  if (value.includes("eu") || value.includes("europe")) return "gb";
  return "us";
}

function marketText(location = {}) {
  const country = location.country && !/united states/i.test(location.country) ? location.country : "";
  return [location.city || "", location.state || "", country || location.displayName || ""]
    .filter(Boolean)
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
}

async function serperSearch(query, { num = 10, gl = "us" } = {}) {
  if (!configured()) return null;
  const key = `serper:${gl}:${query}:${num}`;
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
        gl,
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
    country: context.location?.country || "",
    countryCode: context.location?.countryCode || "",
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
  const gl = glForLocation(location);
  const market = marketText(location) || location.displayName || "local area";
  const terms = [trade, ...(getTradeConfig(trade).searchTerms || [])]
    .filter(Boolean)
    .filter((term, index, arr) => arr.findIndex(other => other.toLowerCase() === term.toLowerCase()) === index)
    .slice(0, 3);
  const payloads = await Promise.all(terms.map(term =>
    serperSearch(`${term} companies in ${market}`, { num: Math.min(Number(count) || 10, 20), gl }).catch(error => ({ error: error.message }))
  ));
  const organic = payloads.flatMap(payload => payload?.organic || []);
  const places = payloads.flatMap(payload => payload?.places || []);
  const organicLeads = organic.map(result => resultToLead(result, { trade, location }));
  const placeLeads = places.map(place => ({
    business: cleanTitle(place.title || place.name),
    trade,
    city: location.city || "",
    state: location.state || "",
    country: location.country || "",
    countryCode: location.countryCode || "",
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
  const cityState = [lead.city, lead.state, lead.country && !/united states/i.test(lead.country) ? lead.country : ""].filter(Boolean).join(" ");
  const query = `"${lead.business}" ${cityState} official website ${lead.trade || ""}`;
  const payload = await serperSearch(query, { num: 8, gl: glForLocation(lead) });
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
  let enriched = 0;
  const jobs = leads.map(async lead => {
    if (enriched < limit && (!lead.website || isDirectoryUrl(lead.website))) {
      enriched += 1;
      try {
        return await findOfficialWebsite(lead);
      } catch {}
    }
    return lead;
  });
  return Promise.all(jobs);
}

module.exports = {
  configured,
  enrichWithSerperWebsites,
  searchSerper
};
