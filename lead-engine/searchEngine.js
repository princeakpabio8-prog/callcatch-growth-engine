const { MemoryCache } = require("./cache");
const crypto = require("crypto");
const { geocodeArea } = require("./providers/nominatim");
const { searchOpenStreetMap } = require("./providers/openstreetmap");
const { configured: braveConfigured, enrichWithBraveWebsites, searchBrave } = require("./providers/braveSearch");
const { configured: serperConfigured, enrichWithSerperWebsites, searchSerper } = require("./providers/serperSearch");
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

function emailIdentity(value = "") {
  return String(value || "").trim().toLowerCase();
}

function websiteIdentity(value = "") {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, "")
    .replace(/^www\./, "")
    .replace(/\/$/, "");
}

function companyIdentity(lead = {}) {
  return normalizeText(lead.business || "")
    ? `${normalizeText(lead.business)}|${normalizeText(lead.city || lead.area)}`
    : "";
}

function contactedLead(lead = {}) {
  return Boolean(
    (lead.sentEmails || []).length
    || lead.lastContact
    || (lead.replies || []).length
    || ["Contacted", "Follow-up", "Demo Scheduled", "Trial Started", "Customer", "Lost"].includes(lead.stage || "")
  );
}

async function existingProspectIndex() {
  try {
    const state = await readStore();
    const emails = new Set();
    const websites = new Set();
    const companies = new Set();
    for (const lead of state.leads || []) {
      if (lead.email) emails.add(emailIdentity(lead.email));
      if (lead.website) websites.add(websiteIdentity(lead.website));
      const company = companyIdentity(lead);
      if (company) companies.add(company);
      for (const sent of lead.sentEmails || []) {
        const sentEmail = emailIdentity(sent.to || sent.recipient || "");
        if (sentEmail) emails.add(sentEmail);
      }
    }
    return { emails, websites, companies };
  } catch {
    return { emails: new Set(), websites: new Set(), companies: new Set() };
  }
}

function matchesExistingProspect(lead = {}, index) {
  const email = emailIdentity(lead.email);
  const website = websiteIdentity(lead.website);
  const company = companyIdentity(lead);
  return Boolean(
    (email && index.emails.has(email))
    || (website && index.websites.has(website))
    || (company && index.companies.has(company))
  );
}

function existingProspectFingerprint(index) {
  const hash = crypto.createHash("sha1");
  hash.update([...index.emails].sort().join("|"));
  hash.update([...index.websites].sort().join("|"));
  hash.update([...index.companies].sort().join("|"));
  return hash.digest("hex").slice(0, 12);
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

function researchUrl(lead) {
  return lead.website || lead.facebook || "";
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

function normalizeCountry(value = "") {
  const key = String(value || "").trim().toLowerCase();
  if (["ca", "canada"].includes(key)) return "CA";
  if (["uk", "gb", "united kingdom"].includes(key)) return "GB";
  if (["eu", "europe"].includes(key)) return "EU";
  return "US";
}

function countryLabel(code = "US") {
  const labels = {
    US: "United States",
    CA: "Canada",
    GB: "United Kingdom",
    EU: "Europe"
  };
  return labels[normalizeCountry(code)] || "United States";
}

function isUnitedStates(country = "US") {
  return normalizeCountry(country) === "US";
}

function suggestedMarkets({ country = "US", trade = "HVAC" } = {}) {
  const markets = {
    US: [
      ["Houston", "TX"], ["Phoenix", "AZ"], ["Miami", "FL"], ["Atlanta", "GA"], ["Charlotte", "NC"], ["Tampa", "FL"],
      ["Orlando", "FL"], ["Nashville", "TN"], ["Denver", "CO"], ["Chicago", "IL"], ["Dallas", "TX"], ["Los Angeles", "CA"]
    ],
    CA: [
      ["Toronto", "ON"], ["Vancouver", "BC"], ["Calgary", "AB"], ["Edmonton", "AB"], ["Ottawa", "ON"], ["Mississauga", "ON"]
    ],
    GB: [
      ["London", ""], ["Manchester", ""], ["Birmingham", ""], ["Leeds", ""], ["Bristol", ""], ["Glasgow", ""]
    ],
    EU: [
      ["Dublin", "Ireland"], ["Amsterdam", "Netherlands"], ["Berlin", "Germany"], ["Munich", "Germany"], ["Paris", "France"], ["Madrid", "Spain"], ["Barcelona", "Spain"], ["Stockholm", "Sweden"]
    ]
  };
  return (markets[normalizeCountry(country)] || markets.US).map(([city, state]) => ({
    city,
    state,
    country: normalizeCountry(country),
    reason: `${trade} demand and service-call volume are usually strong in this market.`
  }));
}

async function mapInBatches(items, batchSize, mapper) {
  const output = [];
  for (let index = 0; index < items.length; index += batchSize) {
    const batch = items.slice(index, index + batchSize);
    output.push(...await Promise.all(batch.map(mapper)));
  }
  return output;
}

function withTimeout(promise, ms, label = "Operation") {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error(`${label} timed out`)), ms))
  ]);
}

function enrichLead(lead) {
  const confidence = confidenceScore(lead);
  const opportunity = opportunityScore(lead);
  const base = {
    business: lead.business || "",
    trade: lead.trade || "Home Services",
    city: lead.city || "",
    state: lead.state || "",
    country: lead.country || "",
    countryCode: lead.countryCode || "",
    area: lead.area || [lead.city, lead.state].filter(Boolean).join(", "),
    phone: lead.phone || "",
    website: lead.website || lead.facebook || "",
    facebook: lead.facebook || "",
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
  const candidates = [...leads]
    .sort((a, b) => {
      const aHasEmail = a.email ? 1 : 0;
      const bHasEmail = b.email ? 1 : 0;
      const aHasWebsite = a.website ? 1 : 0;
      const bHasWebsite = b.website ? 1 : 0;
      return (bHasEmail - aHasEmail) || (bHasWebsite - aHasWebsite) || (b.aiLeadQualityScore - a.aiLeadQualityScore);
    })
    .slice(0, Math.min(Math.max(count * 2, 8), 12));

  const researched = await mapInBatches(candidates, 5, async lead => {
    const url = researchUrl(lead);
    if (!url) {
      return { ...lead, researchDepth: "listing-only", deepQualityScore: deepQualityScore(lead) };
    }
    try {
      const scan = await withTimeout(scanWebsite(url), 9000, `Website research for ${lead.business}`);
      const email = lead.email || (scan.emails || [])[0] || "";
      const phone = lead.phone || (scan.phones || [])[0] || "";
      const enriched = enrichProspect({ ...lead, email, phone }, scan);
      return {
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
      };
    } catch (error) {
      errors.push(`Website research failed for ${lead.business}: ${error.message}`);
      return { ...lead, researchDepth: "listing-only", deepQualityScore: deepQualityScore(lead) };
    }
  });

  const emailReady = researched.filter(lead => lead.email);
  const needsEmail = researched.filter(lead => !lead.email);
  return [...emailReady, ...needsEmail]
    .sort((a, b) =>
      (b.email ? 1 : 0) - (a.email ? 1 : 0)
      || (b.deepQualityScore || 0) - (a.deepQualityScore || 0)
      || (b.confidenceScore || 0) - (a.confidenceScore || 0)
    )
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
  const country = normalizeCountry(params.country);
  try {
    location = await geocodeArea(params.area, { country });
  } catch (error) {
    const fallback = isUnitedStates(country) ? fallbackLocation({ area: params.area, city: params.city, state: params.state }) : null;
    if (!fallback) {
      errors.push(`Location lookup failed for "${params.area}" in ${countryLabel(country)}: ${error.message}`);
      location = {
        city: params.city || "",
        state: params.state || "",
        displayName: params.area,
        country: countryLabel(country),
        countryCode: country,
        source: "unresolved"
      };
    } else {
      location = fallback;
      errors.push(`Nominatim unavailable, used local fallback for ${fallback.city}, ${fallback.state}: ${error.message}`);
    }
  }
  const providers = [];
  if (location.bbox) {
    providers.push(searchOpenStreetMap({
      trade: params.trade,
      location,
      count: params.count
    }));
  } else {
    errors.push("Map search skipped because the market could not be geocoded; web search providers will still run.");
  }
  if (braveConfigured()) {
    providers.push(searchBrave({
      trade: params.trade,
      location,
      count: params.count
    }));
  }
  if (serperConfigured()) {
    providers.push(searchSerper({
      trade: params.trade,
      location,
      count: params.count
    }));
  }

  const settled = await Promise.allSettled(providers);
  const leads = [];
  let cached = false;

  for (const result of settled) {
    if (result.status === "fulfilled") {
      cached = cached || Boolean(result.value.cached);
      leads.push(...result.value.leads);
    } else {
      errors.push(`Lead provider failed: ${result.reason.message}`);
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
  return String(input.area || "").trim() || countryLabel(input.country || input.countryCode || "US");
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
  const country = normalizeCountry(input.country || input.countryCode || "US");
  const radius = Number(input.radius || 25);
  const area = buildArea(input);
  const count = Math.max(1, Math.min(Number(input.count) || 10, 50));
  const wantsDeepResearch = input.deepResearch === true;
  const existingProspects = await existingProspectIndex();
  const key = JSON.stringify({
    trade,
    country,
    area: area.toLowerCase(),
    radius,
    count,
    minRating: input.minRating || 0,
    maxReviews: input.maxReviews || 0,
    deepResearch: wantsDeepResearch,
    existingProspects: existingProspectFingerprint(existingProspects)
  });

  const cached = cache.get(key);
  if (cached) return { ...cached, cached: true };

  const providerResult = await runProviders({ trade, area, state: input.state, city: input.city, country, count: Math.min(count * 3, 60) });
  const rawLeads = dedupe(providerResult.leads).map(enrichLead);
  let skippedExisting = 0;
  let leads = applyFilters(rawLeads, input)
    .filter(lead => {
      if (!matchesExistingProspect(lead, existingProspects)) return true;
      skippedExisting += 1;
      return false;
    })
    .sort((a, b) => b.aiLeadQualityScore - a.aiLeadQualityScore)
    .slice(0, Math.max(count * 4, count));
  if (!leads.length && rawLeads.length && skippedExisting) {
    providerResult.errors.push(`Skipped ${skippedExisting} prospect${skippedExisting === 1 ? "" : "s"} already in CRM or Pipeline for this market. Try the suggested markets or another nearby city.`);
  }
  if (serperConfigured()) {
    leads = await withTimeout(
      enrichWithSerperWebsites(leads, { limit: Math.min(8, Math.max(count, 4)) }),
      12000,
      "Serper website enrichment"
    ).catch(error => {
      providerResult.errors.push(error.message);
      return leads;
    });
    leads = dedupe(leads).map(enrichLead);
  } else if (braveConfigured()) {
    leads = await enrichWithBraveWebsites(leads, { limit: Math.min(12, Math.max(count * 2, 8)) });
    leads = dedupe(leads).map(enrichLead);
  }
  const beforeDeepResearch = leads.length;
  leads = !wantsDeepResearch
    ? leads.sort((a, b) => (b.email ? 1 : 0) - (a.email ? 1 : 0) || b.aiLeadQualityScore - a.aiLeadQualityScore).slice(0, count)
    : await deepResearchLeads(leads, { count, errors: providerResult.errors });
  if (!leads.length && beforeDeepResearch) {
    providerResult.errors.push(`Deep research checked ${beforeDeepResearch} candidate businesses but could not keep usable prospects. Try a nearby city, a larger radius, or another trade.`);
  }
  let source = serperConfigured()
    ? "OpenStreetMap + Nominatim + Serper"
    : braveConfigured()
      ? "OpenStreetMap + Nominatim + Brave Search"
      : "OpenStreetMap + Nominatim";
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
      country,
      countryLabel: countryLabel(country),
      deepResearch: wantsDeepResearch,
      serperEnabled: serperConfigured(),
      braveEnabled: braveConfigured(),
      candidatesResearched: beforeDeepResearch,
      emailReadyOnly: false,
      emailReady: leads.filter(lead => lead.email).length,
      needsEmail: leads.filter(lead => !lead.email).length,
      skippedContacted: skippedExisting,
      skippedExisting,
      quality: leads.length >= count ? "strong" : leads.length > 0 ? "partial" : "no-results",
      suggestions: suggestedMarkets({ country, trade }).slice(0, 6)
    }
  };

  cache.set(key, payload);
  return payload;
}

module.exports = { searchLeads };
