const { MemoryCache } = require("./cache");
const { geocodeArea } = require("./providers/nominatim");
const { searchOpenStreetMap } = require("./providers/openstreetmap");
const { enrichProspect } = require("./prospectIntelligence");
const { fallbackLocation } = require("./usLocations");

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
    if (!fallback) throw error;
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

async function searchLeads(input = {}) {
  const trade = input.trade || "HVAC";
  const radius = Number(input.radius || 25);
  const area = [input.zip || input.area, input.state].filter(Boolean).join(", ") || "United States";
  const count = Math.max(1, Math.min(Number(input.count) || 10, 50));
  const key = JSON.stringify({
    trade,
    area: area.toLowerCase(),
    radius,
    count,
    minRating: input.minRating || 0,
    maxReviews: input.maxReviews || 0
  });

  const cached = cache.get(key);
  if (cached) return { ...cached, cached: true };

  const providerResult = await runProviders({ trade, area, state: input.state, city: input.city, count });
  const leads = applyFilters(dedupe(providerResult.leads).map(enrichLead), input)
    .sort((a, b) => b.aiLeadQualityScore - a.aiLeadQualityScore)
    .slice(0, count);

  const payload = {
    leads,
    source: "OpenStreetMap + Nominatim",
    count: leads.length,
    cached: providerResult.cached,
    errors: providerResult.errors,
    search: {
      trade,
      area,
      radius,
      city: providerResult.location.city,
      state: providerResult.location.state,
      quality: leads.length >= count ? "strong" : leads.length > 0 ? "partial" : "no-results"
    }
  };

  cache.set(key, payload);
  return payload;
}

module.exports = { searchLeads };
