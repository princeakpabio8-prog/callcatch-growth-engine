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

function countryForBrave(location = {}) {
  const value = String(location.countryCode || location.country || "").trim().toLowerCase();
  if (["ca", "canada"].includes(value)) return "CA";
  if (["gb", "uk", "united kingdom"].includes(value)) return "GB";
  if (["au", "australia"].includes(value)) return "AU";
  if (["de", "germany"].includes(value)) return "DE";
  if (["fr", "france"].includes(value)) return "FR";
  if (["es", "spain"].includes(value)) return "ES";
  if (["ie", "ireland"].includes(value)) return "IE";
  if (["nl", "netherlands"].includes(value)) return "NL";
  if (["eu", "europe"].includes(value)) return "GB";
  return "US";
}

function unique(values = []) {
  return [...new Set(values.filter(Boolean).map(value => String(value).replace(/\s+/g, " ").trim()).filter(Boolean))];
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

async function braveSearch(query, { count = 10, local = true, country = "US", offset = 0 } = {}) {
  if (!configured()) return null;
  const key = `brave:${country}:${query}:${count}:${local}:${offset}`;
  const cached = cache.get(key);
  if (cached) return cached;

  const url = new URL(BRAVE_ENDPOINT);
  url.searchParams.set("q", query);
  url.searchParams.set("country", country || "US");
  url.searchParams.set("search_lang", "en");
  url.searchParams.set("ui_lang", country === "GB" ? "en-GB" : "en-US");
  url.searchParams.set("safesearch", "moderate");
  url.searchParams.set("count", String(Math.max(1, Math.min(Number(count) || 10, 20))));
  if (Number(offset) > 0) url.searchParams.set("offset", String(Math.max(0, Number(offset) || 0)));
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

function nearbyMarkets(location = {}) {
  const city = String(location.city || "").trim();
  const state = String(location.state || "").trim();
  const country = countryForBrave(location);
  const metros = {
    "US:dallas": ["Dallas", "Fort Worth", "Arlington", "Plano", "Irving"],
    "US:houston": ["Houston", "Sugar Land", "The Woodlands", "Pasadena", "Pearland"],
    "US:phoenix": ["Phoenix", "Mesa", "Scottsdale", "Glendale", "Tempe"],
    "US:miami": ["Miami", "Fort Lauderdale", "Hialeah", "Hollywood", "Doral"],
    "CA:toronto": ["Toronto", "Mississauga", "Brampton", "Vaughan", "Markham"],
    "GB:london": ["London", "Croydon", "Wembley", "Ealing", "Ilford"],
    "GB:manchester": ["Manchester", "Salford", "Stockport", "Bolton", "Oldham"],
    "DE:berlin": ["Berlin", "Potsdam", "Spandau", "Charlottenburg", "Neukolln"]
  };
  const key = `${country}:${city.toLowerCase()}`;
  const expanded = metros[key] || [city];
  return unique(expanded.map(item => [item, state].filter(Boolean).join(" "))).slice(0, 5);
}

function buildBraveDiscoveryQueries({ trade, location, maxQueries = 10 } = {}) {
  const { getTradeConfig } = require("../trades");
  const config = getTradeConfig(trade);
  const terms = unique([
    trade,
    ...(config.searchTerms || []),
    `${trade} company`,
    `${trade} contractor`
  ]).slice(0, 6);
  const markets = nearbyMarkets(location);
  const primaryMarket = markets[0] || [location.city, location.state].filter(Boolean).join(" ") || location.displayName || "";
  const queryTemplates = [
    term => `${term} ${primaryMarket} contact email`,
    term => `${term} ${primaryMarket} contact`,
    term => `${term} ${primaryMarket} website`,
    term => `emergency ${term} ${primaryMarket}`,
    term => `${term} near ${primaryMarket}`,
    term => `${term} ${markets[1] || primaryMarket} contact email`,
    term => `${term} ${markets[2] || primaryMarket} website`
  ];
  const queries = [];
  for (const term of terms) {
    for (const template of queryTemplates) {
      queries.push(template(term));
      if (queries.length >= maxQueries) return unique(queries).slice(0, maxQueries);
    }
  }
  return unique(queries).slice(0, maxQueries);
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

async function searchBrave({ trade, location, count, maxQueries = 8, maxPages = 2 }) {
  if (!configured()) return { leads: [], cached: false, disabled: true };
  const country = countryForBrave(location);
  const queries = buildBraveDiscoveryQueries({ trade, location, maxQueries });
  const leads = [];
  const failures = [];
  const queryDiagnostics = [];
  const targetRaw = Math.min(Math.max((Number(count) || 10) * 5, 60), 180);

  for (const query of queries) {
    for (let page = 0; page < Math.max(1, Math.min(Number(maxPages) || 1, 3)); page += 1) {
      const offset = page * 20;
      try {
        const payload = await braveSearch(query, { count: 20, local: true, country, offset });
        const locations = payload?.locations?.results || [];
        const web = payload?.web?.results || [];
        const normalized = [
          ...locations.map(result => normalizeLocationResult(result, { trade, location })),
          ...web.map(result => normalizeWebResult(result, { trade, location }))
        ].filter(lead => lead.business && (lead.website || lead.phone || lead.address));
        leads.push(...normalized);
        queryDiagnostics.push({ query, page: page + 1, returned: normalized.length });
        if (!normalized.length) break;
        if (leads.length >= targetRaw) {
          return {
            leads,
            cached: false,
            source: "Brave Search",
            diagnostics: {
              country,
              queriesAttempted: queryDiagnostics.length,
              queryResults: queryDiagnostics,
              failures,
              stoppedReason: "raw_target_reached"
            }
          };
        }
      } catch (error) {
        failures.push({ query, page: page + 1, error: error.message });
        break;
      }
    }
  }

  return {
    leads,
    cached: false,
    source: "Brave Search",
    diagnostics: {
      country,
      queriesAttempted: queryDiagnostics.length,
      queryResults: queryDiagnostics,
      failures,
      stoppedReason: failures.length && !leads.length ? "provider_failed" : "search_space_exhausted"
    }
  };
}

async function findOfficialWebsite(lead = {}) {
  if (!configured() || !lead.business) return lead;
  const cityState = [lead.city, lead.state].filter(Boolean).join(" ");
  const query = `"${lead.business}" ${cityState} official website ${lead.trade || ""}`;
  const payload = await braveSearch(query, { count: 5, local: false, country: countryForBrave(lead) });
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
  buildBraveDiscoveryQueries,
  countryForBrave,
  configured,
  enrichWithBraveWebsites,
  searchBrave
};
