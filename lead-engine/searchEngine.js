const { MemoryCache } = require("./cache");
const { geocodeArea } = require("./providers/nominatim");
const { searchOpenStreetMap } = require("./providers/openstreetmap");
const { enrichProspect } = require("./prospectIntelligence");
const { scanWebsite } = require("./websiteScanner");
const { fallbackLocation } = require("./usLocations");
const { readStore } = require("./dataStore");

const cache = new MemoryCache(1000 * 60 * 30);

function normalizeText(value) {
  return String(value || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

function leadKey(lead) {
  const name = normalizeText(lead.business);
  const phone = normalizeText(lead.phone);
  const website = normalizeText(lead.website).replace(/^https? www /, "");
  const city = normalizeText(lead.city || lead.area);
  return phone || website || `${name}|${city}`;
}

function dedupe(leads) {
  const seen = new Set();
  const output = [];
  for (const lead of leads) {
    const key = leadKey(lead);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    output.push(lead);
  }
  return output;
}

function websiteStrength(website) {
  if (!website) return "missing";
  const value = website.toLowerCase();
  if (value.includes("facebook.com") || value.includes("instagram.com") || value.includes("yelp.com")) return "social-only";
  if (value.includes("openstreetmap.org")) return "directory-only";
  return "owned";
}

function confidenceScore(lead) {
  let score = 35;
  if (lead.business) score += 15;
  if (lead.phone) score += 14;
  if (lead.website) score += 10;
  if (lead.email) score += 8;
  if (lead.address) score += 8;
  if (lead.latitude && lead.longitude) score += 6;
  if (lead.source) score += 4;
  return Math.max(0, Math.min(100, score));
}

function opportunityScore(lead) {
  let score = confidenceScore(lead);
  const strength = websiteStrength(lead.website);
  if (strength === "missing") score += 12;
  if (strength === "social-only" || strength === "directory-only") score += 8;
  if (!lead.email) score += 4;
  if (lead.phone && !lead.website) score += 5;
  return Math.max(0, Math.min(100, score));
}

function qualityReason(lead) {
  const reasons = [];
  const strength = websiteStrength(lead.website);
  if (lead.phone) reasons.push("phone available");
  if (lead.email) reasons.push("email available");
  if (strength === "missing") reasons.push("weak online presence: no website listed");
  if (strength === "social-only") reasons.push("weak online presence: social page only");
  if (strength === "directory-only") reasons.push("weak online presence: directory link only");
  if (lead.address) reasons.push("local address available");
  return reasons.join("; ") || "basic public listing match";
}

function deepQualityScore(lead) {
  let score = Number(lead.callCatchFitScore || lead.aiLeadQualityScore || lead.confidenceScore || 0);
  if (lead.email) score += 35;
  if (lead.websiteIntelligence?.researchDepth === "deep") score += 10;
  if (lead.websiteIntelligence?.leadQualitySignals?.length) score += Math.min(14, lead.websiteIntelligence.leadQualitySignals.length * 2);
  if (lead.websiteIntelligence?.emergencyService) score += 8;
  if (lead.websiteIntelligence?.freeEstimate) score += 4;
  if (lead.websiteIntelligence?.careersHiring) score += 3;
  if (lead.websiteIntelligence?.weakSignals?.length) score += 8;
  if (!lead.email) score -= 80;
  return Math.max(0, Math.min(100, Math.round(score)));
}

function enrichLead(lead) {
  const confidence = confidenceScore(lead);
  const opportunity = opportunityScore(lead);
  const base = {
    business: lead.business || "",
    trade: lead.trade || "Home Services",
    city: lead.city || "",
    state: lead.state || "",
    area: lead.area || [lead.city, lead.state].filter(Boolean).join(", "),
    phone: lead.phone || "",
    website: lead.website || "",
    email: lead.email || "",
    address: lead.address || lead.area || "",
    latitude: lead.latitude || null,
    longitude: lead.longitude || null,
    mapsUrl: lead.mapsUrl || lead.osmUrl || "",
    source: lead.source || "Public source",
    confidenceScore: confidence,
    aiLeadQualityScore: opportunity,
    leadQualityReason: qualityReason(lead),
    rating: Number(lead.rating || 0),
    reviews: Number(lead.reviews || 0),
    sourceId: lead.sourceId || ""
  };
  return enrichProspect(base, {});
}

async function deepResearchLeads(leads, { count, errors }) {
  const researched = [];
  const candidates = [...leads]
    .sort((a, b) => {
      const aHasEmail = a.email ? 1 : 0;
      const bHasEmail = b.email ? 1 : 0;
      const aHasWebsite = a.website ? 1 : 0;
      const bHasWebsite = b.website ? 1 : 0;
      return (bHasEmail - aHasEmail) || (bHasWebsite - aHasWebsite) || (b.aiLeadQualityScore - a.aiLeadQualityScore);
    })
    .slice(0, Math.max(count * 4, 16));

  for (const lead of candidates) {
    if (!lead.website) {
      if (lead.email) researched.push({ ...lead, researchDepth: "listing-only", deepQualityScore: deepQualityScore(lead) });
      continue;
    }
    try {
      const scan = await scanWebsite(lead.website);
      const email = lead.email || (scan.emails || [])[0] || "";
      const phone = lead.phone || (scan.phones || [])[0] || "";
      const enriched = enrichProspect({ ...lead, email, phone }, scan);
      researched.push({
        ...enriched,
        owner: enriched.owner || (scan.ownerMentions || [])[0] || "",
        researchDepth: scan.researchDepth || "standard",
        deepQualityScore: deepQualityScore(enriched),
        leadQualityReason: [
          lead.leadQualityReason,
          email ? "public email discovered" : "",
          scan.researchDepth ? `${scan.researchDepth} website research` : "",
          ...(scan.leadQualitySignals || []).slice(0, 5)
        ].filter(Boolean).join("; ")
      });
    } catch (error) {
      errors.push(`Website research failed for ${lead.business}: ${error.message}`);
      if (lead.email) researched.push({ ...lead, researchDepth: "listing-only", deepQualityScore: deepQualityScore(lead) });
    }
  }

  return researched
    .filter(lead => lead.email)
    .sort((a, b) => (b.deepQualityScore || 0) - (a.deepQualityScore || 0))
    .slice(0, count);
}

function applyFilters(leads, { minRating, maxReviews }) {
  const minimum = Number(minRating) || 0;
  const reviewCap = Number(maxReviews) || Number.MAX_SAFE_INTEGER;
  return leads
    .filter(lead => !minimum || !lead.rating || lead.rating >= minimum)
    .filter(lead => !reviewCap || !lead.reviews || lead.reviews <= reviewCap);
}

async function runProviders(params) {
  let location;
  const errors = [];
  try {
    location = await geocodeArea(params.area);
  } catch (error) {
    const fallback = fallbackLocation({ area: params.area, city: params.city, state: params.state });
    if (!fallback) {
      errors.push(`Nominatim unavailable and no local fallback matched "${params.area}": ${error.message}`);
      return {
        leads: [],
        errors,
        cached: false,
        location: {
          city: params.city || "",
          state: params.state || "",
          displayName: params.area,
          source: "unresolved"
        }
      };
    }
    location = fallback;
    errors.push(`Nominatim unavailable, used local fallback for ${fallback.city}, ${fallback.state}: ${error.message}`);
  }
  const providers = [
    searchOpenStreetMap({
      trade: params.trade,
      location,
      count: params.count
    })
  ];

  const settled = await Promise.allSettled(providers);
  const leads = [];
  let cached = false;

  for (const result of settled) {
    if (result.status === "fulfilled") {
      cached = cached || Boolean(result.value.cached);
      leads.push(...result.value.leads);
    } else {
      errors.push(`OpenStreetMap provider failed: ${result.reason.message}`);
    }
  }

  return { leads, errors, cached, location };
}

function normalizeState(value) {
  return String(value || "").trim().toLowerCase();
}

function cityFromArea(area) {
  return String(area || "").split(",")[0].trim().toLowerCase();
}

function buildArea(input) {
  const city = String(input.city || "").trim();
  const state = String(input.state || "").trim();
  const zip = String(input.zip || "").trim();
  if (zip) return [zip, state].filter(Boolean).join(", ");
  if (city) return [city, state].filter(Boolean).join(", ");
  return String(input.area || "").trim() || "United States";
}

async function savedCrmFallback(input, count, errors = []) {
  try {
    const state = await readStore();
    const trade = normalizeText(input.trade);
    const wantedState = normalizeState(input.state);
    const wantedCity = cityFromArea(input.area || input.city);
    const matches = (state.leads || [])
      .filter(lead => lead.email)
      .filter(lead => !trade || normalizeText(lead.trade).includes(trade) || normalizeText(lead.business).includes(trade))
      .filter(lead => !wantedState || normalizeState(lead.state).includes(wantedState) || normalizeText(lead.area).includes(wantedState))
      .filter(lead => !wantedCity || normalizeText(lead.city).includes(wantedCity) || normalizeText(lead.area).includes(wantedCity))
      .sort((a, b) => Number(b.callCatchFitScore || b.aiLeadQualityScore || 0) - Number(a.callCatchFitScore || a.aiLeadQualityScore || 0))
      .slice(0, count);
    if (!matches.length) return [];
    errors.push(`Live public sources were unavailable, so CallCatch returned ${matches.length} matching saved CRM lead${matches.length === 1 ? "" : "s"}.`);
    return matches;
  } catch (error) {
    errors.push(`Saved CRM fallback failed: ${error.message}`);
    return [];
  }
}

async function searchLeads(input = {}) {
  const trade = input.trade || "HVAC";
  const radius = Number(input.radius || 25);
  const area = buildArea(input);
  const count = Math.max(1, Math.min(Number(input.count) || 10, 50));
  const key = JSON.stringify({
    trade,
    area: area.toLowerCase(),
    radius,
    count,
    minRating: input.minRating || 0,
    maxReviews: input.maxReviews || 0,
    deepResearch: input.deepResearch !== false
  });

  const cached = cache.get(key);
  if (cached) return { ...cached, cached: true };

  const providerResult = await runProviders({ trade, area, state: input.state, city: input.city, count: Math.min(count * 4, 80) });
  let leads = applyFilters(dedupe(providerResult.leads).map(enrichLead), input)
    .sort((a, b) => b.aiLeadQualityScore - a.aiLeadQualityScore)
    .slice(0, Math.max(count * 4, count));
  const beforeDeepResearch = leads.length;
  leads = input.deepResearch === false
    ? leads.filter(lead => lead.email).slice(0, count)
    : await deepResearchLeads(leads, { count, errors: providerResult.errors });
  if (!leads.length && beforeDeepResearch) {
    providerResult.errors.push(`Deep research checked ${beforeDeepResearch} candidate businesses but did not find public email-ready prospects. Try a nearby city, a larger radius, or another trade.`);
  }
  let source = "OpenStreetMap + Nominatim";
  if (!leads.length && providerResult.errors.length) {
    leads = await savedCrmFallback({ ...input, trade, area }, count, providerResult.errors);
    if (leads.length) source = "Saved CRM fallback";
  }

  const payload = {
    leads,
    source,
    count: leads.length,
    cached: providerResult.cached,
    errors: providerResult.errors,
    search: {
      trade,
      area,
      radius,
      city: providerResult.location.city,
      state: providerResult.location.state,
      deepResearch: input.deepResearch !== false,
      candidatesResearched: beforeDeepResearch,
      emailReadyOnly: true,
      quality: leads.length >= count ? "strong" : leads.length > 0 ? "partial" : "no-results"
    }
  };

  cache.set(key, payload);
  return payload;
}

module.exports = { searchLeads };
