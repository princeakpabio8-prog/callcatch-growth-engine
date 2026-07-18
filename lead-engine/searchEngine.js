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
const DISCOVERY_LIMITS = {
  finalCountMax: 50,
  providerRequestMax: 120,
  initialCandidateMax: 220,
  websiteScanConcurrency: 4,
  websiteScanTimeoutMs: 12000,
  maxProviderRunMs: 35000,
  deepResearchMax: 12
};
const DIRECTORY_EMAIL_DOMAINS = [
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
const DISPOSABLE_EMAIL_DOMAINS = [
  "mailinator.com",
  "guerrillamail.com",
  "10minutemail.com",
  "tempmail.com",
  "example.com",
  "example.org",
  "example.net",
  "domain.com"
];

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

function emailDomain(value = "") {
  return String(value || "").trim().toLowerCase().split("@").pop() || "";
}

function websiteDomain(value = "") {
  try {
    return new URL(/^https?:\/\//i.test(value) ? value : `https://${value}`).hostname.replace(/^www\./, "").toLowerCase();
  } catch {
    return "";
  }
}

function isUsableBusinessEmail(value = "", lead = {}) {
  const email = String(value || "").trim().toLowerCase();
  if (!/^[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}$/i.test(email)) return false;
  const local = email.split("@")[0] || "";
  const domain = emailDomain(email);
  if (!domain || DISPOSABLE_EMAIL_DOMAINS.some(item => domain === item || domain.endsWith(`.${item}`))) return false;
  if (DIRECTORY_EMAIL_DOMAINS.some(item => domain === item || domain.endsWith(`.${item}`))) return false;
  if (/^(no-?reply|do-?not-?reply|donotreply|noreply|example|test|placeholder|fake|invalid)$/i.test(local)) return false;
  if (/(example|placeholder|test)@/i.test(email)) return false;
  const siteDomain = websiteDomain(lead.website || lead.facebook || "");
  if (siteDomain && DIRECTORY_EMAIL_DOMAINS.some(item => siteDomain === item || siteDomain.endsWith(`.${item}`))) return true;
  return true;
}

function preferredEmail(emails = [], lead = {}) {
  const rolePrefixes = /^(info|hello|contact|office|sales|bookings|booking|support|service|admin|reception|dispatch|team|estimate|quotes?)@/i;
  const usable = [...new Set(emails.map(email => String(email || "").trim().toLowerCase()))]
    .filter(email => isUsableBusinessEmail(email, lead));
  return usable.find(email => rolePrefixes.test(email)) || usable[0] || "";
}

function hasEnoughDiscoveryEvidence(lead = {}, scan = {}) {
  return Boolean(
    lead.business
    && lead.email
    && (
      scan.ok
      || lead.website
      || lead.phone
      || lead.address
      || lead.description
    )
  );
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
  if (!key) return "US";
  if (["us", "usa", "united states", "united states of america"].includes(key)) return "US";
  if (["ca", "canada"].includes(key)) return "CA";
  if (["uk", "gb", "united kingdom"].includes(key)) return "GB";
  if (["au", "australia"].includes(key)) return "AU";
  if (["de", "germany"].includes(key)) return "DE";
  if (["fr", "france"].includes(key)) return "FR";
  if (["es", "spain"].includes(key)) return "ES";
  if (["ie", "ireland"].includes(key)) return "IE";
  if (["nl", "netherlands"].includes(key)) return "NL";
  if (["eu", "europe"].includes(key)) return "EU";
  return "UNSUPPORTED";
}

function countryLabel(code = "US") {
  const labels = {
    US: "United States",
    CA: "Canada",
    GB: "United Kingdom",
    AU: "Australia",
    DE: "Germany",
    FR: "France",
    ES: "Spain",
    IE: "Ireland",
    NL: "Netherlands",
    EU: "Europe",
    UNSUPPORTED: "Unsupported"
  };
  return labels[normalizeCountry(code)] || "Unsupported";
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
    AU: [
      ["Sydney", "NSW"], ["Melbourne", "VIC"], ["Brisbane", "QLD"], ["Perth", "WA"], ["Adelaide", "SA"]
    ],
    DE: [
      ["Berlin", ""], ["Munich", ""], ["Hamburg", ""], ["Frankfurt", ""], ["Cologne", ""]
    ],
    FR: [
      ["Paris", ""], ["Lyon", ""], ["Marseille", ""], ["Toulouse", ""], ["Nice", ""]
    ],
    ES: [
      ["Madrid", ""], ["Barcelona", ""], ["Valencia", ""], ["Seville", ""], ["Zaragoza", ""]
    ],
    IE: [
      ["Dublin", ""], ["Cork", ""], ["Galway", ""], ["Limerick", ""], ["Waterford", ""]
    ],
    NL: [
      ["Amsterdam", ""], ["Rotterdam", ""], ["Utrecht", ""], ["The Hague", ""], ["Eindhoven", ""]
    ],
    EU: [
      ["Dublin", "Ireland"], ["Amsterdam", "Netherlands"], ["Berlin", "Germany"], ["Munich", "Germany"], ["Paris", "France"], ["Madrid", "Spain"], ["Barcelona", "Spain"], ["Stockholm", "Sweden"]
    ]
  };
  const normalized = normalizeCountry(country);
  if (!markets[normalized]) return [];
  return markets[normalized].map(([city, state]) => ({
    city,
    state,
    country: normalized,
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
  const diagnostics = {
    providerInputs: {
      trade: params.trade,
      area: params.area,
      country: normalizeCountry(params.country),
      requestedCount: Number(params.count) || 0
    },
    providersAttempted: [],
    providers: {},
    providerAvailability: {
      brave: braveConfigured(),
      serper: serperConfigured(),
      openstreetmap: false
    },
    reducedCapacityMode: !braveConfigured(),
    selectedProvider: "",
    fallbackUsed: false,
    locationResolved: false,
    locationSource: "",
    mapSearchSkipped: false
  };
  const country = normalizeCountry(params.country);
  try {
    location = await geocodeArea(params.area, { country });
    diagnostics.locationResolved = true;
    diagnostics.locationSource = location.source || "nominatim";
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
      diagnostics.locationSource = "unresolved";
    } else {
      location = fallback;
      errors.push(`Nominatim unavailable, used local fallback for ${fallback.city}, ${fallback.state}: ${error.message}`);
      diagnostics.locationResolved = true;
      diagnostics.locationSource = "local-us-fallback";
    }
  }
  const providers = [];
  if (braveConfigured()) {
    diagnostics.providersAttempted.push("brave");
    providers.push(withTimeout(searchBrave({
      trade: params.trade,
      location,
      count: params.count,
      maxQueries: params.maxQueries,
      maxPages: params.maxPages
    }), DISCOVERY_LIMITS.maxProviderRunMs, "Brave search"));
  }
  if (location.bbox) {
    diagnostics.providerAvailability.openstreetmap = true;
    diagnostics.providersAttempted.push("openstreetmap");
    providers.push(withTimeout(searchOpenStreetMap({
      trade: params.trade,
      location,
      count: params.count
    }), 12000, "OpenStreetMap search"));
  } else {
    errors.push("Map search skipped because the market could not be geocoded; web search providers will still run.");
    diagnostics.mapSearchSkipped = true;
  }
  if (serperConfigured()) {
    diagnostics.providersAttempted.push("serper");
    providers.push(withTimeout(searchSerper({
      trade: params.trade,
      location,
      count: params.count
    }), 12000, "Serper search"));
  }

  const settled = await Promise.allSettled(providers);
  const leads = [];
  let cached = false;

  for (const [index, result] of settled.entries()) {
    const providerName = diagnostics.providersAttempted[index] || `provider-${index + 1}`;
    if (result.status === "fulfilled") {
      cached = cached || Boolean(result.value.cached);
      leads.push(...result.value.leads);
      diagnostics.providers[providerName] = {
        status: "fulfilled",
        returned: (result.value.leads || []).length,
        cached: Boolean(result.value.cached),
        source: result.value.source || providerName,
        diagnostics: result.value.diagnostics || {}
      };
      if (!diagnostics.selectedProvider && (result.value.leads || []).length) diagnostics.selectedProvider = providerName;
    } else {
      errors.push(`Lead provider failed: ${result.reason.message}`);
      diagnostics.providers[providerName] = {
        status: "failed",
        returned: 0,
        error: result.reason.message
      };
    }
  }

  diagnostics.rawProviderLeads = leads.length;
  diagnostics.fallbackUsed = Boolean(braveConfigured() && diagnostics.providers.brave?.status === "failed" && leads.length);
  if (!diagnostics.selectedProvider && leads.length) diagnostics.selectedProvider = "mixed";
  return { leads, errors, cached, location, diagnostics };
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

function newReadinessDiagnostics(target) {
  return {
    target,
    candidatesInspected: 0,
    websitesChecked: 0,
    emailsFound: 0,
    emailsRejected: 0,
    outreachReady: 0,
    skipped: {
      duplicate: 0,
      existing: 0,
      noWebsite: 0,
      noEmail: 0,
      invalidEmail: 0,
      insufficientEvidence: 0,
      scanFailed: 0
    },
    targetReached: false,
    exhaustionReason: ""
  };
}

async function inspectCandidateForEmail(lead, errors, readiness) {
  readiness.candidatesInspected += 1;
  let scan = {};
  const candidateEmails = [lead.email].filter(Boolean);
  const url = researchUrl(lead);
  if (!url && !candidateEmails.length) {
    readiness.skipped.noWebsite += 1;
    return null;
  }

  if (url) {
    readiness.websitesChecked += 1;
    scan = await withTimeout(scanWebsite(url), DISCOVERY_LIMITS.websiteScanTimeoutMs, `Website email scan for ${lead.business}`)
      .catch(error => {
        readiness.skipped.scanFailed += 1;
        errors.push(`Website email scan failed for ${lead.business}: ${error.message}`);
        return { ok: false, emails: [], error: error.message };
      });
    candidateEmails.push(...(scan.emails || []));
  }

  readiness.emailsFound += candidateEmails.filter(Boolean).length;
  const email = preferredEmail(candidateEmails, lead);
  if (!email) {
    if (candidateEmails.length) readiness.skipped.invalidEmail += 1;
    else readiness.skipped.noEmail += 1;
    readiness.emailsRejected += candidateEmails.filter(Boolean).length;
    return null;
  }

  const enriched = enrichProspect({ ...lead, email, phone: lead.phone || (scan.phones || [])[0] || "" }, scan);
  if (!hasEnoughDiscoveryEvidence(enriched, scan)) {
    readiness.skipped.insufficientEvidence += 1;
    return null;
  }

  return {
    ...enriched,
    email,
    websiteIntelligence: enriched.websiteIntelligence || scan,
    researchDepth: scan.researchDepth || enriched.researchDepth || "email-ready",
    discoveryStatus: "outreach-ready"
  };
}

async function collectOutreachReadyLeads(candidates, { count, errors }) {
  const readiness = newReadinessDiagnostics(count);
  const selected = [];
  const seenEmails = new Set();
  const maxCandidates = Math.min(Math.max(count * 10, 60), DISCOVERY_LIMITS.initialCandidateMax);
  const queue = candidates.slice(0, maxCandidates);

  for (let index = 0; index < queue.length && selected.length < count; index += DISCOVERY_LIMITS.websiteScanConcurrency) {
    const batch = queue.slice(index, index + DISCOVERY_LIMITS.websiteScanConcurrency);
    const inspected = await Promise.all(batch.map(lead => inspectCandidateForEmail(lead, errors, readiness)));
    for (const lead of inspected.filter(Boolean)) {
      const email = emailIdentity(lead.email);
      if (!email || seenEmails.has(email)) {
        readiness.skipped.duplicate += 1;
        continue;
      }
      seenEmails.add(email);
      selected.push(lead);
      readiness.outreachReady = selected.length;
      if (selected.length >= count) break;
    }
  }

  readiness.outreachReady = selected.length;
  readiness.targetReached = selected.length >= count;
  readiness.exhaustionReason = readiness.targetReached
    ? "target_reached"
    : queue.length >= maxCandidates
      ? "candidate_safety_cap_reached"
      : "provider_search_space_exhausted";
  return { leads: selected, readiness };
}

async function searchLeads(input = {}) {
  const trade = input.trade || "HVAC";
  const country = normalizeCountry(input.country || input.countryCode || "US");
  const radius = Number(input.radius || 25);
  const area = buildArea(input);
  const count = Math.max(1, Math.min(Number(input.count) || 10, DISCOVERY_LIMITS.finalCountMax));
  const wantsDeepResearch = input.deepResearch === true;
  if (country === "UNSUPPORTED") {
    return {
      leads: [],
      source: "Unsupported country",
      count: 0,
      cached: false,
      errors: [`Unsupported country "${input.country || input.countryCode}". CallCatch did not search the wrong country.`],
      search: {
        trade,
        area,
        radius,
        city: input.city || "",
        state: input.state || "",
        country,
        countryLabel: countryLabel(country),
        deepResearch: wantsDeepResearch,
        serperEnabled: serperConfigured(),
        braveEnabled: braveConfigured(),
        emailReadyOnly: true,
        emailReady: 0,
        needsEmail: 0,
        skippedContacted: 0,
        skippedExisting: 0,
        quality: "unsupported",
        suggestions: []
      },
      diagnostics: {
        providerInputs: { trade, area, country, requestedCount: count },
        providerAvailability: { brave: braveConfigured(), serper: serperConfigured(), openstreetmap: false },
        reducedCapacityMode: !braveConfigured(),
        unsupportedCountry: true,
        funnel: {
          requestedFinalCount: count,
          finalLeads: 0,
          finalEmailReady: 0,
          finalNeedsEmail: 0,
          targetReached: false,
          exhaustionReason: "unsupported_country"
        },
        likelyBottlenecks: ["Unsupported country was rejected instead of silently searching the United States"]
      }
    };
  }
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

  const providerRequestCount = Math.min(Math.max(count * 6, 40), DISCOVERY_LIMITS.providerRequestMax);
  const providerResult = await runProviders({
    trade,
    area,
    state: input.state,
    city: input.city,
    country,
    count: providerRequestCount,
    maxQueries: Math.min(Math.max(Math.ceil(count / 3), 6), 12),
    maxPages: 2
  });
  const rawProviderCount = providerResult.leads.length;
  const dedupedProviderLeads = dedupe(providerResult.leads);
  const rawLeads = dedupedProviderLeads.map(enrichLead);
  let skippedExisting = 0;
  const afterRatingFilters = applyFilters(rawLeads, input);
  const afterExistingFilterLeads = afterRatingFilters
    .filter(lead => {
      if (!matchesExistingProspect(lead, existingProspects)) return true;
      skippedExisting += 1;
      return false;
    })
    .sort((a, b) => b.aiLeadQualityScore - a.aiLeadQualityScore);
  let leads = afterExistingFilterLeads.slice(0, DISCOVERY_LIMITS.initialCandidateMax);
  if (!leads.length && rawLeads.length && skippedExisting) {
    providerResult.errors.push(`Skipped ${skippedExisting} prospect${skippedExisting === 1 ? "" : "s"} already in CRM or Pipeline for this market. Try the suggested markets or another nearby city.`);
  }
  if (serperConfigured()) {
    leads = await withTimeout(
      enrichWithSerperWebsites(leads, { limit: Math.min(Math.max(count * 3, 12), 36) }),
      12000,
      "Serper website enrichment"
    ).catch(error => {
      providerResult.errors.push(error.message);
      return leads;
    });
    leads = dedupe(leads).map(enrichLead);
  } else if (braveConfigured()) {
    leads = await enrichWithBraveWebsites(leads, { limit: Math.min(Math.max(count * 3, 12), 36) });
    leads = dedupe(leads).map(enrichLead);
  }
  const afterWebsiteEnrichment = leads.length;
  const beforeDeepResearch = leads.length;
  const readinessResult = await collectOutreachReadyLeads(leads, { count, errors: providerResult.errors });
  leads = readinessResult.leads;
  if (wantsDeepResearch && leads.length) {
    leads = await deepResearchLeads(leads, { count, errors: providerResult.errors });
  }
  if (!leads.length && beforeDeepResearch) {
    providerResult.errors.push(`Discovery checked ${beforeDeepResearch} candidate businesses but could not find usable business emails. Try a nearby city, broaden the trade, or verify Brave is configured.`);
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
      emailReadyOnly: true,
      emailReady: leads.filter(lead => lead.email).length,
      needsEmail: 0,
      skippedContacted: skippedExisting,
      skippedExisting,
      quality: leads.length >= count ? "strong" : leads.length > 0 ? "partial" : "no-results",
      suggestions: suggestedMarkets({ country, trade }).slice(0, 6)
    },
    diagnostics: {
      ...providerResult.diagnostics,
      funnel: {
        requestedFinalCount: count,
        providerRequestedCount: providerRequestCount,
        rawProviderLeads: rawProviderCount,
        afterProviderDedupe: dedupedProviderLeads.length,
        afterRatingReviewFilters: afterRatingFilters.length,
        skippedExisting,
        afterExistingFilter: afterExistingFilterLeads.length,
        initialCandidateCap: DISCOVERY_LIMITS.initialCandidateMax,
        beforeWebsiteEnrichment: Math.min(afterExistingFilterLeads.length, DISCOVERY_LIMITS.initialCandidateMax),
        websiteEnrichmentLimit: serperConfigured()
          ? Math.min(Math.max(count * 3, 12), 36)
          : braveConfigured()
            ? Math.min(Math.max(count * 3, 12), 36)
            : 0,
        afterWebsiteEnrichment,
        deepResearchRequested: wantsDeepResearch,
        deepResearchCandidateLimit: wantsDeepResearch ? DISCOVERY_LIMITS.deepResearchMax : 0,
        candidatesResearched: beforeDeepResearch,
        ...readinessResult.readiness,
        finalLeads: leads.length,
        finalEmailReady: leads.filter(lead => lead.email).length,
        finalNeedsEmail: 0
      },
      caps: {
        frontendMaxFinalCount: DISCOVERY_LIMITS.finalCountMax,
        providerRequestMax: DISCOVERY_LIMITS.providerRequestMax,
        openStreetMapElementMax: 120,
        serperTermsMax: 3,
        serperPerTermMax: 20,
        bravePerQueryMax: 20,
        websiteEnrichmentMax: serperConfigured() || braveConfigured() ? 36 : 0,
        deepResearchMax: DISCOVERY_LIMITS.deepResearchMax,
        dailyGrowthDefaultSearches: 8,
        dailyGrowthDefaultCountPerSearch: 8
      },
      likelyBottlenecks: [
        !braveConfigured() ? "Reduced-capacity mode: Brave Search is not configured" : "",
        providerRequestCount <= DISCOVERY_LIMITS.providerRequestMax ? "provider candidate request is safely capped before broad market exhaustion" : "",
        serperConfigured() ? "Serper website enrichment is optional and bounded" : "",
        braveConfigured() ? "Brave website enrichment checks a bounded candidate pool" : "",
        wantsDeepResearch ? "Deep research remains capped to protect performance" : "",
        skippedExisting ? "Existing CRM/Pipeline filtering removed candidates before final queue" : "",
        !leads.filter(lead => lead.email).length ? "No usable business emails were found in the inspected search space" : ""
      ].filter(Boolean)
    }
  };

  cache.set(key, payload);
  return payload;
}

module.exports = {
  searchLeads,
  __test: {
    collectOutreachReadyLeads,
    hasEnoughDiscoveryEvidence,
    isUsableBusinessEmail,
    normalizeCountry,
    preferredEmail
  }
};
