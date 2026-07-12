const fs = require("fs");
const path = require("path");

const inputSchema = require("../schemas/brain-one-input.json");
const foundationSchema = require("../schemas/brain-one-foundation.json");
const digitalSchema = require("../schemas/brain-one-digital-intelligence.json");
const opportunitiesSchema = require("../schemas/brain-one-opportunities.json");
const strategicSchema = require("../schemas/brain-one-strategic-interpretation.json");
const contactDecisionSchema = require("../schemas/brain-one-contact-decision.json");
const combinedSchema = require("../schemas/brain-one-combined-output.json");

const DEFAULT_MODEL = process.env.NVIDIA_MODEL || "meta/llama-3.1-8b-instruct";
const NVIDIA_URL = process.env.NVIDIA_API_URL || "https://integrate.api.nvidia.com/v1/chat/completions";
const RUNTIME_PROMPT = fs.readFileSync(path.join(__dirname, "..", "brains", "brain-one-runtime.md"), "utf8");
const LEGACY_OUTPUT_REQUIRED = [
  "business_identity",
  "contacts",
  "business_dna",
  "evidence_log",
  "confirmed_facts",
  "inferences",
  "unknowns",
  "digital_health",
  "ai_discoverability",
  "future_readiness",
  "hidden_opportunities",
  "money_left_on_table",
  "ai_opportunity_radar",
  "why_we_chose_you",
  "one_day_action_plan",
  "risks",
  "contact_decision",
  "brain_two_handoff"
];
const BUSINESS_DNA_SCORING_FIELDS = [
  "business_model",
  "primary_services",
  "likely_customer_segments",
  "geographic_market",
  "value_proposition",
  "likely_revenue_drivers",
  "customer_journey",
  "current_digital_maturity",
  "operational_complexity",
  "trust_signals",
  "differentiators",
  "growth_stage"
];

function resolvedNvidiaTimeoutMs(value = process.env.NVIDIA_TIMEOUT_MS) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 180000;
}

function resolvedNvidiaModel(value = process.env.NVIDIA_MODEL) {
  return String(value || DEFAULT_MODEL).trim() || DEFAULT_MODEL;
}

function nowIso() {
  return new Date().toISOString();
}

function compact(value, max = 12000) {
  return String(value || "").replace(/\s+/g, " ").trim().slice(0, max);
}

function escapeHtml(value = "") {
  return String(value || "").replace(/[&<>"']/g, char => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    "\"": "&quot;",
    "'": "&#39;"
  }[char]));
}

function markdownToSafeHtml(markdown = "") {
  const lines = String(markdown || "").split(/\r?\n/);
  const html = [];
  let inList = false;
  const inline = value => escapeHtml(value).replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  const closeList = () => {
    if (inList) {
      html.push("</ul>");
      inList = false;
    }
  };
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) {
      closeList();
      continue;
    }
    const heading = trimmed.match(/^(#{1,3})\s+(.+)$/);
    if (heading) {
      closeList();
      html.push(`<h${heading[1].length + 2}>${inline(heading[2])}</h${heading[1].length + 2}>`);
      continue;
    }
    const bullet = trimmed.match(/^[-*]\s+(.+)$/);
    if (bullet) {
      if (!inList) {
        html.push("<ul>");
        inList = true;
      }
      html.push(`<li>${inline(bullet[1])}</li>`);
      continue;
    }
    closeList();
    html.push(`<p>${inline(trimmed)}</p>`);
  }
  closeList();
  return html.join("");
}

function stripCodeFences(value = "") {
  return String(value || "")
    .trim()
    .replace(/^```(?:json|markdown)?\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim();
}

function firstCompleteJsonObject(value = "") {
  const text = stripCodeFences(value);
  let start = -1;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (start === -1) {
      if (char === "{") {
        start = index;
        depth = 1;
      }
      continue;
    }
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === "\"") {
        inString = false;
      }
      continue;
    }
    if (char === "\"") {
      inString = true;
    } else if (char === "{") {
      depth += 1;
    } else if (char === "}") {
      depth -= 1;
      if (depth === 0) return text.slice(start, index + 1);
    }
  }
  if (start >= 0) return text.slice(start);
  return text;
}

function parseMaybeJson(raw) {
  const text = firstCompleteJsonObject(raw);
  if (!text) throw new Error("Brain One returned an empty response");
  return JSON.parse(text);
}

function typeOf(value) {
  if (Array.isArray(value)) return "array";
  if (value === null) return "null";
  return typeof value;
}

function validateRequiredObject(value, pathName, required = [], errors = []) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    errors.push(`${pathName} must be an object`);
    return errors;
  }
  for (const key of required) {
    if (value[key] === undefined || value[key] === null) errors.push(`${pathName}.${key} is required`);
  }
  return errors;
}

function validateEvidenceItems(items, pathName, errors, style = "camel") {
  if (!Array.isArray(items)) {
    errors.push(`${pathName} must be an array`);
    return;
  }
  const required = style === "snake" ? ["id", "source_type", "source_url", "excerpt"] : ["id", "sourceType", "sourceUrl", "excerpt"];
  for (const [index, item] of items.entries()) {
    validateRequiredObject(item, `${pathName}[${index}]`, required, errors);
  }
}

function validateBrainOneInput(input) {
  const errors = [];
  validateRequiredObject(input, "input", inputSchema.required, errors);
  if (errors.length) return { ok: false, errors };
  validateRequiredObject(input.businessIdentity, "businessIdentity", ["businessId", "businessName", "websiteUrl"], errors);
  validateRequiredObject(input.publicContactDetails, "publicContactDetails", ["phone", "email", "address", "owner"], errors);
  validateEvidenceItems(input.evidenceLog, "evidenceLog", errors);
  validateEvidenceItems(input.publicSocialOrDirectoryEvidence, "publicSocialOrDirectoryEvidence", errors);
  validateEvidenceItems(input.scraperEvidence, "scraperEvidence", errors);
  if (typeOf(input.websitePublicText) !== "string") errors.push("websitePublicText must be a string");
  if (!Array.isArray(input.sourceUrls)) errors.push("sourceUrls must be an array");
  if (!Date.parse(input.analysisTimestamp || "")) errors.push("analysisTimestamp must be an ISO date-time string");
  return { ok: errors.length === 0, errors };
}

const GENERIC_MAILBOXES = new Set(["info", "hello", "contact", "office", "sales", "support", "admin", "service", "dallas"]);
const CLAIM_STATUSES = new Set(["confirmed", "inferred", "unknown"]);
const CLAIM_CONFIDENCE = new Set(["high", "medium", "low"]);
const DIGITAL_HEALTH_WEIGHTS = {
  website_clarity: 20,
  conversion_path: 20,
  trust_and_proof: 15,
  local_discoverability: 15,
  customer_convenience: 15,
  technical_readiness: 15
};
const RADAR_DIMENSIONS = [
  "discoverability",
  "conversion",
  "trust",
  "retention",
  "automation",
  "customer_experience",
  "operational_efficiency",
  "future_readiness"
];
const MONEY_FALLBACK_DISCLAIMER = "Insufficient evidence for a responsible monetary estimate.";
const MODULE_SPECS = [
  {
    key: "foundation",
    label: "Module 1 - Business Foundation",
    schema: foundationSchema,
    maxTokens: 1800,
    prompt: "Return business_identity, contacts, evidence_log, confirmed_facts, inferences, and unknowns only. Missing location is valid and must be null. Owner/contact names must be null unless verified."
  },
  {
    key: "digital_intelligence",
    label: "Module 2 - Business and Digital Intelligence",
    schema: digitalSchema,
    maxTokens: 2200,
    prompt: "Return business_dna, digital_health, ai_discoverability, and future_readiness only. Each section supports status assessed or insufficient_evidence. Do not require sub-scores when digital_health.status is insufficient_evidence."
  },
  {
    key: "opportunities",
    label: "Module 3 - Opportunity Intelligence",
    schema: opportunitiesSchema,
    maxTokens: 2200,
    prompt: "Return hidden_opportunities, money_left_on_table, ai_opportunity_radar, and risks only. Money may use insufficient_evidence. Radar dimensions may be unknown."
  },
  {
    key: "strategic_interpretation",
    label: "Module 4 - Strategic Interpretation",
    schema: strategicSchema,
    maxTokens: 1600,
    prompt: "Return why_we_chose_you and one_day_action_plan only. Both support status complete or insufficient_evidence."
  },
  {
    key: "contact_decision",
    label: "Module 5 - Contact Decision and Handoff",
    schema: contactDecisionSchema,
    maxTokens: 1400,
    prompt: "Return contact_decision and brain_two_handoff only. Use only validated outputs from Modules 1-4. CONTACT requires meaningful opportunity, usable contact data, active business evidence, and specific value."
  }
];

function safeMoneyFallback() {
  return {
    status: "insufficient_evidence",
    low_estimate: null,
    high_estimate: null,
    currency: null,
    time_period: null,
    calculation_method: null,
    assumptions: [],
    evidence_ids: [],
    confidence: "low",
    disclaimer: MONEY_FALLBACK_DISCLAIMER
  };
}

function safeRadarFallback() {
  return Object.fromEntries(RADAR_DIMENSIONS.map(key => [key, {
    status: "unknown",
    evidence: "Insufficient public evidence was available.",
    opportunity: "Unknown until more public evidence is collected.",
    confidence: "low",
    evidence_ids: []
  }]));
}

function safeEvidenceSectionFallback(summary = "Insufficient public evidence was available.") {
  return {
    status: "insufficient_evidence",
    summary,
    evidence_ids: []
  };
}

function claimFallback(text = "Insufficient public evidence was available.") {
  return {
    claim: text,
    evidence_ids: [],
    confidence: "low",
    status: "unknown",
    reasoning: "The module did not return enough validated evidence.",
    limitation: "More public evidence is required."
  };
}

function safeModuleFallback(moduleKey, contextPackage = {}) {
  const identity = contextPackage.businessIdentity || {};
  if (moduleKey === "foundation") {
    return {
      business_identity: {
        name: identity.businessName || "",
        website: identity.websiteUrl || null,
        industry: identity.trade || null,
        location: [identity.city, identity.state, identity.country].filter(Boolean).join(", ") || null,
        summary: "Insufficient public evidence was available for a full foundation analysis."
      },
      contacts: [],
      evidence_log: [],
      confirmed_facts: [],
      inferences: [],
      unknowns: ["Foundation module returned insufficient validated evidence."]
    };
  }
  if (moduleKey === "digital_intelligence") {
    return {
      business_dna: safeEvidenceSectionFallback("Insufficient public evidence was available for business DNA."),
      digital_health: {
        status: "insufficient_evidence",
        summary: "Insufficient public evidence was available for a reliable assessment.",
        evidence_ids: [],
        confidence: "low",
        sub_scores: null,
        total_score: null
      },
      ai_discoverability: safeEvidenceSectionFallback("Insufficient public evidence was available for AI discoverability."),
      future_readiness: safeEvidenceSectionFallback("Insufficient public evidence was available for future readiness.")
    };
  }
  if (moduleKey === "opportunities") {
    return {
      hidden_opportunities: [],
      money_left_on_table: safeMoneyFallback(),
      ai_opportunity_radar: safeRadarFallback(),
      risks: []
    };
  }
  if (moduleKey === "strategic_interpretation") {
    return {
      why_we_chose_you: safeEvidenceSectionFallback("Insufficient public evidence was available to explain why this business deserves attention."),
      one_day_action_plan: safeEvidenceSectionFallback("Insufficient public evidence was available to create a responsible one-day action plan.")
    };
  }
  return {
    contact_decision: {
      decision: "DO NOT CONTACT",
      decision_confidence: "low",
      primary_reason: "Insufficient validated evidence for a responsible contact recommendation.",
      supporting_evidence: [],
      disqualifying_factors: ["Insufficient validated evidence."],
      information_gaps: ["Validated opportunity and contact data are incomplete."],
      recommended_outreach_angle: "Do not proceed until better evidence is available.",
      prohibited_claims_for_brain_two: ["Do not contact yet.", "Do not claim specific missed revenue."],
      callcatch_opportunity_score: null,
      evidence_ids: [],
      recommendation_status: "NEEDS_REVIEW"
    },
    brain_two_handoff: {
      approved_for_handoff: false,
      summary: "Manual approval required. Brain Two should not proceed because evidence is insufficient.",
      evidence_ids: [],
      do_not_automate_outbound: true
    }
  };
}

function contextEvidenceLog(contextPackage = {}) {
  return (contextPackage.evidenceLog || []).map(item => ({
    id: item.id,
    source_type: item.source_type || item.sourceType || "unknown",
    source_url: item.source_url || item.sourceUrl || "",
    excerpt: item.excerpt || "",
    captured_at: item.captured_at || item.capturedAt || contextPackage.analysisTimestamp || nowIso()
  })).filter(item => item.id);
}

function evidenceText(item = {}) {
  return compact([
    item.excerpt,
    item.value,
    item.text,
    item.summary,
    item.title,
    item.field,
    item.source_url || item.sourceUrl
  ].filter(Boolean).join(" "), 1200);
}

function evidenceContainsAny(item = {}, patterns = []) {
  const text = evidenceText(item);
  return patterns.some(pattern => pattern.test(text));
}

function firstUsefulEvidence(evidence = [], patterns = []) {
  return evidence.find(item => evidenceContainsAny(item, patterns)) || evidence.find(item => evidenceText(item));
}

function evidenceIdsFrom(items = []) {
  return uniqueArray(items.map(item => item.id || item.evidence_id).filter(Boolean));
}

function phraseFromEvidence(item = {}, fallback = "") {
  const text = evidenceText(item);
  if (!text) return fallback;
  const cleaned = text
    .replace(/\s*\|\s*/g, ". ")
    .replace(/\bhttps?:\/\/\S+/gi, "")
    .trim();
  return compact(cleaned, 180) || fallback;
}

function inferredServiceList(contextPackage = {}, evidence = []) {
  const identity = contextPackage.businessIdentity || {};
  const text = evidence.map(evidenceText).join(" ").toLowerCase();
  const services = [];
  const trade = compact(identity.trade, 80);
  if (trade) services.push(trade);
  const serviceSignals = [
    ["Payments", /\bpayments?\b|\bbilling\b|\binvoic|\bcheckout\b|\bfinancial infrastructure\b/],
    ["CRM", /\bcrm\b|\bcustomer platform\b|\bsales\b|\bmarketing\b/],
    ["Commerce platform", /\becommerce\b|\bcommerce\b|\bonline store\b|\bshop\b|\bretail\b/],
    ["Cloud and software", /\bcloud\b|\bsoftware\b|\bproductivity\b|\bdeveloper\b|\bplatform\b/],
    ["Automation", /\bautomation\b|\bworkflow\b|\bai\b|\bartificial intelligence\b/],
    ["Developer tools", /\bapi\b|\bdeveloper\b|\bsdk\b|\bintegration\b/]
  ];
  for (const [label, pattern] of serviceSignals) {
    if (pattern.test(text)) services.push(label);
  }
  return uniqueArray(services).slice(0, 6);
}

function synthesizeBusinessDnaFromEvidence(contextPackage = {}, priorModules = {}) {
  const evidence = [
    ...(Array.isArray(contextPackage.evidenceLog) ? contextPackage.evidenceLog : []),
    ...(priorModules.foundation?.output?.evidence_log || [])
  ].filter(item => item && (item.id || item.evidence_id));
  if (!evidence.length) return null;

  const identity = contextPackage.businessIdentity || {};
  const foundationIdentity = priorModules.foundation?.output?.business_identity || {};
  const websiteText = compact(contextPackage.websitePublicText || evidence.map(evidenceText).join(" "), 5000);
  const text = websiteText.toLowerCase();
  const picked = [];
  const pick = (patterns, fallbackIndex = 0) => {
    const item = firstUsefulEvidence(evidence, patterns) || evidence[fallbackIndex];
    if (item) picked.push(item);
    return item;
  };

  const services = inferredServiceList(contextPackage, evidence);
  const identityEvidence = pick([/business_name|website|description|homepage|title/i]);
  const serviceEvidence = pick([/service|product|platform|solution|commerce|payment|crm|software|cloud|api|developer/i], 1);
  const trustEvidence = pick([/customer|partner|security|trust|enterprise|review|testimonial|certif|compliance/i], 2);
  const journeyEvidence = pick([/pricing|contact|demo|checkout|start|sign up|book|schedule|sales|support/i], 3);

  const businessName = compact(
    foundationIdentity.name ||
    foundationIdentity.business_name ||
    identity.businessName ||
    "The business",
    120
  );
  const market = [identity.city, identity.state, identity.country].filter(Boolean).join(", ")
    || foundationIdentity.location
    || (/\bglobal\b|\benterprise\b|\bworldwide\b|\binternational\b/.test(text) ? "public global market" : "public website market");
  const businessModel = /\bplatform\b|\bsaas\b|\bsubscription\b|\bsoftware\b|\bapi\b|\bcloud\b/.test(text)
    ? "Inferred platform or software-led business model"
    : services.length
      ? `Inferred ${services[0]} service business model`
      : "Inferred public website-led business model";
  const segments = [];
  if (/\benterprise\b|\bbusinesses\b|\bteams\b|\bdevelopers\b|\bcompanies\b|\bretailers\b|\bmerchants\b/.test(text)) segments.push("business customers");
  if (/\bdeveloper\b|\bapi\b|\bsdk\b/.test(text)) segments.push("developers and technical teams");
  if (/\bconsumer\b|\bhomeowner\b|\bcustomer\b/.test(text)) segments.push("end customers");

  const dna = {
    status: "assessed",
    summary: `Business DNA synthesized from Brain Zero evidence for ${businessName}.`,
    business_model: businessModel,
    primary_services: services.length ? services : ["public website services"],
    likely_customer_segments: segments.length ? uniqueArray(segments) : ["public website visitors", "business customers"],
    geographic_market: market,
    value_proposition: `Inferred from public evidence: ${phraseFromEvidence(serviceEvidence || identityEvidence, `${businessName} presents a clear public product or service offering.`)}`,
    likely_revenue_drivers: uniqueArray([
      /\bpricing\b|\bplan\b|\bsubscription\b/.test(text) ? "subscriptions or pricing plans" : "",
      /\bpayment\b|\bcheckout\b|\btransaction\b/.test(text) ? "transaction or payment volume" : "",
      /\benterprise\b|\bsales\b|\bdemo\b/.test(text) ? "enterprise or sales-led contracts" : "",
      services.length ? `${services[0]} demand` : ""
    ].filter(Boolean)),
    customer_journey: journeyEvidence
      ? `Inferred website-led journey from public evidence: ${phraseFromEvidence(journeyEvidence)}`
      : "Inferred website-led discovery and conversion journey.",
    current_digital_maturity: /\bapi\b|\bintegration\b|\bdeveloper\b|\bcloud\b|\bautomation\b|\bai\b/.test(text)
      ? "High digital maturity inferred from public technical and platform evidence."
      : "Digital maturity inferred from available public website evidence.",
    operational_complexity: /\benterprise\b|\bglobal\b|\bplatform\b|\bapi\b|\bintegration\b|\bcloud\b/.test(text)
      ? "High operational complexity inferred from platform, enterprise, or integration signals."
      : "Moderate operational complexity inferred from public service evidence.",
    trust_signals: uniqueArray([
      trustEvidence ? phraseFromEvidence(trustEvidence, "") : "",
      /\bsecurity\b|\bcompliance\b|\bprivacy\b/.test(text) ? "security, compliance, or privacy signals are visible publicly" : "",
      /\bcustomer\b|\bpartner\b|\btestimonial\b|\bcase stud/.test(text) ? "customer, partner, or proof signals are visible publicly" : ""
    ].filter(Boolean)).slice(0, 5),
    differentiators: uniqueArray([
      /\bapi\b|\bdeveloper\b/.test(text) ? "developer-accessible product surface" : "",
      /\bautomation\b|\bai\b/.test(text) ? "automation or AI-related positioning" : "",
      /\bplatform\b/.test(text) ? "platform positioning" : "",
      services[0] ? `${services[0]} focus` : ""
    ].filter(Boolean)).slice(0, 5),
    growth_stage: /\benterprise\b|\bglobal\b|\bpartner\b|\bcustomer\b/.test(text)
      ? "Established public business"
      : "Active public business",
    evidence_strength: evidence.length >= 8 ? "high" : evidence.length >= 3 ? "medium" : "low",
    confidence: evidence.length >= 8 ? "high" : evidence.length >= 3 ? "medium" : "low",
    evidence_ids: evidenceIdsFrom(picked.length ? picked : evidence).slice(0, 10)
  };

  return hasUsefulAnalyticalFields(dna) ? dna : null;
}

function normalizeContact(contact = {}, index = 0, meta = null) {
  const defaults = {
    owner_name: null,
    contact_name: null,
    contact_role: "",
    contact_email: "",
    contact_phone: "",
    contact_source: "",
    contact_confidence: 0,
    status: "unknown",
    evidence_ids: []
  };
  for (const [key, value] of Object.entries(defaults)) {
    if (!(key in contact)) {
      contact[key] = value;
      recordNormalization(meta, `contacts[${index}].${key}`);
    }
  }
  if (typeof contact.owner_name === "string" && contact.owner_name.trim() === "") contact.owner_name = null;
  if (typeof contact.contact_name === "string" && contact.contact_name.trim() === "") contact.contact_name = null;
  contact.contact_confidence = clampNumber(numberOrNull(contact.contact_confidence), 0, 100);
  contact.status = normalizeClaimStatus(contact.status);
  normalizeEvidenceIds(contact, `contacts[${index}].evidence_ids`, meta);
  return contact;
}

function normalizeClaimItem(item = {}, pathName, meta = null) {
  if (!item || typeof item !== "object" || Array.isArray(item)) return null;
  if (!item.claim && item.inference) {
    item.claim = item.inference;
    recordNormalization(meta, `${pathName}.claim`);
  }
  if (!item.claim && item.risk) {
    item.claim = item.risk;
    recordNormalization(meta, `${pathName}.claim`);
  }
  if (!item.claim) item.claim = "Insufficient public evidence was available.";
  item.confidence = normalizeConfidence(item.confidence);
  item.status = normalizeClaimStatus(item.status);
  if (!item.reasoning) item.reasoning = "The available public evidence is limited.";
  if (!item.limitation) item.limitation = "More evidence may change this assessment.";
  normalizeEvidenceIds(item, `${pathName}.evidence_ids`, meta);
  return item;
}

function normalizeAssessment(section = {}, pathName, meta = null, fallbackSummary = "Insufficient public evidence was available.") {
  if (!section || typeof section !== "object" || Array.isArray(section)) {
    recordNormalization(meta, pathName);
    return safeEvidenceSectionFallback(fallbackSummary);
  }
  const status = String(section.status || "").trim().toLowerCase();
  if (!["assessed", "complete", "insufficient_evidence"].includes(status)) {
    section.status = section.evidence_ids?.length || hasUsefulAnalyticalFields(section) ? "assessed" : "insufficient_evidence";
    recordNormalization(meta, `${pathName}.status`);
  } else {
    section.status = status;
  }
  if (!section.summary && typeof section.description === "string") {
    section.summary = section.description;
    recordNormalization(meta, `${pathName}.summary`);
  }
  if (!section.summary) {
    section.summary = fallbackSummary;
    recordNormalization(meta, `${pathName}.summary`);
  }
  section.confidence = normalizeConfidence(section.confidence);
  normalizeEvidenceIds(section, `${pathName}.evidence_ids`, meta);
  return section;
}

function hasUsefulAnalyticalFields(section = {}) {
  if (!section || typeof section !== "object" || Array.isArray(section)) return false;
  const ignored = new Set(["status", "evidence_ids", "confidence", "summary"]);
  return Object.entries(section).some(([key, value]) => {
    if (ignored.has(key)) return false;
    if (Array.isArray(value)) return value.length > 0;
    if (value && typeof value === "object") return Object.keys(value).length > 0;
    const text = String(value || "").trim().toLowerCase();
    return !!text && !["unknown", "n/a", "null", "insufficient evidence"].includes(text);
  });
}

function hasBusinessDnaScoringFields(dna = {}) {
  return BUSINESS_DNA_SCORING_FIELDS.some(key => hasUsefulValue(dna?.[key]));
}

function normalizeDigitalHealth(section = {}, meta = null) {
  const normalized = normalizeAssessment(section, "digital_health", meta, "Insufficient public evidence was available for a reliable assessment.");
  if (normalized.status === "assessed" && normalized.sub_scores && typeof normalized.sub_scores === "object" && !Array.isArray(normalized.sub_scores)) {
    let total = 0;
    let complete = true;
    for (const [key, max] of Object.entries(DIGITAL_HEALTH_WEIGHTS)) {
      const item = normalized.sub_scores[key];
      if (!item || typeof item !== "object") {
        complete = false;
        continue;
      }
      const score = numberOrNull(item.score);
      if (score === null) {
        complete = false;
      } else {
        item.score = clampNumber(score, 0, max);
        total += item.score;
      }
      item.confidence = normalizeConfidence(item.confidence);
      normalizeEvidenceIds(item, `digital_health.sub_scores.${key}.evidence_ids`, meta);
    }
    normalized.total_score = complete ? Math.round(total) : null;
    normalized.score = normalized.total_score;
  } else {
    normalized.status = "insufficient_evidence";
    normalized.sub_scores = null;
    normalized.total_score = null;
    normalized.score = null;
    recordNormalization(meta, "digital_health");
  }
  return normalized;
}

function normalizeMoneyForModule(value, meta = null) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    recordNormalization(meta, "money_left_on_table");
    return safeMoneyFallback();
  }
  value.status = String(value.status || "").trim().toLowerCase();
  normalizeEvidenceIds(value, "money_left_on_table.evidence_ids", meta);
  value.confidence = normalizeConfidence(value.confidence);
  if (value.status !== "estimated") {
    recordNormalization(meta, "money_left_on_table");
    return safeMoneyFallback();
  }
  value.low_estimate = numberOrNull(value.low_estimate);
  value.high_estimate = numberOrNull(value.high_estimate);
  if (
    value.low_estimate === null ||
    value.high_estimate === null ||
    !value.currency ||
    !value.time_period ||
    !value.calculation_method ||
    !Array.isArray(value.assumptions) ||
    value.assumptions.length === 0 ||
    value.evidence_ids.length === 0
  ) {
    recordNormalization(meta, "money_left_on_table");
    return safeMoneyFallback();
  }
  return value;
}

function normalizeOpportunityItem(item = {}, index = 0, evidenceIds = new Set(), meta = null) {
  if (!item || typeof item !== "object" || Array.isArray(item)) return null;
  normalizeEvidenceIds(item, `hidden_opportunities[${index}].evidence_ids`, meta);
  if (!item.evidence_ids.length || item.evidence_ids.some(id => !evidenceIds.has(id))) {
    recordNormalization(meta, `hidden_opportunities[${index}]`);
    return null;
  }
  item.title = item.title || item.specific_observed_problem || "Evidence-backed opportunity";
  item.specific_observed_problem = item.specific_observed_problem || item.title;
  item.supporting_evidence = Array.isArray(item.supporting_evidence) ? item.supporting_evidence : [];
  item.why_it_matters = item.why_it_matters || "This may affect customer response or conversion.";
  item.affected_customer_journey_stage = item.affected_customer_journey_stage || "first contact";
  item.likely_business_impact = item.likely_business_impact || "Potential improvement, not confirmed revenue.";
  item.implementation_difficulty = item.implementation_difficulty || "unknown";
  item.time_to_initial_impact = item.time_to_initial_impact || "unknown";
  item.confidence = normalizeConfidence(item.confidence);
  item.assumptions = Array.isArray(item.assumptions) ? item.assumptions : [];
  item.recommended_first_test = item.recommended_first_test || "Verify the observation manually before acting.";
  item.callcatch_relevance = item.callcatch_relevance || "unknown";
  const factors = item.ranking_factors || item;
  const scoreFields = ["evidence_strength", "business_impact", "feasibility", "urgency"];
  item.ranking_factors = Object.fromEntries(scoreFields.map(key => [key, clampNumber(numberOrNull(factors[key]), 0, 100)]));
  item.opportunity_priority_score = Math.round((item.ranking_factors.evidence_strength * item.ranking_factors.business_impact * item.ranking_factors.feasibility * item.ranking_factors.urgency) / 1000000);
  return item;
}

function recordNormalization(meta, field) {
  if (!meta) return;
  meta.normalization_applied = true;
  meta.normalized_fields = meta.normalized_fields || [];
  if (!meta.normalized_fields.includes(field)) meta.normalized_fields.push(field);
}

function cleanModuleContacts(output = {}, meta = null) {
  if (!Array.isArray(output.contacts)) return output;
  for (const [index, contact] of output.contacts.entries()) {
    if (!contact || typeof contact !== "object") continue;
    if (isEmailLike(contact.contact_name)) {
      if (!contact.contact_email) contact.contact_email = String(contact.contact_name).trim();
      contact.contact_name = null;
      recordNormalization(meta, `contacts[${index}].contact_name`);
    }
    if (isEmailLike(contact.owner_name)) {
      if (!contact.contact_email) contact.contact_email = String(contact.owner_name).trim();
      contact.owner_name = null;
      recordNormalization(meta, `contacts[${index}].owner_name`);
    }
    if (genericMailboxName(contact.contact_name)) {
      contact.contact_name = null;
      recordNormalization(meta, `contacts[${index}].contact_name`);
    }
  }
  return output;
}

function isEmailLike(value = "") {
  return /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/i.test(String(value || ""));
}

function genericMailboxName(value = "") {
  const text = String(value || "").trim().toLowerCase();
  const local = text.includes("@") ? text.split("@")[0] : text;
  return GENERIC_MAILBOXES.has(local);
}

function clampNumber(value, min = 0, max = 100) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return min;
  return Math.max(min, Math.min(max, parsed));
}

function numberOrNull(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === "string" && value.trim() === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function normalizeConfidence(value) {
  const text = String(value || "").trim().toLowerCase();
  if (["high", "strong"].includes(text)) return "high";
  if (["medium", "moderate", "mid"].includes(text)) return "medium";
  if (["low", "weak", "unknown", "insufficient", ""].includes(text)) return "low";
  return "low";
}

function normalizeClaimStatus(value) {
  const text = String(value || "").trim().toLowerCase();
  if (["confirmed", "fact", "verified"].includes(text)) return "confirmed";
  if (["inferred", "likely", "possible", "observed"].includes(text)) return "inferred";
  return "unknown";
}

function uniqueArray(values = []) {
  return [...new Set((Array.isArray(values) ? values : [values]).filter(value => value !== null && value !== undefined && String(value).trim() !== "").map(value => String(value).trim()))];
}

function normalizeEvidenceIds(holder = {}, pathName = "evidence_ids", meta = null) {
  if (!holder || typeof holder !== "object") return [];
  const incoming = holder.evidence_ids || holder.evidenceIds || holder.evidence || [];
  const normalized = uniqueArray(incoming);
  if (!Array.isArray(holder.evidence_ids) || holder.evidence_ids.length !== normalized.length || holder.evidence_ids.some((id, index) => id !== normalized[index])) {
    holder.evidence_ids = normalized;
    recordNormalization(meta, pathName);
  }
  delete holder.evidenceIds;
  return holder.evidence_ids;
}

function evidenceIdList(item = {}) {
  return item.evidence_ids || item.evidenceIds || [];
}

function evidenceReferenceCheck(ids, pathName, evidenceIds, errors) {
  if (!Array.isArray(ids) || ids.length === 0) {
    errors.push(`${pathName} must include evidence_ids`);
    return;
  }
  for (const id of ids) {
    if (!evidenceIds.has(id)) errors.push(`${pathName} references unknown evidence id ${id}`);
  }
}

function materialClaimCheck(item, pathName, evidenceIds, errors) {
  validateRequiredObject(item, pathName, ["claim", "evidence_ids", "confidence", "status", "reasoning", "limitation"], errors);
  evidenceReferenceCheck(evidenceIdList(item), pathName, evidenceIds, errors);
  if (!CLAIM_CONFIDENCE.has(item?.confidence)) errors.push(`${pathName}.confidence must be high, medium, or low`);
  if (!CLAIM_STATUSES.has(item?.status)) errors.push(`${pathName}.status must be confirmed, inferred, or unknown`);
  const claimText = String(item?.claim || "").toLowerCase();
  const absenceWords = ["does not", "no online", "no booking", "no chatbot", "no live chat", "not offer", "not have"];
  if (item?.status === "confirmed" && absenceWords.some(word => claimText.includes(word))) {
    errors.push(`${pathName} cannot state absence as a confirmed fact`);
  }
}

function claimListChecks(items, pathName, evidenceIds, errors) {
  if (!Array.isArray(items)) {
    errors.push(`${pathName} must be an array`);
    return;
  }
  for (const [index, item] of items.entries()) {
    materialClaimCheck(item, `${pathName}[${index}]`, evidenceIds, errors);
  }
}

function sectionEvidenceCheck(section, pathName, evidenceIds, errors) {
  if (!section || typeof section !== "object" || Array.isArray(section)) {
    errors.push(`${pathName} must be an object`);
    return;
  }
  const ids = evidenceIdList(section);
  if (!Array.isArray(ids) || ids.length === 0) {
    errors.push(`${pathName} must include evidence_ids`);
    return;
  }
  for (const id of ids) {
    if (!evidenceIds.has(id)) errors.push(`${pathName} references unknown evidence id ${id}`);
  }
}

function normalizeBrainOneOutput(output = {}, meta = null) {
  if (Array.isArray(output.evidence) && !Array.isArray(output.evidence_log)) {
    output.evidence_log = output.evidence;
    delete output.evidence;
    recordNormalization(meta, "evidence_log");
  }
  if (output.contact_confidence && !Array.isArray(output.contacts)) {
    output.contacts = [{
      owner_name: output.contact_confidence.owner_name || null,
      contact_name: null,
      contact_role: "",
      contact_email: "",
      contact_phone: "",
      contact_source: "",
      contact_confidence: output.contact_confidence.confidence || 0,
      status: "unknown",
      evidence_ids: evidenceIdList(output.contact_confidence)
    }];
    delete output.contact_confidence;
    recordNormalization(meta, "contacts");
  }
  for (const field of ["contacts", "evidence_log", "confirmed_facts", "inferences", "unknowns", "hidden_opportunities", "risks"]) {
    if (!Array.isArray(output[field])) {
      output[field] = [];
      recordNormalization(meta, field);
    }
  }
  if (!output.money_left_on_table || typeof output.money_left_on_table !== "object" || Array.isArray(output.money_left_on_table)) {
    output.money_left_on_table = safeMoneyFallback();
    recordNormalization(meta, "money_left_on_table");
  }
  if (!output.ai_opportunity_radar || typeof output.ai_opportunity_radar !== "object" || Array.isArray(output.ai_opportunity_radar)) {
    output.ai_opportunity_radar = safeRadarFallback();
    recordNormalization(meta, "ai_opportunity_radar");
  }
  if (!output.why_we_chose_you || typeof output.why_we_chose_you !== "object" || Array.isArray(output.why_we_chose_you)) {
    output.why_we_chose_you = safeEvidenceSectionFallback("Insufficient public evidence was available to explain why this business deserves attention.");
    recordNormalization(meta, "why_we_chose_you");
  }
  if (!output.one_day_action_plan || typeof output.one_day_action_plan !== "object" || Array.isArray(output.one_day_action_plan)) {
    output.one_day_action_plan = safeEvidenceSectionFallback("Insufficient public evidence was available to create a responsible one-day action plan.");
    recordNormalization(meta, "one_day_action_plan");
  }
  const subScores = output.digital_health?.sub_scores || {};
  if (output.digital_health && typeof subScores === "object") {
    let total = 0;
    for (const [key, max] of Object.entries(DIGITAL_HEALTH_WEIGHTS)) {
      if (!subScores[key]) subScores[key] = {};
      subScores[key].score = clampNumber(subScores[key].score, 0, max);
      total += subScores[key].score;
    }
    output.digital_health.sub_scores = subScores;
    output.digital_health.score = Math.round(total);
  }
  if (Array.isArray(output.hidden_opportunities)) {
    for (const item of output.hidden_opportunities) {
      const factors = item.ranking_factors || item;
      const evidenceStrength = clampNumber(factors.evidence_strength);
      const businessImpact = clampNumber(factors.business_impact);
      const feasibility = clampNumber(factors.feasibility);
      const urgency = clampNumber(factors.urgency);
      item.ranking_factors = { evidence_strength: evidenceStrength, business_impact: businessImpact, feasibility, urgency };
      item.opportunity_priority_score = Math.round((evidenceStrength * businessImpact * feasibility * urgency) / 1000000);
    }
    output.hidden_opportunities.sort((a, b) => (b.opportunity_priority_score || 0) - (a.opportunity_priority_score || 0));
  }
  if (output.priority && output.contact_decision) {
    output.priority.score = output.contact_decision.callcatch_opportunity_score ?? output.priority.score;
  }
  return output;
}

function validateContacts(contacts, evidenceIds, errors) {
  if (!Array.isArray(contacts)) {
    errors.push("contacts must be an array");
    return;
  }
  for (const [index, contact] of contacts.entries()) {
    const pathName = `contacts[${index}]`;
    if (!contact || typeof contact !== "object" || Array.isArray(contact)) {
      errors.push(`${pathName} must be an object`);
      continue;
    }
    for (const key of ["owner_name", "contact_name", "contact_role", "contact_email", "contact_phone", "contact_source", "contact_confidence", "status", "evidence_ids"]) {
      if (!(key in contact)) errors.push(`${pathName}.${key} is required`);
    }
    if (isEmailLike(contact.owner_name)) errors.push(`${pathName}.owner_name must not contain an email address`);
    if (isEmailLike(contact.contact_name)) errors.push(`${pathName}.contact_name must not contain an email address`);
    if (genericMailboxName(contact.contact_name)) errors.push(`${pathName}.contact_name must not be a generic mailbox`);
    if (contact.owner_name && contact.status === "confirmed") evidenceReferenceCheck(evidenceIdList(contact), `${pathName}.owner_name`, evidenceIds, errors);
    if (contact.status === "confirmed" && !contact.contact_source) errors.push(`${pathName}.contact_source is required for confirmed contacts`);
    if (clampNumber(contact.contact_confidence) >= 75 && (!contact.contact_source || evidenceIdList(contact).length === 0)) {
      errors.push(`${pathName}.contact_confidence cannot be high without source evidence`);
    }
    if (!CLAIM_STATUSES.has(contact.status)) errors.push(`${pathName}.status must be confirmed, inferred, or unknown`);
  }
}

function validateDigitalHealth(section, evidenceIds, errors) {
  validateRequiredObject(section, "digital_health", ["score", "sub_scores", "summary", "evidence_ids"], errors);
  evidenceReferenceCheck(evidenceIdList(section), "digital_health", evidenceIds, errors);
  const subScores = section?.sub_scores || {};
  let total = 0;
  for (const [key, max] of Object.entries(DIGITAL_HEALTH_WEIGHTS)) {
    const item = subScores[key];
    validateRequiredObject(item, `digital_health.sub_scores.${key}`, ["score", "evidence_ids", "reasoning", "confidence", "what_would_improve_it"], errors);
    total += clampNumber(item?.score, 0, max);
    evidenceReferenceCheck(evidenceIdList(item), `digital_health.sub_scores.${key}`, evidenceIds, errors);
    if (!CLAIM_CONFIDENCE.has(item?.confidence)) errors.push(`digital_health.sub_scores.${key}.confidence must be high, medium, or low`);
  }
  if (Math.round(total) !== Math.round(Number(section?.score || 0))) {
    errors.push("digital_health.score must match calculated sub-score total");
  }
}

function validateHiddenOpportunities(items, evidenceIds, errors) {
  if (!Array.isArray(items)) {
    errors.push("hidden_opportunities must be an array");
    return;
  }
  if (items.length > 5) errors.push("hidden_opportunities must contain five or fewer items");
  const seen = new Set();
  for (const [index, item] of items.entries()) {
    const pathName = `hidden_opportunities[${index}]`;
    validateRequiredObject(item, pathName, ["title", "specific_observed_problem", "supporting_evidence", "why_it_matters", "affected_customer_journey_stage", "likely_business_impact", "implementation_difficulty", "time_to_initial_impact", "confidence", "assumptions", "recommended_first_test", "callcatch_relevance", "ranking_factors", "opportunity_priority_score", "evidence_ids"], errors);
    const signature = compact(item.title || item.specific_observed_problem || "", 120).toLowerCase();
    if (signature && seen.has(signature)) errors.push(`${pathName} duplicates another opportunity`);
    seen.add(signature);
    evidenceReferenceCheck(evidenceIdList(item), pathName, evidenceIds, errors);
    if (!CLAIM_CONFIDENCE.has(item?.confidence)) errors.push(`${pathName}.confidence must be high, medium, or low`);
    validateRequiredObject(item.ranking_factors, `${pathName}.ranking_factors`, ["evidence_strength", "business_impact", "feasibility", "urgency"], errors);
  }
}

function validateMoneyLeftOnTable(section, evidenceIds, errors) {
  if (!section || typeof section !== "object" || Array.isArray(section)) {
    errors.push("money_left_on_table must be an object");
    return;
  }
  for (const key of ["status", "low_estimate", "high_estimate", "currency", "time_period", "calculation_method", "assumptions", "evidence_ids", "confidence", "disclaimer"]) {
    if (!(key in section)) errors.push(`money_left_on_table.${key} is required`);
  }
  if (section?.status === "insufficient_evidence") {
    if (section.low_estimate !== null || section.high_estimate !== null || section.currency !== null || section.time_period !== null || section.calculation_method !== null) {
      errors.push("money_left_on_table insufficient_evidence values must use null monetary fields");
    }
    if (!Array.isArray(section.assumptions) || section.assumptions.length !== 0) errors.push("money_left_on_table insufficient_evidence assumptions must be empty");
    if (!Array.isArray(section.evidence_ids) || section.evidence_ids.length !== 0) errors.push("money_left_on_table insufficient_evidence evidence_ids must be empty");
    if (section.confidence !== "low") errors.push("money_left_on_table insufficient_evidence confidence must be low");
    if (section.disclaimer !== MONEY_FALLBACK_DISCLAIMER) errors.push("money_left_on_table insufficient_evidence disclaimer must use the safe fallback");
    return;
  }
  if (section?.status !== "estimated") errors.push("money_left_on_table.status must be estimated or insufficient_evidence");
  if (!Number.isFinite(Number(section?.low_estimate)) || !Number.isFinite(Number(section?.high_estimate))) {
    errors.push("money_left_on_table estimates must be numeric when status is estimated");
  }
  if (!Array.isArray(section?.assumptions) || section.assumptions.length === 0) errors.push("money_left_on_table.assumptions are required for estimates");
  evidenceReferenceCheck(evidenceIdList(section), "money_left_on_table", evidenceIds, errors);
  if (!section?.calculation_method) errors.push("money_left_on_table.calculation_method is required for estimates");
  if (!CLAIM_CONFIDENCE.has(section?.confidence)) errors.push("money_left_on_table.confidence must be high, medium, or low");
}

function validateContactDecision(section, evidenceIds, errors) {
  validateRequiredObject(section, "contact_decision", ["decision", "decision_confidence", "primary_reason", "supporting_evidence", "disqualifying_factors", "information_gaps", "recommended_outreach_angle", "prohibited_claims_for_brain_two", "callcatch_opportunity_score", "evidence_ids"], errors);
  if (!["CONTACT", "DO NOT CONTACT"].includes(section?.decision)) errors.push("contact_decision.decision must be CONTACT or DO NOT CONTACT");
  validateSimpleEvidenceRefs(evidenceIdList(section), evidenceIds, "contact_decision", errors, section?.decision !== "CONTACT");
  const weakEvidence = String(section?.decision_confidence || "").toLowerCase() === "low" || evidenceIdList(section).length === 0;
  if (section?.decision === "CONTACT" && weakEvidence) errors.push("CONTACT decision requires more than weak evidence");
  if (section?.callcatch_opportunity_score !== null && numberOrNull(section?.callcatch_opportunity_score) === null) {
    errors.push("contact_decision.callcatch_opportunity_score must be numeric or null");
  }
}

function validateRadar(section, evidenceIds, errors) {
  validateRequiredObject(section, "ai_opportunity_radar", RADAR_DIMENSIONS, errors);
  for (const key of RADAR_DIMENSIONS) {
    validateRequiredObject(section?.[key], `ai_opportunity_radar.${key}`, ["status", "evidence", "opportunity", "confidence", "evidence_ids"], errors);
    if (section?.[key]?.status !== "unknown") {
      evidenceReferenceCheck(evidenceIdList(section?.[key]), `ai_opportunity_radar.${key}`, evidenceIds, errors);
    }
  }
}

function safeSectionEvidenceCheck(section, pathName, evidenceIds, errors) {
  if (section?.status === "insufficient_evidence") {
    if (!Array.isArray(section.evidence_ids)) errors.push(`${pathName}.evidence_ids must be an array`);
    return;
  }
  sectionEvidenceCheck(section, pathName, evidenceIds, errors);
}

function validatePhaseBMarkdownAgainstPhaseA(markdown = "", phaseA = {}) {
  const text = String(markdown || "");
  const errors = [];
  if (/\bev-[a-z0-9-]+\b/i.test(text)) errors.push("Founder-facing blueprint must not expose evidence IDs");
  const allowedNames = [
    phaseA.business_identity?.business_name,
    ...(phaseA.business_dna?.primary_services || []),
    ...(phaseA.business_dna?.trust_signals || []),
    ...(phaseA.business_dna?.differentiators || []),
    ...(phaseA.hidden_opportunities || []).map(item => item.title),
    ...(phaseA.unknowns || []).map(item => typeof item === "string" ? item : item.claim)
  ].filter(Boolean).map(item => compact(item, 80));
  const unsupportedMoney = text.match(/\$[\d,]+/g) || [];
  if ((phaseA.money_left_on_table?.status === "insufficient_evidence") && unsupportedMoney.length) {
    errors.push("Phase B introduced a monetary figure absent from Phase A");
  }
  if (/\b(owner|founder|president)\b/i.test(text) && !(phaseA.contacts || []).some(item => item.owner_name || item.contact_name)) {
    errors.push("Phase B introduced a person/contact fact absent from Phase A");
  }
  return { ok: errors.length === 0, errors, allowedFacts: allowedNames };
}

function validateBrainOneOutput(output, options = {}) {
  const errors = [];
  const normalizationMeta = options.normalizationMeta || { normalization_applied: false, normalized_fields: [] };
  normalizeBrainOneOutput(output, normalizationMeta);
  if (normalizationMeta.normalization_applied && typeof options.logger === "function") {
    options.logger("info", "brain_one_output_normalized", {
      normalized_fields: normalizationMeta.normalized_fields
    });
  }
  validateRequiredObject(output, "output", LEGACY_OUTPUT_REQUIRED, errors);
  if (errors.length) return { ok: false, errors };
  validateRequiredObject(output.business_identity, "business_identity", ["business_name", "website_url", "trade", "location"], errors);
  validateEvidenceItems(output.evidence_log, "evidence_log", errors, "snake");
  const evidenceIds = new Set((output.evidence_log || []).map(item => item.id));
  validateContacts(output.contacts, evidenceIds, errors);
  claimListChecks(output.confirmed_facts, "confirmed_facts", evidenceIds, errors);
  claimListChecks(output.inferences, "inferences", evidenceIds, errors);
  claimListChecks(output.risks, "risks", evidenceIds, errors);
  validateRequiredObject(output.business_dna, "business_dna", ["business_model", "primary_services", "likely_customer_segments", "geographic_market", "value_proposition", "likely_revenue_drivers", "customer_journey", "current_digital_maturity", "operational_complexity", "trust_signals", "differentiators", "growth_stage", "evidence_strength", "evidence_ids"], errors);
  sectionEvidenceCheck(output.business_dna, "business_dna", evidenceIds, errors);
  validateDigitalHealth(output.digital_health, evidenceIds, errors);
  sectionEvidenceCheck(output.ai_discoverability, "ai_discoverability", evidenceIds, errors);
  sectionEvidenceCheck(output.future_readiness, "future_readiness", evidenceIds, errors);
  validateHiddenOpportunities(output.hidden_opportunities, evidenceIds, errors);
  validateMoneyLeftOnTable(output.money_left_on_table, evidenceIds, errors);
  validateRadar(output.ai_opportunity_radar, evidenceIds, errors);
  safeSectionEvidenceCheck(output.why_we_chose_you, "why_we_chose_you", evidenceIds, errors);
  safeSectionEvidenceCheck(output.one_day_action_plan, "one_day_action_plan", evidenceIds, errors);
  validateContactDecision(output.contact_decision, evidenceIds, errors);
  sectionEvidenceCheck(output.brain_two_handoff, "brain_two_handoff", evidenceIds, errors);
  if (output.brain_two_handoff?.do_not_automate_outbound !== true) {
    errors.push("brain_two_handoff.do_not_automate_outbound must be true");
  }
  if (output.brain_two_handoff?.approved_for_handoff !== false) {
    errors.push("brain_two_handoff.approved_for_handoff must remain false until manual approval");
  }
  if (!Array.isArray(output.unknowns)) errors.push("unknowns must be an array");
  return { ok: errors.length === 0, errors };
}

function ensureArrayField(output, field, meta) {
  if (!Array.isArray(output[field])) {
    output[field] = [];
    recordNormalization(meta, field);
  }
}

function ensureObjectField(output, field, fallback, meta) {
  if (!output[field] || typeof output[field] !== "object" || Array.isArray(output[field])) {
    output[field] = fallback;
    recordNormalization(meta, field);
  }
}

function validateSimpleEvidenceRefs(ids = [], evidenceIds = new Set(), pathName, errors, allowEmpty = true) {
  if (!Array.isArray(ids)) {
    errors.push(`${pathName}.evidence_ids must be an array`);
    return;
  }
  if (!allowEmpty && ids.length === 0) errors.push(`${pathName} must include evidence_ids`);
  for (const id of ids) {
    if (!evidenceIds.has(id)) errors.push(`${pathName} references unknown evidence id ${id}`);
  }
}

function validateFlexibleClaims(items = [], pathName, evidenceIds, errors) {
  if (!Array.isArray(items)) {
    errors.push(`${pathName} must be an array`);
    return;
  }
  for (const [index, item] of items.entries()) {
    if (!item || typeof item !== "object") {
      errors.push(`${pathName}[${index}] must be an object`);
      continue;
    }
    const status = item.status || "inferred";
    const ids = evidenceIdList(item);
    if (status === "confirmed" && ids.length === 0) errors.push(`${pathName}[${index}] confirmed claim requires evidence`);
    validateSimpleEvidenceRefs(ids, evidenceIds, `${pathName}[${index}]`, errors, true);
    const claimText = String(item.claim || item.inference || item.risk || "").toLowerCase();
    if (status === "confirmed" && ["does not", "no online", "no booking", "not have"].some(word => claimText.includes(word))) {
      errors.push(`${pathName}[${index}] cannot state absence as a confirmed fact`);
    }
  }
}

function validateAssessmentSection(section, pathName, evidenceIds, errors) {
  if (!section || typeof section !== "object" || Array.isArray(section)) {
    errors.push(`${pathName} must be an object`);
    return;
  }
  const status = section.status || "assessed";
  if (!["assessed", "insufficient_evidence", "complete"].includes(status)) errors.push(`${pathName}.status is invalid`);
  if (typeof section.summary !== "string") errors.push(`${pathName}.summary is required`);
  validateSimpleEvidenceRefs(evidenceIdList(section), evidenceIds, pathName, errors, status !== "assessed");
  if (section.confidence && !CLAIM_CONFIDENCE.has(section.confidence)) errors.push(`${pathName}.confidence must be high, medium, or low`);
}

function validateModuleOutput(moduleKey, output = {}, contextPackage = {}, priorModules = {}, meta = {}) {
  const errors = [];
  meta.normalization_applied = !!meta.normalization_applied;
  meta.normalized_fields = meta.normalized_fields || [];
  const contextEvidence = Array.isArray(contextPackage.evidenceLog) ? contextPackage.evidenceLog.map(item => ({
    id: item.id || item.evidence_id,
    source_type: item.sourceType || item.source_type,
    source_url: item.sourceUrl || item.source_url,
    excerpt: item.excerpt || item.source_excerpt || ""
  })).filter(item => item.id) : [];
  const foundationEvidence = [
    ...contextEvidence,
    ...(priorModules.foundation?.output?.evidence_log || []),
    ...(output.evidence_log || [])
  ];
  const evidenceIds = new Set((foundationEvidence || []).map(item => item.id));

  if (moduleKey === "foundation") {
    ensureObjectField(output, "business_identity", {}, meta);
    ensureArrayField(output, "contacts", meta);
    ensureArrayField(output, "evidence_log", meta);
    if (output.evidence_log.length === 0 && contextEvidenceLog(contextPackage).length) {
      output.evidence_log = contextEvidenceLog(contextPackage);
      recordNormalization(meta, "evidence_log");
    }
    ensureArrayField(output, "confirmed_facts", meta);
    ensureArrayField(output, "inferences", meta);
    ensureArrayField(output, "unknowns", meta);
    output.contacts = output.contacts.map((contact, index) => normalizeContact(contact, index, meta));
    output.confirmed_facts = output.confirmed_facts.map((item, index) => normalizeClaimItem(item, `confirmed_facts[${index}]`, meta)).filter(Boolean);
    output.inferences = output.inferences.map((item, index) => normalizeClaimItem(item, `inferences[${index}]`, meta)).filter(Boolean);
    cleanModuleContacts(output, meta);
    const identity = output.business_identity || {};
    if (!identity.name && contextPackage.businessIdentity?.businessName) {
      identity.name = contextPackage.businessIdentity.businessName;
      recordNormalization(meta, "business_identity.name");
    }
    if (typeof identity.name !== "string" || !identity.name.trim()) errors.push("business_identity.name must be a non-empty string");
    if (!("website" in identity)) identity.website = null;
    if (!("industry" in identity)) identity.industry = null;
    if (!("location" in identity)) identity.location = null;
    if (!("summary" in identity)) identity.summary = null;
    validateEvidenceItems(output.evidence_log, "evidence_log", errors, "snake");
    const localEvidenceIds = new Set((output.evidence_log || []).map(item => item.id));
    validateContacts(output.contacts, localEvidenceIds, errors);
    validateFlexibleClaims(output.confirmed_facts, "confirmed_facts", localEvidenceIds, errors);
    validateFlexibleClaims(output.inferences, "inferences", localEvidenceIds, errors);
  } else if (moduleKey === "digital_intelligence") {
    const fallback = safeModuleFallback(moduleKey, contextPackage);
    ensureObjectField(output, "business_dna", fallback.business_dna, meta);
    ensureObjectField(output, "digital_health", fallback.digital_health, meta);
    ensureObjectField(output, "ai_discoverability", fallback.ai_discoverability, meta);
    ensureObjectField(output, "future_readiness", fallback.future_readiness, meta);
    output.business_dna = normalizeAssessment(output.business_dna, "business_dna", meta, "Insufficient public evidence was available for business DNA.");
    if (!hasUsefulValue(output.business_dna) || output.business_dna.status === "insufficient_evidence" || !hasBusinessDnaScoringFields(output.business_dna)) {
      const evidenceBackedDna = synthesizeBusinessDnaFromEvidence(contextPackage, priorModules);
      if (evidenceBackedDna) {
        const existingEvidenceIds = evidenceIdList(output.business_dna);
        output.business_dna = {
          ...evidenceBackedDna,
          ...output.business_dna,
          status: "assessed",
          evidence_ids: uniqueArray([...evidenceBackedDna.evidence_ids, ...existingEvidenceIds])
        };
        recordNormalization(meta, "business_dna.evidence_backed_synthesis");
      }
    }
    output.digital_health = normalizeDigitalHealth(output.digital_health, meta);
    output.ai_discoverability = normalizeAssessment(output.ai_discoverability, "ai_discoverability", meta, "Insufficient public evidence was available for AI discoverability.");
    output.future_readiness = normalizeAssessment(output.future_readiness, "future_readiness", meta, "Insufficient public evidence was available for future readiness.");
    for (const key of ["business_dna", "digital_health", "ai_discoverability", "future_readiness"]) {
      validateAssessmentSection(output[key], key, evidenceIds, errors);
    }
    if (output.digital_health.status === "assessed") {
      const subScores = output.digital_health.sub_scores;
      if (!subScores || typeof subScores !== "object") errors.push("digital_health.sub_scores is required when assessed");
    } else {
      output.digital_health.sub_scores = output.digital_health.sub_scores || null;
      output.digital_health.total_score = output.digital_health.total_score ?? null;
    }
  } else if (moduleKey === "opportunities") {
    ensureArrayField(output, "hidden_opportunities", meta);
    output.hidden_opportunities = output.hidden_opportunities.map((item, index) => normalizeOpportunityItem(item, index, evidenceIds, meta)).filter(Boolean);
    output.money_left_on_table = normalizeMoneyForModule(output.money_left_on_table, meta);
    ensureObjectField(output, "ai_opportunity_radar", safeRadarFallback(), meta);
    ensureArrayField(output, "risks", meta);
    for (const key of RADAR_DIMENSIONS) {
      if (!output.ai_opportunity_radar[key] || typeof output.ai_opportunity_radar[key] !== "object") {
        output.ai_opportunity_radar[key] = safeRadarFallback()[key];
        recordNormalization(meta, `ai_opportunity_radar.${key}`);
      }
      output.ai_opportunity_radar[key].confidence = normalizeConfidence(output.ai_opportunity_radar[key].confidence);
      output.ai_opportunity_radar[key].status = ["strong", "moderate", "weak", "unknown"].includes(String(output.ai_opportunity_radar[key].status || "").toLowerCase())
        ? String(output.ai_opportunity_radar[key].status || "").toLowerCase()
        : "unknown";
      normalizeEvidenceIds(output.ai_opportunity_radar[key], `ai_opportunity_radar.${key}.evidence_ids`, meta);
    }
    output.risks = output.risks.map((item, index) => normalizeClaimItem(item, `risks[${index}]`, meta)).filter(Boolean);
    validateHiddenOpportunities(output.hidden_opportunities, evidenceIds, errors);
    validateMoneyLeftOnTable(output.money_left_on_table, evidenceIds, errors);
    for (const [key, item] of Object.entries(output.ai_opportunity_radar || {})) {
      if (!item || typeof item !== "object") {
        errors.push(`ai_opportunity_radar.${key} must be an object`);
        continue;
      }
      if (!["strong", "moderate", "weak", "unknown"].includes(item.status || "unknown")) errors.push(`ai_opportunity_radar.${key}.status is invalid`);
      validateSimpleEvidenceRefs(evidenceIdList(item), evidenceIds, `ai_opportunity_radar.${key}`, errors, true);
    }
    validateFlexibleClaims(output.risks, "risks", evidenceIds, errors);
  } else if (moduleKey === "strategic_interpretation") {
    ensureObjectField(output, "why_we_chose_you", safeEvidenceSectionFallback("Insufficient public evidence was available to explain why this business deserves attention."), meta);
    ensureObjectField(output, "one_day_action_plan", safeEvidenceSectionFallback("Insufficient public evidence was available to create a responsible one-day action plan."), meta);
    for (const key of ["why_we_chose_you", "one_day_action_plan"]) {
      output[key] = normalizeAssessment(output[key], key, meta, key === "why_we_chose_you" ? "Insufficient public evidence was available to explain why this business deserves attention." : "Insufficient public evidence was available to create a responsible one-day action plan.");
      const status = output[key].status || "complete";
      if (!["assessed", "complete", "insufficient_evidence"].includes(status)) errors.push(`${key}.status is invalid`);
      validateSimpleEvidenceRefs(evidenceIdList(output[key]), evidenceIds, key, errors, true);
    }
  } else if (moduleKey === "contact_decision") {
    ensureObjectField(output, "contact_decision", safeModuleFallback(moduleKey, contextPackage).contact_decision, meta);
    ensureObjectField(output, "brain_two_handoff", safeModuleFallback(moduleKey, contextPackage).brain_two_handoff, meta);
    const decision = output.contact_decision;
    decision.decision_confidence = normalizeConfidence(decision.decision_confidence);
    decision.callcatch_opportunity_score = numberOrNull(decision.callcatch_opportunity_score);
    normalizeEvidenceIds(decision, "contact_decision.evidence_ids", meta);
    if (!["CONTACT", "DO NOT CONTACT"].includes(decision.decision)) {
      decision.recommendation_status = decision.decision || "NEEDS_REVIEW";
      decision.decision = "DO NOT CONTACT";
      recordNormalization(meta, "contact_decision.decision");
    }
    validateContactDecision(decision, evidenceIds, errors);
    if (output.brain_two_handoff?.do_not_automate_outbound !== true) errors.push("brain_two_handoff.do_not_automate_outbound must be true");
    if (output.brain_two_handoff?.approved_for_handoff !== false) errors.push("brain_two_handoff.approved_for_handoff must remain false");
    const opportunities = priorModules.opportunities?.output?.hidden_opportunities || [];
    const contacts = priorModules.foundation?.output?.contacts || [];
    const hasOpportunity = opportunities.some(item => evidenceIdList(item).length > 0 && String(item.confidence || "").toLowerCase() !== "low");
    const hasContact = contacts.some(item => item.contact_email || item.contact_phone);
    if (decision?.decision === "CONTACT" && (!hasOpportunity || !hasContact)) {
      errors.push("CONTACT decision requires validated opportunity evidence and usable contact data");
    }
  }
  return { ok: errors.length === 0, errors };
}

function moduleResult(moduleKey, status, output, meta = {}, extra = {}) {
  return {
    status,
    output,
    normalization_applied: !!meta.normalization_applied,
    normalized_fields: meta.normalized_fields || [],
    parser_errors: extra.parser_errors || [],
    validation_errors: extra.validation_errors || [],
    raw_response: extra.raw_response || "",
    repaired: !!extra.repaired
  };
}

function dangerousModuleErrors(errors = []) {
  const dangerousPatterns = [
    /owner_name must not contain an email/i,
    /contact_name must not contain an email/i,
    /generic mailbox/i,
    /unknown evidence id/i,
    /confirmed claim requires evidence/i,
    /cannot state absence as a confirmed fact/i,
    /CONTACT decision requires/i,
    /business_identity\.name must be a non-empty string/i
  ];
  return errors.filter(error => dangerousPatterns.some(pattern => pattern.test(error)));
}

function salvageModuleOutput(moduleKey, parsed, contextPackage, priorModules, parserErrors = [], validationErrors = []) {
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const meta = { normalization_applied: true, normalized_fields: [`${moduleKey}.salvaged_partial`] };
  const validation = validateModuleOutput(moduleKey, parsed, contextPackage, priorModules, meta);
  const dangerous = dangerousModuleErrors([...(validation.errors || []), ...validationErrors]);
  if (validation.ok || dangerous.length === 0) {
    return moduleResult(moduleKey, "partial", parsed, meta, {
      parser_errors: parserErrors,
      validation_errors: validation.errors || validationErrors,
      repaired: true
    });
  }
  return null;
}

function scoreMeta(value, status, componentsUsed = [], componentsMissing = [], evidenceIds = []) {
  return {
    value: value === null || value === undefined ? null : value,
    status,
    components_used: componentsUsed,
    components_missing: componentsMissing,
    evidence_ids: uniqueArray(evidenceIds)
  };
}

function confidencePercent(value) {
  const confidence = normalizeConfidence(value);
  if (confidence === "high") return 90;
  if (confidence === "medium") return 65;
  return 35;
}

function levelScore(value) {
  const text = String(value || "").toLowerCase();
  if (/excellent|advanced|strong|high|mature|enterprise|world.?class/.test(text)) return 92;
  if (/moderate|medium|developing|basic|visible/.test(text)) return 68;
  if (/weak|low|early|limited/.test(text)) return 38;
  return null;
}

function averageScore(values = []) {
  const clean = values.map(numberOrNull).filter(value => value !== null);
  if (!clean.length) return null;
  return Math.round(clean.reduce((sum, value) => sum + value, 0) / clean.length);
}

function clampScore(value) {
  const number = numberOrNull(value);
  return number === null ? null : clampNumber(number, 0, 100);
}

function scoreCard(key, label, value, {
  status = "",
  confidence = "",
  explanation = "",
  evidenceIds = [],
  evidenceCategories = [],
  evidenceReceived = null,
  expectedEvidence = [],
  componentsUsed = [],
  componentsMissing = []
} = {}) {
  const numeric = clampScore(value);
  const finalStatus = status || (numeric === null ? "insufficient_evidence" : "assessed");
  const normalizedEvidenceCategories = uniqueArray((evidenceCategories || []).filter(Boolean));
  const receivedCount = numberOrNull(evidenceReceived);
  const evidenceUsed = evidenceIds.length;
  return {
    key,
    label,
    value: numeric,
    status: finalStatus,
    confidence: confidence || (numeric === null ? "low" : numeric >= 80 ? "high" : numeric >= 55 ? "medium" : "low"),
    explanation: explanation || (numeric === null ? "Insufficient module-specific evidence." : `${label} was scored from its own module evidence.`),
    evidence_ids: uniqueArray(evidenceIds),
    evidence_count_used: evidenceUsed,
    evidence_categories_used: normalizedEvidenceCategories,
    components_used: componentsUsed,
    components_missing: componentsMissing,
    diagnostics: {
      module_name: label,
      expected_evidence: expectedEvidence,
      evidence_received: receivedCount === null ? 0 : receivedCount,
      evidence_actually_used: evidenceUsed,
      evidence_categories_used: normalizedEvidenceCategories,
      reason_score_could_not_be_generated: numeric === null ? (componentsMissing.length ? componentsMissing.join(", ") : "No usable module-specific evidence was available.") : ""
    }
  };
}

function evidenceText(item = {}) {
  const value = item.value;
  const valueText = value && typeof value === "object" ? JSON.stringify(value) : String(value || "");
  return [
    item.field,
    item.category,
    item.sourceCategory,
    item.sourceType,
    item.sourceProvider,
    item.provider,
    item.sourceUrl,
    item.source_url,
    item.excerpt,
    item.source_excerpt,
    valueText
  ].filter(Boolean).join(" ").toLowerCase();
}

function evidenceCategories(items = []) {
  return uniqueArray(items.flatMap(item => [
    evidenceCategoryOf(item),
    evidenceProviderOf(item),
    evidenceFieldOf(item)
  ]).filter(Boolean));
}

function evidenceIds(items = []) {
  return uniqueArray(items.map(item => item.id || item.evidence_id).filter(Boolean));
}

function evidenceHas(item = {}, patterns = []) {
  const text = evidenceText(item);
  return patterns.some(pattern => pattern.test(text));
}

function evidenceMatchesScoringModule(moduleKey, item = {}) {
  const provider = evidenceProviderOf(item);
  const category = evidenceCategoryOf(item);
  const field = evidenceFieldOf(item);
  if (moduleKey === "digital_health") {
    return /website|feature|technical|content|crawl/.test(provider)
      || /website_page|technical|content|feature|access/.test(category)
      || /booking|form|chat|mobile|speed|metadata|heading|content|page_text|snapshot|robots|https|navigation|accessibility|schema/i.test(field);
  }
  if (moduleKey === "ai_discoverability") {
    return /content|website|technical|crawl|trust|identity/.test(provider)
      || /content|website_page|technical|identity|trust/.test(category)
      || /schema|metadata|heading|content|page_text|faq|api|developer|documentation|robots|sitemap|description/i.test(field);
  }
  if (moduleKey === "future_readiness") {
    return /content|website|technical|feature|identity|trust/.test(provider)
      || /content|website_page|technical|feature|identity|trust/.test(category)
      || /api|developer|integration|automation|cloud|ai|platform|roadmap|booking|chat|metadata|content/i.test(field)
      || evidenceHas(item, [/api/, /developer/, /integration/, /automation/, /\bai\b/, /artificial intelligence/, /cloud/, /platform/, /ecosystem/, /roadmap/]);
  }
  return false;
}

function moduleEvidenceForScoring(moduleKey, contextPackage = {}) {
  const evidence = Array.isArray(contextPackage.evidenceLog) ? contextPackage.evidenceLog : [];
  const hasBrainZeroContract = !!contextPackage.brainZero || evidence.some(item => item.sourceProvider || item.sourceCategory || item.category || item.field);
  if (!hasBrainZeroContract) return [];
  return evidence.filter(item => evidenceMatchesScoringModule(moduleKey, item));
}

function confidenceFromEvidence(count = 0, signalCount = 0) {
  if (count >= 8 && signalCount >= 5) return "high";
  if (count >= 3 && signalCount >= 2) return "medium";
  return "low";
}

function scoreFromEvidenceSignals(evidence = [], signalMap = []) {
  const signals = signalMap
    .filter(signal => evidence.some(item => evidenceHas(item, signal.patterns)))
    .map(signal => signal.name);
  if (!evidence.length || !signals.length) {
    return { score: null, signals, confidence: "low" };
  }
  const score = Math.min(95, 34 + (signals.length * 9) + Math.min(18, evidence.length * 2));
  return {
    score,
    signals,
    confidence: confidenceFromEvidence(evidence.length, signals.length)
  };
}

function evidenceBackedDigitalHealth(contextPackage = {}) {
  const evidence = moduleEvidenceForScoring("digital_health", contextPackage);
  const signalMap = [
    { name: "https", patterns: [/https:\/\//, /"https"\s*:\s*true/, /\bhttps\b/] },
    { name: "crawl_success", patterns: [/website_crawl/, /page_text/, /crawl completed/, /status["']?\s*:\s*200/] },
    { name: "technical_implementation", patterns: [/technical_website_evidence/, /technical_snapshot/, /robots/, /metadata/, /final_url/] },
    { name: "ux_navigation", patterns: [/navigation/, /menu/, /heading/, /responsive/, /mobile/] },
    { name: "conversion_path", patterns: [/booking/, /contact_form/, /quote_form/, /schedule/, /demo/, /contact/] },
    { name: "structured_content", patterns: [/content_snapshot/, /structured/, /schema/, /faq/, /service_descriptions_present/] },
    { name: "accessibility_or_performance", patterns: [/accessibility/, /performance/, /speed/, /alt text/, /viewport/] }
  ];
  return { ...scoreFromEvidenceSignals(evidence, signalMap), evidence };
}

function evidenceBackedAiDiscoverability(contextPackage = {}) {
  const evidence = moduleEvidenceForScoring("ai_discoverability", contextPackage);
  const signalMap = [
    { name: "semantic_content", patterns: [/heading/, /page_text/, /content_snapshot/, /description/, /service_descriptions_present/] },
    { name: "structured_metadata", patterns: [/schema/, /metadata/, /json-ld/, /open graph/, /title/, /meta/] },
    { name: "crawlability", patterns: [/robots/, /sitemap/, /crawl/, /index/] },
    { name: "answer_ready_content", patterns: [/faq/, /documentation/, /help center/, /guide/, /resources/] },
    { name: "developer_or_api_content", patterns: [/\bapi\b/, /developer/, /docs/, /integration/] },
    { name: "public_knowledge_signals", patterns: [/reviews/, /testimonials/, /trust/, /partners/, /case stud/] }
  ];
  return { ...scoreFromEvidenceSignals(evidence, signalMap), evidence };
}

function evidenceBackedFutureReadiness(contextPackage = {}) {
  const evidence = moduleEvidenceForScoring("future_readiness", contextPackage);
  const signalMap = [
    { name: "ai_or_automation", patterns: [/\bai\b/, /artificial intelligence/, /automation/, /machine learning/, /workflow/] },
    { name: "api_or_developer_ecosystem", patterns: [/\bapi\b/, /developer/, /sdk/, /docs/, /webhook/] },
    { name: "integrations", patterns: [/integration/, /connectors?/, /marketplace/, /app ecosystem/] },
    { name: "cloud_or_platform", patterns: [/cloud/, /platform/, /infrastructure/, /enterprise/] },
    { name: "digital_maturity", patterns: [/online booking/, /chat/, /customer portal/, /self-service/, /metadata/, /structured/] },
    { name: "roadmap_or_innovation", patterns: [/roadmap/, /innovation/, /new product/, /release/, /beta/] }
  ];
  return { ...scoreFromEvidenceSignals(evidence, signalMap), evidence };
}

function scoreBusinessFoundation(flat = {}) {
  const identity = flat.business_identity || {};
  const dna = flat.business_dna || {};
  const components = [
    identity.name || identity.business_name ? 20 : null,
    identity.website || identity.website_url ? 10 : null,
    identity.industry || identity.trade || dna.primary_services?.length ? 15 : null,
    identity.location || dna.geographic_market ? 10 : null,
    hasUsefulValue(dna.business_model) ? 15 : null,
    hasUsefulValue(dna.customer_journey) ? 15 : null,
    hasUsefulValue(dna.value_proposition) ? 15 : null
  ].filter(value => value !== null);
  const score = components.length ? Math.min(100, components.reduce((sum, value) => sum + value, 0)) : null;
  return scoreCard("business_foundation", "Business Foundation", score, {
    explanation: score === null ? "Company identity and business foundation could not be established." : "Company identity, market, business model, journey, and value proposition were evaluated independently of contact data.",
    evidenceIds: [...evidenceIdList(dna), ...evidenceIdList(identity)],
    componentsUsed: ["identity", "services", "business_model", "customer_journey", "market", "value_proposition"],
    componentsMissing: score === null ? ["business_foundation"] : []
  });
}

function scoreBusinessDna(flat = {}) {
  const dna = flat.business_dna || {};
  const fields = BUSINESS_DNA_SCORING_FIELDS;
  const present = fields.filter(key => hasUsefulValue(dna[key]));
  const score = present.length ? Math.round((present.length / fields.length) * 100) : null;
  return scoreCard("business_dna", "Business DNA", score, {
    confidence: dna.confidence,
    explanation: score === null ? "Business DNA was not established." : "Business DNA is scored only from business model, services, journey, market, revenue drivers, and positioning evidence.",
    evidenceIds: evidenceIdList(dna),
    componentsUsed: present,
    componentsMissing: fields.filter(key => !present.includes(key))
  });
}

function scoreDigitalHealth(flat = {}, contextPackage = {}) {
  const digital = flat.digital_health || {};
  const evidenceScore = evidenceBackedDigitalHealth(contextPackage);
  const modelScore = clampScore(digital.total_score ?? digital.score ?? averageScore(Object.values(digital.sub_scores || {}).map(item => item?.score)));
  const score = modelScore ?? evidenceScore.score;
  const usedEvidenceIds = uniqueArray([...evidenceIdList(digital), ...evidenceIds(evidenceScore.evidence)]);
  const components = uniqueArray([
    ...Object.keys(digital.sub_scores || {}),
    ...evidenceScore.signals
  ]);
  return scoreCard("digital_health", "Digital Health", score, {
    status: score === null ? "insufficient_evidence" : "assessed",
    confidence: digital.confidence || evidenceScore.confidence,
    explanation: score === null ? "Website and UX evidence was not sufficient for a digital health score." : "Digital Health is scored from website, HTTPS, crawl, UX, structure, accessibility, technical, and conversion-path evidence only.",
    evidenceIds: usedEvidenceIds,
    evidenceCategories: evidenceCategories(evidenceScore.evidence),
    evidenceReceived: moduleEvidenceForScoring("digital_health", contextPackage).length,
    expectedEvidence: ["HTTPS", "technical implementation", "crawl success", "UX/navigation", "responsiveness", "accessibility", "structured content", "performance indicators"],
    componentsUsed: components,
    componentsMissing: score === null ? ["website_or_digital_evidence"] : []
  });
}

function scoreAiDiscoverability(flat = {}, contextPackage = {}) {
  const ai = flat.ai_discoverability || {};
  const subScore = averageScore(Object.values(ai.sub_scores || {}));
  const evidenceScore = evidenceBackedAiDiscoverability(contextPackage);
  const score = clampScore(ai.score ?? subScore ?? levelScore(ai.summary || ai.status)) ?? evidenceScore.score;
  const usedEvidenceIds = uniqueArray([...evidenceIdList(ai), ...evidenceIds(evidenceScore.evidence)]);
  const components = uniqueArray([
    ...(Object.keys(ai.sub_scores || {}).length ? Object.keys(ai.sub_scores) : []),
    ...evidenceScore.signals,
    ...(hasUsefulValue(ai.improvement_actions) ? ["improvement_actions"] : [])
  ]);
  return scoreCard("ai_discoverability", "AI Discoverability", score, {
    status: score === null ? "insufficient_evidence" : "assessed",
    confidence: ai.confidence || evidenceScore.confidence,
    explanation: score === null ? "AI-readable content evidence was not sufficient." : "AI Discoverability is scored from semantic HTML/content, schema or metadata, crawlability, documentation, API/developer content, and public knowledge signals only.",
    evidenceIds: usedEvidenceIds,
    evidenceCategories: evidenceCategories(evidenceScore.evidence),
    evidenceReceived: moduleEvidenceForScoring("ai_discoverability", contextPackage).length,
    expectedEvidence: ["semantic HTML", "structured content", "schema/metadata", "robots/crawlability", "FAQ/documentation", "API/developer documentation", "AI-readable public knowledge"],
    componentsUsed: components,
    componentsMissing: score === null ? ["ai_readable_content"] : []
  });
}

function scoreFutureReadiness(flat = {}, contextPackage = {}) {
  const future = flat.future_readiness || {};
  const evidenceScore = evidenceBackedFutureReadiness(contextPackage);
  const score = clampScore(future.score ?? levelScore(future.readiness_level || future.status || future.summary) ?? (hasUsefulValue(future.fastest_improvement) ? confidencePercent(future.confidence) : null)) ?? evidenceScore.score;
  const usedEvidenceIds = uniqueArray([...evidenceIdList(future), ...evidenceIds(evidenceScore.evidence)]);
  const components = uniqueArray([
    ...["readiness_level", "fastest_improvement", "blockers"].filter(key => hasUsefulValue(future[key])),
    ...evidenceScore.signals
  ]);
  return scoreCard("future_readiness", "Future Readiness", score, {
    status: score === null ? "insufficient_evidence" : "assessed",
    confidence: future.confidence || evidenceScore.confidence,
    explanation: score === null ? "Innovation, automation, or roadmap signals were not sufficient." : "Future Readiness is scored from AI, automation, APIs, cloud infrastructure, integrations, digital maturity, developer ecosystem, and roadmap signals only.",
    evidenceIds: usedEvidenceIds,
    evidenceCategories: evidenceCategories(evidenceScore.evidence),
    evidenceReceived: moduleEvidenceForScoring("future_readiness", contextPackage).length,
    expectedEvidence: ["AI products", "automation", "APIs", "cloud infrastructure", "integrations", "developer ecosystem", "innovation signals", "roadmap indicators"],
    componentsUsed: components,
    componentsMissing: score === null ? ["future_readiness_signals"] : []
  });
}

function scoreTrust(flat = {}) {
  const dna = flat.business_dna || {};
  const confirmed = flat.confirmed_facts || [];
  const signals = listField(dna.trust_signals);
  const score = signals.length || confirmed.length ? Math.min(100, 45 + signals.length * 12 + confirmed.length * 8) : null;
  return scoreCard("trust", "Trust", score, {
    confidence: dna.confidence,
    explanation: score === null ? "Trust evidence was not found." : "Trust is scored from public proof such as certifications, partners, testimonials, reviews, policies, and transparency signals.",
    evidenceIds: [...evidenceIdList(dna), ...confirmed.flatMap(evidenceIdList)],
    componentsUsed: ["trust_signals", "confirmed_facts"],
    componentsMissing: score === null ? ["trust_signals"] : []
  });
}

function scoreOpportunity(flat = {}, supportScores = {}) {
  const opportunities = Array.isArray(flat.hidden_opportunities) ? flat.hidden_opportunities : [];
  const scores = opportunities.map(item => item.opportunity_priority_score).map(clampScore).filter(value => value !== null);
  const radar = flat.ai_opportunity_radar || {};
  const radarScores = Object.values(radar).map(item => levelScore(item?.status || item?.opportunity || item?.evidence)).filter(value => value !== null);
  const supportScore = averageScore([
    supportScores.digital_health?.value,
    supportScores.ai_discoverability?.value,
    supportScores.future_readiness?.value
  ]);
  const score = averageScore([
    ...scores,
    averageScore(radarScores),
    supportScore
  ]);
  const radarKeys = Object.entries(radar)
    .filter(([, item]) => item && typeof item === "object" && item.status !== "unknown")
    .map(([key]) => key);
  const supportEvidenceIds = [
    ...(supportScores.digital_health?.evidence_ids || []),
    ...(supportScores.ai_discoverability?.evidence_ids || []),
    ...(supportScores.future_readiness?.evidence_ids || [])
  ];
  return scoreCard("opportunity", "Opportunity", score, {
    explanation: score === null ? "No module-specific operational, conversion, digital, AI, or future-readiness opportunity signals were validated." : "Opportunity Radar is scored from hidden opportunities, AI radar dimensions, Digital Health, AI Discoverability, and Future Readiness without inventing revenue.",
    evidenceIds: uniqueArray([...opportunities.flatMap(evidenceIdList), ...Object.values(radar).flatMap(evidenceIdList), ...supportEvidenceIds]),
    componentsUsed: uniqueArray([
      ...opportunities.map(item => item.title || item.opportunity).filter(Boolean),
      ...radarKeys,
      supportScores.digital_health?.value !== null && supportScores.digital_health?.value !== undefined ? "digital_health" : "",
      supportScores.ai_discoverability?.value !== null && supportScores.ai_discoverability?.value !== undefined ? "ai_discoverability" : "",
      supportScores.future_readiness?.value !== null && supportScores.future_readiness?.value !== undefined ? "future_readiness" : ""
    ].filter(Boolean)),
    componentsMissing: score === null ? ["opportunity_radar_signals"] : []
  });
}

function scoreContactability(flat = {}) {
  const contacts = Array.isArray(flat.contacts) ? flat.contacts : [];
  const hasEmail = contacts.some(item => item.contact_email);
  const hasPhone = contacts.some(item => item.contact_phone);
  const confidenceScores = contacts.map(item => numberOrNull(item.contact_confidence)).filter(value => value !== null);
  const base = (hasEmail ? 45 : 0) + (hasPhone ? 30 : 0) + Math.min(25, Math.round((averageScore(confidenceScores) || 0) / 4));
  const score = contacts.length ? clampScore(base) : 0;
  return scoreCard("contactability", "Contactability", score, {
    status: "assessed",
    explanation: score === 0 ? "No verified outreach path was found." : "Contactability is the only module scored from email, phone, forms, LinkedIn, CRM, or outreach feasibility.",
    evidenceIds: contacts.flatMap(evidenceIdList),
    componentsUsed: [hasEmail ? "email" : "", hasPhone ? "phone" : ""].filter(Boolean),
    componentsMissing: [hasEmail ? "" : "verified_email", hasPhone ? "" : "verified_phone"].filter(Boolean)
  });
}

function decisionEngineFromScores(moduleScores = {}, flat = {}) {
  const contactability = moduleScores.contactability?.value ?? null;
  const opportunity = moduleScores.opportunity?.value ?? null;
  const businessQuality = averageScore([
    moduleScores.business_foundation?.value,
    moduleScores.business_dna?.value,
    moduleScores.digital_health?.value,
    moduleScores.ai_discoverability?.value,
    moduleScores.future_readiness?.value,
    moduleScores.trust?.value
  ]);
  const modelDecision = flat.contact_decision || {};
  const decision = contactability !== null && contactability < 35
    ? "DO NOT CONTACT"
    : opportunity !== null && opportunity < 25
      ? "DO NOT CONTACT"
      : modelDecision.decision || "DO NOT CONTACT";
  const reason = decision === "DO NOT CONTACT" && contactability !== null && contactability < 35
    ? "Excellent business signals may exist, but outreach feasibility is low because no strong verified contact path was found."
    : modelDecision.primary_reason || "Decision is based on independent module scores.";
  return {
    decision,
    reason,
    business_quality_score: businessQuality,
    sales_opportunity_score: averageScore([opportunity, contactability, moduleScores.decision?.value]),
    contactability_score: contactability,
    model_recommendation: modelDecision.decision || "",
    preserves_module_scores: true
  };
}

function hydrateScoreCardDiagnostics(moduleScores = {}, contextPackage = {}) {
  const evidence = Array.isArray(contextPackage.evidenceLog) ? contextPackage.evidenceLog : [];
  const byId = new Map(evidence.map(item => [item.id || item.evidence_id, item]));
  for (const item of Object.values(moduleScores)) {
    if (!item || typeof item !== "object") continue;
    const used = (item.evidence_ids || []).map(id => byId.get(id)).filter(Boolean);
    if (!item.evidence_categories_used?.length && used.length) item.evidence_categories_used = evidenceCategories(used);
    item.evidence_count_used = item.evidence_ids?.length || used.length || item.evidence_count_used || 0;
    item.diagnostics = {
      ...(item.diagnostics || {}),
      evidence_received: item.diagnostics?.evidence_received || evidence.length,
      evidence_actually_used: item.evidence_count_used,
      evidence_categories_used: item.evidence_categories_used || [],
      reason_score_could_not_be_generated: item.value === null
        ? (item.components_missing?.length ? item.components_missing.join(", ") : item.diagnostics?.reason_score_could_not_be_generated || "No usable module-specific evidence was available.")
        : ""
    };
  }
  return moduleScores;
}

function calculateScoreMetadata(combined = {}, contextPackage = {}) {
  const flat = flattenCombinedOutput(combined);
  const digital = flat.digital_health || {};
  const digitalValue = numberOrNull(digital.total_score ?? digital.score);
  const opportunities = Array.isArray(flat.hidden_opportunities) ? flat.hidden_opportunities : [];
  const opportunityScores = opportunities.map(item => numberOrNull(item.opportunity_priority_score)).filter(value => value !== null);
  const contactScore = numberOrNull(flat.contact_decision?.callcatch_opportunity_score);
  const module_scores = {};
  module_scores.business_foundation = scoreBusinessFoundation(flat);
  module_scores.business_dna = scoreBusinessDna(flat);
  module_scores.digital_health = scoreDigitalHealth(flat, contextPackage);
  module_scores.ai_discoverability = scoreAiDiscoverability(flat, contextPackage);
  module_scores.future_readiness = scoreFutureReadiness(flat, contextPackage);
  module_scores.trust = scoreTrust(flat);
  module_scores.opportunity = scoreOpportunity(flat, module_scores);
  module_scores.contactability = scoreContactability(flat);
  module_scores.decision = scoreCard("decision", "Decision Engine", contactScore, {
    status: contactScore === null ? "needs_review" : "model_assisted",
    explanation: flat.contact_decision?.primary_reason || "Decision Engine consumes module scores without overwriting them.",
    evidenceIds: evidenceIdList(flat.contact_decision || {})
  });
  hydrateScoreCardDiagnostics(module_scores, contextPackage);
  const score_metadata = {
    module_scores,
    module_diagnostics: Object.fromEntries(Object.entries(module_scores).map(([key, value]) => [key, value.diagnostics])),
    digital_health: scoreMeta(
      module_scores.digital_health.value ?? digitalValue,
      module_scores.digital_health.status,
      module_scores.digital_health.components_used,
      module_scores.digital_health.components_missing,
      module_scores.digital_health.evidence_ids
    ),
    opportunity_priority: scoreMeta(
      opportunityScores.length ? Math.max(...opportunityScores) : null,
      opportunityScores.length ? "model_assisted" : "needs_review",
      opportunityScores.length ? ["hidden_opportunities"] : [],
      opportunityScores.length ? [] : ["hidden_opportunity_priority_score"],
      opportunities.flatMap(evidenceIdList)
    ),
    callcatch_opportunity: scoreMeta(
      contactScore,
      contactScore === null ? "needs_review" : "model_assisted",
      contactScore === null ? [] : ["contact_decision"],
      contactScore === null ? ["callcatch_opportunity_score"] : [],
      evidenceIdList(flat.contact_decision || {})
    )
  };
  combined.decision_engine = decisionEngineFromScores(module_scores, flat);
  combined.score_metadata = score_metadata;
  combined.module_diagnostics = {
    ...(combined.module_diagnostics || {}),
    score_layer: score_metadata.module_diagnostics
  };
  return score_metadata;
}

function flattenCombinedOutput(combined = {}) {
  if (!combined.modules) return combined;
  return {
    ...(combined.modules.foundation?.output || {}),
    ...(combined.modules.digital_intelligence?.output || {}),
    ...(combined.modules.opportunities?.output || {}),
    ...(combined.modules.strategic_interpretation?.output || {}),
    ...(combined.modules.contact_decision?.output || {})
  };
}

function hasUsefulValue(value) {
  if (Array.isArray(value)) return value.some(hasUsefulValue);
  if (value && typeof value === "object") {
    if (value.status === "insufficient_evidence") return false;
    return Object.entries(value).some(([key, child]) => key !== "evidence_ids" && hasUsefulValue(child));
  }
  const text = compact(value, 300).toLowerCase();
  return !!text && !["unknown", "null", "n/a", "insufficient public evidence was available.", "insufficient evidence"].includes(text);
}

function identityName(identity = {}) {
  return identity.business_name || identity.name || identity.businessName || "This business";
}

function lineFromClaim(item) {
  if (!item) return "";
  if (typeof item === "string") return item;
  return item.claim || item.summary || item.reasoning || item.value || "";
}

function sectionSummary(section = {}) {
  if (!section || typeof section !== "object") return "";
  return section.summary
    || section.what_the_business_does_well
    || section.why_improvements_matter
    || section.potential_fit
    || section.fastest_improvement
    || section.evidence
    || "";
}

function markdownBullets(items = [], { inferred = false } = {}) {
  return items
    .map(item => compact(item, 300))
    .filter(Boolean)
    .map(item => `- ${inferred ? "Inferred: " : ""}${item}`)
    .join("\n");
}

function listField(value) {
  if (Array.isArray(value)) return value.map(item => typeof item === "string" ? item : compact(JSON.stringify(item), 160)).filter(Boolean);
  if (value === null || value === undefined || value === "") return [];
  return [String(value)];
}

function usefulRadarItems(radar = {}) {
  return Object.entries(radar || {})
    .filter(([, item]) => item && typeof item === "object" && item.status !== "unknown" && hasUsefulValue(item.opportunity || item.evidence))
    .map(([key, item]) => {
      const status = item.status || "observed";
      const opportunity = item.opportunity || item.evidence || "";
      const confidence = item.confidence ? ` Confidence: ${item.confidence}.` : "";
      return `${key.replace(/_/g, " ")}: ${status}. ${opportunity}${confidence}`;
    });
}

function actionPlanLines(plan = {}, flat = {}) {
  if (plan && typeof plan === "object" && plan.status !== "insufficient_evidence") {
    const lines = [
      ...listField(plan.first_2_hours).map(item => `First 2 hours: ${item}`),
      ...listField(plan.by_midday).map(item => `By midday: ${item}`),
      ...listField(plan.before_end_of_day).map(item => `Before end of day: ${item}`),
      ...listField(plan.what_to_measure_next_30_days).map(item => `Measure next 30 days: ${item}`)
    ];
    if (lines.length) return lines;
    const summary = sectionSummary(plan);
    if (summary) return [summary];
  }
  const opportunities = Array.isArray(flat.hidden_opportunities) ? flat.hidden_opportunities : [];
  const digital = flat.digital_health || {};
  const fallback = [];
  if (opportunities[0]?.recommended_first_test) fallback.push(`Run this first test: ${opportunities[0].recommended_first_test}`);
  if (digital.summary) fallback.push(`Review the digital path: ${digital.summary}`);
  if (flat.contact_decision?.recommended_outreach_angle) fallback.push(`Use this manual angle: ${flat.contact_decision.recommended_outreach_angle}`);
  return fallback;
}

function scoreStrength(score) {
  if (score === null || score === undefined) return "unknown";
  if (score >= 85) return "strong";
  if (score >= 65) return "moderate";
  if (score >= 35) return "limited";
  return "weak";
}

function executiveSummaryLines(moduleScores = {}, decisionEngine = {}) {
  const foundation = moduleScores.business_foundation?.value;
  const dna = moduleScores.business_dna?.value;
  const digital = moduleScores.digital_health?.value;
  const ai = moduleScores.ai_discoverability?.value;
  const future = moduleScores.future_readiness?.value;
  const contactability = moduleScores.contactability?.value;
  const lines = [];
  if ([foundation, dna].some(value => value !== null && value !== undefined)) {
    lines.push(`This company demonstrates ${scoreStrength(averageScore([foundation, dna]))} business fundamentals. Business identity, services, value proposition, and market position were assessed independently from outreach feasibility.`);
  }
  const digitalParts = [
    digital !== null && digital !== undefined ? `Digital Health is ${scoreStrength(digital)} (${digital}/100)` : "",
    ai !== null && ai !== undefined ? `AI Discoverability is ${scoreStrength(ai)} (${ai}/100)` : "",
    future !== null && future !== undefined ? `Future Readiness is ${scoreStrength(future)} (${future}/100)` : ""
  ].filter(Boolean);
  if (digitalParts.length) lines.push(`${digitalParts.join("; ")}.`);
  if (contactability !== null && contactability !== undefined) {
    lines.push(`Outreach feasibility is ${scoreStrength(contactability)} (${contactability}/100), so the final recommendation can remain ${decisionEngine.decision || "manual review"} even when business quality is high.`);
  }
  if (decisionEngine.decision) lines.push(`Final recommendation: ${decisionEngine.decision}. ${decisionEngine.reason || ""}`.trim());
  return lines;
}

function radarLinesFromModuleScores(moduleScores = {}) {
  const mapping = [
    ["digital_health", "digital health"],
    ["ai_discoverability", "AI discoverability"],
    ["future_readiness", "future readiness"],
    ["opportunity", "opportunity"],
    ["contactability", "contactability"]
  ];
  return mapping.map(([key, label]) => {
    const score = moduleScores[key]?.value;
    if (score === null || score === undefined) return "";
    return `${label}: ${scoreStrength(score)} (${score}/100). ${moduleScores[key]?.explanation || ""}`;
  }).filter(Boolean);
}

function buildFounderBlueprintFromOutput(combined = {}) {
  const flat = flattenCombinedOutput(combined);
  const moduleScores = combined.score_metadata?.module_scores || {};
  const decisionEngine = combined.decision_engine || {};
  const identity = flat.business_identity || {};
  const business = identityName(identity);
  const dna = flat.business_dna || {};
  const confirmed = (flat.confirmed_facts || []).map(lineFromClaim).filter(Boolean);
  const inferences = (flat.inferences || []).map(lineFromClaim).filter(Boolean);
  const opportunities = Array.isArray(flat.hidden_opportunities) ? flat.hidden_opportunities : [];
  const radar = usefulRadarItems(flat.ai_opportunity_radar || {});
  const why = flat.why_we_chose_you || {};
  const digital = flat.digital_health || {};
  const aiDiscoverability = flat.ai_discoverability || {};
  const future = flat.future_readiness || {};
  const money = flat.money_left_on_table || safeMoneyFallback();
  const contact = flat.contact_decision || {};

  const opportunitySummary = executiveSummaryLines(moduleScores, decisionEngine);
  if (hasUsefulValue(dna.business_model)) opportunitySummary.push(`Inferred: ${business} appears to operate as ${dna.business_model}.`);
  if (hasUsefulValue(dna.primary_services)) opportunitySummary.push(`Inferred: Core services include ${listField(dna.primary_services).join(", ")}.`);
  if (hasUsefulValue(dna.geographic_market)) opportunitySummary.push(`Inferred: The visible market focus is ${dna.geographic_market}.`);
  if (hasUsefulValue(dna.value_proposition)) opportunitySummary.push(`Inferred: ${dna.value_proposition}`);
  if (!opportunitySummary.length && confirmed.length) opportunitySummary.push(`Evidence-backed: ${confirmed[0]}`);
  if (!opportunitySummary.length) opportunitySummary.push("Insufficient public evidence was available to produce a reliable opportunity summary.");

  const noticed = [
    ...confirmed.slice(0, 3).map(item => `Evidence-backed: ${item}`),
    ...listField(dna.trust_signals).slice(0, 3).map(item => `Inferred trust signal: ${item}`),
    digital.summary ? `Inferred digital maturity: ${digital.summary}` : "",
    aiDiscoverability.summary ? `Inferred AI discoverability: ${aiDiscoverability.summary}` : "",
    future.fastest_improvement ? `Inferred fastest improvement: ${future.fastest_improvement}` : ""
  ].filter(Boolean);

  const hidden = opportunities.length
    ? opportunities.slice(0, 5).map(item => {
      const title = item.title || item.opportunity || "Opportunity";
      const reason = item.why_it_matters || item.specific_observed_problem || item.likely_business_impact || "";
      const confidence = item.confidence ? ` Confidence: ${item.confidence}.` : "";
      return `${title}: ${reason}${confidence}`;
    })
    : inferences.length
      ? inferences.slice(0, 4).map(item => `Inferred opportunity: ${item}`)
      : ["No specific hidden opportunity was validated from the current public evidence."];

  const moneyLines = money.status === "estimated"
    ? [`Estimated range: ${money.currency || ""}${money.low_estimate} to ${money.currency || ""}${money.high_estimate} ${money.time_period || ""}.`, `Assumptions: ${listField(money.assumptions).join("; ") || "Scenario assumptions were supplied by Brain One."}`, `Method: ${money.calculation_method || "scenario estimate"}. Confidence: ${money.confidence || "low"}.`]
    : ["Unable to responsibly estimate financial opportunity from available public evidence.", ...(opportunities.length ? ["However the following opportunity signals were detected:"] : []), ...opportunities.slice(0, 3).map(item => item.title || item.opportunity || item.specific_observed_problem).filter(Boolean)];

  const whyLines = [];
  if (why.status !== "insufficient_evidence") {
    whyLines.push(...listField(why.observable_strengths).map(item => `Observable strength: ${item}`));
    if (why.what_the_business_does_well) whyLines.push(`What it does well: ${why.what_the_business_does_well}`);
    if (why.why_improvements_matter) whyLines.push(`Why improvements matter: ${why.why_improvements_matter}`);
    if (why.why_not_random) whyLines.push(`Why this is not random: ${why.why_not_random}`);
    if (why.potential_fit) whyLines.push(`Potential fit: ${why.potential_fit}`);
    if (why.summary) whyLines.push(why.summary);
  }
  if (!whyLines.length) {
    if (hasUsefulValue(dna.likely_revenue_drivers)) whyLines.push(`Inferred: Revenue drivers include ${listField(dna.likely_revenue_drivers).join(", ")}.`);
    if (opportunities[0]?.callcatch_relevance) whyLines.push(`Inferred: CallCatch relevance is ${opportunities[0].callcatch_relevance}.`);
    if (contact.primary_reason) whyLines.push(`Decision context: ${contact.primary_reason}`);
  }
  if (!whyLines.length) whyLines.push("Insufficient public evidence was available to explain why this business deserves attention.");

  const actions = actionPlanLines(flat.one_day_action_plan, flat);
  const radarBaseLines = radar.length ? radar : [
    digital.summary ? `digital health: ${digital.summary}` : "",
    aiDiscoverability.summary ? `AI discoverability: ${aiDiscoverability.summary}` : "",
    future.readiness_level || future.summary ? `future readiness: ${future.readiness_level || future.summary}` : ""
  ].filter(Boolean);
  const radarLines = uniqueArray([...radarBaseLines, ...radarLinesFromModuleScores(moduleScores)]);

  const contactLines = [
    contact.recommendation_status || contact.decision ? `Recommendation: ${contact.recommendation_status || contact.decision}` : "",
    contact.primary_reason ? `Reason: ${contact.primary_reason}` : "",
    contact.recommended_outreach_angle ? `Manual outreach angle: ${contact.recommended_outreach_angle}` : "",
    ...(contact.information_gaps || []).slice(0, 3).map(item => `Information gap: ${item}`)
  ].filter(Boolean);
  const scoreLines = Object.values(moduleScores)
    .filter(item => item && item.key !== "decision")
    .map(item => {
      const categories = item.evidence_categories_used?.length ? ` Categories: ${item.evidence_categories_used.slice(0, 5).join(", ")}.` : "";
      return `${item.label}: ${item.value === null ? "Not scored" : `${item.value}/100`}. Confidence: ${item.confidence}. Evidence Used: ${item.evidence_count_used || 0}.${categories} Reason: ${item.explanation}`;
    });
  if (decisionEngine.decision) {
    contactLines.unshift(`Decision Engine: ${decisionEngine.decision}. ${decisionEngine.reason || ""}`.trim());
    if (decisionEngine.business_quality_score !== null && decisionEngine.business_quality_score !== undefined) {
      contactLines.push(`Business quality score: ${decisionEngine.business_quality_score}/100.`);
    }
    if (decisionEngine.contactability_score !== null && decisionEngine.contactability_score !== undefined) {
      contactLines.push(`Contactability score: ${decisionEngine.contactability_score}/100.`);
    }
  }

  return [
    "# Business Growth Blueprint",
    "",
    "## Opportunity Summary",
    markdownBullets(opportunitySummary),
    "",
    "## What We Noticed",
    markdownBullets(noticed.length ? noticed : ["Insufficient public evidence was available for detailed observations."]),
    "",
    "## Independent Module Scores",
    markdownBullets(scoreLines.length ? scoreLines : ["Module scores were not available."]),
    "",
    "## Hidden Opportunities",
    markdownBullets(hidden),
    "",
    "## Money Left on the Table",
    markdownBullets(moneyLines),
    "",
    "## AI Opportunity Radar",
    markdownBullets(radarLines.length ? radarLines : ["Insufficient public evidence was available for radar scoring."]),
    "",
    "## Why This Business Deserves Attention",
    markdownBullets(whyLines),
    "",
    "## If CallCatch Owned This Business For One Day",
    markdownBullets(actions.length ? actions : ["Insufficient public evidence was available to create a responsible one-day action plan."]),
    "",
    "## Contact Decision",
    markdownBullets(contactLines.length ? contactLines : ["Manual review required before any outreach."])
  ].join("\n");
}

function stageLogger(options = {}) {
  const logger = typeof options.logger === "function" ? options.logger : null;
  const start = options.startedAt || Date.now();
  return (stage, meta = {}) => {
    if (logger) logger("info", stage, { elapsedMs: Date.now() - start, ...meta });
  };
}

async function callNvidia(messages, options = {}) {
  const apiKey = options.apiKey || process.env.NVIDIA_API_KEY;
  if (!apiKey) throw new Error("NVIDIA_API_KEY is not configured");
  const fetchImpl = options.fetchImpl || fetch;
  const timeoutMs = resolvedNvidiaTimeoutMs(options.timeoutMs);
  const model = options.model || resolvedNvidiaModel();
  const logStage = stageLogger(options);
  let stage = "nvidia_request_started";
  const maxTokens = Number(options.maxTokens || 3500);
  const temperature = Number(options.temperature ?? 0.1);
  const wantsStructured = options.responseFormat !== false;
  try {
    logStage(stage, { model, timeoutMs, maxTokens, structuredResponseModeRequested: wantsStructured });
    const requestBody = {
      model,
      messages,
      temperature,
      max_tokens: maxTokens,
      stream: false
    };
    if (wantsStructured) requestBody.response_format = { type: "json_object" };
    const response = await fetchImpl(NVIDIA_URL, {
      method: "POST",
      signal: AbortSignal.timeout(timeoutMs),
      headers: {
        "Authorization": `Bearer ${apiKey}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify(requestBody)
    });
    stage = "nvidia_headers_received";
    logStage(stage, { status: response.status, ok: response.ok });
    const rawBody = await response.text();
    stage = "nvidia_response_completed";
    logStage(stage, { status: response.status, bodyBytes: rawBody.length });
    let payload = {};
    try {
      payload = rawBody ? JSON.parse(rawBody) : {};
    } catch {
      payload = { raw: rawBody };
    }
    if (!response.ok) {
      const error = new Error(payload.error?.message || payload.message || `NVIDIA API failed with ${response.status}`);
      error.upstreamStatus = response.status;
      error.upstreamBody = rawBody.slice(0, 4000);
      error.failureStage = stage;
      error.structuredResponseModeAccepted = false;
      throw error;
    }
    const content = payload.choices?.[0]?.message?.content || payload.output_text || "";
    const finishReason = payload.choices?.[0]?.finish_reason || payload.finish_reason || "";
    logStage("nvidia_result_metadata", {
      finishReason,
      responseCharCount: String(content || "").length,
      structuredResponseModeAccepted: wantsStructured
    });
    return {
      content,
      finishReason,
      responseCharCount: String(content || "").length,
      structuredResponseModeAccepted: wantsStructured,
      upstreamStatus: response.status
    };
  } catch (error) {
    const timedOut = error.name === "AbortError" || error.name === "TimeoutError" || /aborted|timeout/i.test(error.message);
    const wrapped = timedOut
      ? new Error(`NVIDIA request timed out after ${timeoutMs}ms at ${stage}`)
      : error;
    wrapped.failureStage = error.failureStage || stage;
    wrapped.upstreamStatus = error.upstreamStatus || 0;
    wrapped.upstreamBody = error.upstreamBody || "";
    wrapped.structuredResponseModeAccepted = error.structuredResponseModeAccepted ?? false;
    logStage("nvidia_request_failed", {
      failureStage: wrapped.failureStage,
      error: wrapped.message,
      upstreamStatus: wrapped.upstreamStatus
    });
    throw wrapped;
  }
}

function buildMessages(contextPackage, repairContext = null) {
  const schemaText = compact(JSON.stringify(combinedSchema), 9000);
  const userContent = repairContext
    ? `Repair the previous Brain One PHASE A JSON output. Return corrected JSON only.\n\nExact parser or validation error:\n${repairContext.errors.join("\n")}\n\nRequired schema:\n${schemaText}\n\nMalformed model output:\n${repairContext.rawResponse}\n\nOriginal context package:\n${JSON.stringify(contextPackage)}\n\nReturn exactly one corrected JSON object. No markdown. No code fences.`
    : `PHASE A - Structured Intelligence.\nReturn compact JSON only matching this schema exactly.\nDo not include the long-form Business Growth Blueprint.\n\nOutput schema:\n${schemaText}\n\nContext package:\n${JSON.stringify(contextPackage)}`;
  return [
    { role: "system", content: RUNTIME_PROMPT },
    { role: "user", content: userContent }
  ];
}

function evidenceCategoryOf(item = {}) {
  return String(item.category || item.evidenceCategory || item.sourceCategory || item.sourceType || item.source_type || "").toLowerCase();
}

function evidenceProviderOf(item = {}) {
  return String(item.provider || item.sourceProvider || item.sourceType || item.source_type || "").toLowerCase();
}

function evidenceFieldOf(item = {}) {
  return String(item.field || "").toLowerCase();
}

function selectEvidenceForModule(moduleKey, contextPackage = {}, priorModules = {}) {
  const evidence = Array.isArray(contextPackage.evidenceLog) ? contextPackage.evidenceLog : [];
  const keepers = {
    foundation: item => /identity|trust|existing|lead|directory|content/.test(evidenceProviderOf(item)) || /identity|trust|contact|content|lead/.test(evidenceCategoryOf(item)) || /business_name|website|location|service|phone|email|description/i.test(evidenceFieldOf(item)),
    digital_intelligence: item => /website|feature|technical|content|crawl/.test(evidenceProviderOf(item)) || /website_page|technical|content|feature/.test(evidenceCategoryOf(item)) || /booking|form|chat|mobile|speed|metadata|heading|content/i.test(evidenceFieldOf(item)),
    opportunities: item => /identity|trust|website|feature|technical|content|contact/.test(evidenceProviderOf(item)) || /identity|trust|website_page|technical|content|contact|feature/.test(evidenceCategoryOf(item)),
    strategic_interpretation: item => /identity|trust|website|feature|technical|content|contact/.test(evidenceProviderOf(item)) || /identity|trust|website_page|technical|content|contact|feature/.test(evidenceCategoryOf(item)),
    contact_decision: item => /identity|contact|trust|existing|lead/.test(evidenceProviderOf(item)) || /identity|contact|trust|lead/.test(evidenceCategoryOf(item)) || /email|phone|business_name|website|location/i.test(evidenceFieldOf(item))
  };
  const selected = evidence.filter(keepers[moduleKey] || (() => true));
  return selected.length ? selected : evidence;
}

function moduleContextPackage(moduleKey, contextPackage = {}, priorModules = {}) {
  const selectedEvidence = selectEvidenceForModule(moduleKey, contextPackage, priorModules);
  return {
    ...contextPackage,
    evidenceLog: selectedEvidence,
    moduleEvidenceCount: selectedEvidence.length,
    totalEvidenceCount: Array.isArray(contextPackage.evidenceLog) ? contextPackage.evidenceLog.length : 0,
    evidenceCoverage: contextPackage.brainZero?.evidenceCoverage || null,
    moduleEvidenceSelection: {
      module: moduleKey,
      selectedEvidenceCount: selectedEvidence.length,
      totalEvidenceCount: Array.isArray(contextPackage.evidenceLog) ? contextPackage.evidenceLog.length : 0,
      selectedEvidenceCategories: [...new Set(selectedEvidence.map(evidenceCategoryOf).filter(Boolean))],
      selectedEvidenceProviders: [...new Set(selectedEvidence.map(evidenceProviderOf).filter(Boolean))]
    }
  };
}

function buildModuleMessages(spec, contextPackage, priorModules = {}, repairContext = null) {
  const schemaText = compact(JSON.stringify(spec.schema), 7000);
  const priorText = compact(JSON.stringify(priorModules), 9000);
  const moduleContext = moduleContextPackage(spec.key, contextPackage, priorModules);
  const userContent = repairContext
    ? `Repair ${spec.label}. Return corrected JSON only.\n\nValidation or parser errors:\n${repairContext.errors.join("\n")}\n\nRequired module schema:\n${schemaText}\n\nModule-specific context package:\n${JSON.stringify(moduleContext)}\n\nValidated prior module outputs:\n${priorText}\n\nMalformed module output:\n${repairContext.rawResponse}\n\nReturn exactly one corrected JSON object for this module. No markdown. No code fences.`
    : `${spec.label}.\n${spec.prompt}\n\nRequired module schema:\n${schemaText}\n\nModule-specific context package:\n${JSON.stringify(moduleContext)}\n\nValidated prior module outputs:\n${priorText}\n\nReturn exactly one valid JSON object for this module only. No markdown. No commentary.`;
  return [
    { role: "system", content: RUNTIME_PROMPT },
    { role: "user", content: userContent }
  ];
}

function buildBlueprintMessages(phaseAOutput) {
  return [
    {
      role: "system",
      content: "You are CALLCATCH BRAIN ONE Phase B. Render a polished founder-facing Business Growth Blueprint in Markdown using only the provided validated combined modular Phase A JSON. Do not add facts, figures, contacts, or claims that are not in Phase A. Do not expose evidence IDs. Do not use model terminology. Do not write outreach email copy or sell CallCatch."
    },
    {
      role: "user",
      content: `PHASE B - Founder-Facing Blueprint Rendering.\nUse this validated combined modular Phase A JSON as the only factual source:\n${JSON.stringify(phaseAOutput)}\n\nReturn Markdown with these sections only:\n# Business Growth Blueprint\n## Opportunity Summary\n## What We Noticed\n## Hidden Opportunities\n## Money Left on the Table\n## AI Opportunity Radar\n## Why This Business Deserves Attention\n## If CallCatch Owned This Business For One Day\n## Contact Decision\n\nIf money_left_on_table.status is "insufficient_evidence", write exactly this idea in plain language: "Insufficient public evidence was available to produce a responsible monetary estimate." Do not show $0, GBP 0, zero loss, or an invented range.\n\nIf a module is partial or insufficient evidence, say so naturally. Do not include internal evidence IDs, parser errors, validation errors, JSON, model terminology, or unsupported claims.`
    }
  ];
}

function modelContent(result) {
  if (typeof result === "string") {
    return {
      content: result,
      finishReason: "",
      responseCharCount: result.length,
      structuredResponseModeAccepted: false
    };
  }
  const content = result?.content || "";
  return {
    content,
    finishReason: result?.finishReason || "",
    responseCharCount: result?.responseCharCount ?? String(content).length,
    structuredResponseModeAccepted: !!result?.structuredResponseModeAccepted,
    upstreamStatus: result?.upstreamStatus || 0
  };
}

async function runBrainOne(contextPackage, options = {}) {
  const logStage = stageLogger(options);
  logStage("brain_one_job_started", {
    evidenceCount: contextPackage?.evidenceLog?.length || 0,
    sourceCount: contextPackage?.sourceUrls?.length || 0
  });
  const inputValidation = validateBrainOneInput(contextPackage);
  if (!inputValidation.ok) {
    const error = new Error(`Brain One input failed validation: ${inputValidation.errors.join("; ")}`);
    error.validationErrors = inputValidation.errors;
    throw error;
  }
  const model = options.model || resolvedNvidiaModel();
  const started = Date.now();
  const callModel = options.callModel || ((messages, callOptions = {}) => callNvidia(messages, { ...options, ...callOptions, model, startedAt: started }));
  const modules = {};
  const completed_modules = [];
  const partial_modules = [];
  const failed_modules = [];
  const rawResponses = {};
  const normalization_metadata = {};
  const module_diagnostics = {};
  let finishReason = "";
  let responseCharCount = 0;
  let structuredResponseModeAccepted = false;

  async function runOneModule(spec) {
    const moduleStarted = Date.now();
    const priorOutputs = Object.fromEntries(Object.entries(modules).map(([key, value]) => [key, value.output]));
    let firstRaw = "";
    let lastRaw = "";
    let lastParsed = null;
    let parserErrors = [];
    let validationErrors = [];
    let meta = { normalization_applied: false, normalized_fields: [] };
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      try {
        const selectedEvidence = selectEvidenceForModule(spec.key, contextPackage, priorOutputs);
        const messages = buildModuleMessages(spec, contextPackage, priorOutputs, attempt === 2 ? { errors: [...parserErrors, ...validationErrors], rawResponse: firstRaw } : null);
        logStage("brain_one_prompt_built", { module: spec.key, attempt, messageCount: messages.length, moduleInputEvidenceCount: selectedEvidence.length });
        module_diagnostics[spec.key] = {
          module: spec.key,
          input_evidence_count: selectedEvidence.length,
          critical_fields_missing: contextPackage.brainZero?.missingCriticalCategories || [],
          validation_errors: validationErrors,
          final_status: "running"
        };
        const result = modelContent(await callModel(
          messages,
          { phase: spec.key, responseFormat: true, maxTokens: spec.maxTokens, temperature: 0.1 }
        ));
        finishReason = result.finishReason || finishReason;
        responseCharCount += Number(result.responseCharCount || 0);
        structuredResponseModeAccepted = structuredResponseModeAccepted || result.structuredResponseModeAccepted;
        const raw = result.content || "";
        if (attempt === 1) firstRaw = raw;
        lastRaw = raw;
        rawResponses[spec.key] = raw;
        const parsed = parseMaybeJson(raw);
        logStage("brain_one_module_parsed", { module: spec.key, attempt, rawBytes: raw.length });
        lastParsed = parsed;
        meta = { normalization_applied: false, normalized_fields: [] };
        const validation = validateModuleOutput(spec.key, parsed, contextPackage, modules, meta);
        logStage("brain_one_module_validation_completed", {
          module: spec.key,
          attempt,
          ok: validation.ok,
          errors: (validation.errors || []).slice(0, 5),
          normalized_fields: meta.normalized_fields
        });
        if (validation.ok) {
          const status = (attempt === 1 && !meta.normalization_applied) ? "completed" : "partial";
          logStage("brain_one_module_completed", { module: spec.key, attempt, status, durationMs: Date.now() - moduleStarted, normalized_fields: meta.normalized_fields });
          module_diagnostics[spec.key] = {
            ...(module_diagnostics[spec.key] || { module: spec.key }),
            validation_errors: validationErrors,
            final_status: status
          };
          return moduleResult(spec.key, status, parsed, meta, {
            raw_response: raw,
            parser_errors: parserErrors,
            validation_errors: validationErrors,
            repaired: attempt === 2
          });
        }
        validationErrors = validation.errors;
        module_diagnostics[spec.key] = {
          ...(module_diagnostics[spec.key] || { module: spec.key }),
          validation_errors: validationErrors,
          final_status: "validation_failed"
        };
        logStage("brain_one_module_validation_failed", { module: spec.key, attempt, errors: validationErrors.slice(0, 5) });
      } catch (error) {
        parserErrors.push(error.message);
        logStage("brain_one_module_parse_failed", { module: spec.key, attempt, error: error.message });
      }
    }
    const salvaged = salvageModuleOutput(spec.key, lastParsed, contextPackage, modules, parserErrors, validationErrors);
    if (salvaged) {
      salvaged.raw_response = lastRaw || rawResponses[spec.key] || firstRaw;
      module_diagnostics[spec.key] = {
        ...(module_diagnostics[spec.key] || { module: spec.key }),
        validation_errors: salvaged.validation_errors || validationErrors,
        final_status: "partial"
      };
      logStage("brain_one_module_salvaged", { module: spec.key, durationMs: Date.now() - moduleStarted, normalized_fields: salvaged.normalized_fields, validation_errors: salvaged.validation_errors.slice(0, 5) });
      return salvaged;
    }
    const fallbackMeta = { normalization_applied: true, normalized_fields: [spec.key] };
    const fallback = safeModuleFallback(spec.key, contextPackage);
    module_diagnostics[spec.key] = {
      ...(module_diagnostics[spec.key] || { module: spec.key }),
      validation_errors: validationErrors,
      final_status: "failed"
    };
    logStage("brain_one_module_fallback", { module: spec.key, durationMs: Date.now() - moduleStarted });
    return moduleResult(spec.key, "failed", fallback, fallbackMeta, {
      raw_response: rawResponses[spec.key] || firstRaw,
      parser_errors: parserErrors,
      validation_errors: validationErrors
    });
  }

  const phaseAStarted = Date.now();
  for (const spec of MODULE_SPECS) {
    const result = await runOneModule(spec);
    modules[spec.key] = result;
    normalization_metadata[spec.key] = {
      normalization_applied: result.normalization_applied,
      normalized_fields: result.normalized_fields
    };
    if (result.status === "completed") completed_modules.push(spec.key);
    else if (result.status === "partial") partial_modules.push(spec.key);
    else failed_modules.push(spec.key);
  }

  const combined = {
    modules,
    overall_status: failed_modules.length ? "partial" : partial_modules.length ? "partial" : "completed",
    completed_modules,
    partial_modules,
    failed_modules,
    normalization_metadata,
    module_diagnostics,
    founder_facing_blueprint: ""
  };
  calculateScoreMetadata(combined, contextPackage);
  const phaseADurationMs = Date.now() - phaseAStarted;
  logStage("brain_one_phase_a_completed", {
    mode: "modular",
    durationMs: phaseADurationMs,
    completed_modules,
    partial_modules,
    failed_modules
  });

  const phaseBStarted = Date.now();
  logStage("brain_one_blueprint_started", { mode: "phase_b_markdown" });
  let blueprintMarkdown = "";
  let phaseBRawResponse = "";
  try {
    try {
      const blueprintResult = modelContent(await callModel(buildBlueprintMessages(combined), { phase: "blueprint", responseFormat: false, maxTokens: 1800, temperature: 0.2 }));
      phaseBRawResponse = String(blueprintResult.content || "").trim();
    } catch (error) {
      logStage("brain_one_blueprint_model_render_failed", { error: error.message, failureStage: error.failureStage });
      if (!completed_modules.length && !partial_modules.length) throw error;
    }
    blueprintMarkdown = buildFounderBlueprintFromOutput(combined);
    const phaseBValidation = validatePhaseBMarkdownAgainstPhaseA(blueprintMarkdown, flattenCombinedOutput(combined));
    logStage("brain_one_blueprint_completed", {
      ok: phaseBValidation.ok,
      markdownBytes: blueprintMarkdown.length,
      errors: (phaseBValidation.errors || []).slice(0, 5),
      deterministic: true,
      modelMarkdownBytes: phaseBRawResponse.length
    });
    const dangerousPhaseB = (phaseBValidation.errors || []).some(error => /evidence IDs|monetary figure/i.test(error));
    if (!phaseBValidation.ok && dangerousPhaseB) {
      combined.founder_facing_blueprint = "Brain One completed with partial intelligence, but the founder-facing report could not be safely rendered.";
    } else {
      combined.founder_facing_blueprint = blueprintMarkdown;
    }
  } catch (error) {
    error.failureStage = error.failureStage || "report_generation";
    logStage("brain_one_blueprint_failed", { error: error.message, failureStage: error.failureStage });
    throw error;
  }
  const phaseBDurationMs = Date.now() - phaseBStarted;
  return {
    model,
    rawResponse: JSON.stringify(rawResponses),
    output: combined,
    phaseAOutput: combined,
    blueprintMarkdown: combined.founder_facing_blueprint,
    phaseARawResponse: JSON.stringify(rawResponses),
    phaseBRawResponse,
    finishReason,
    responseCharCount,
    structuredResponseModeAccepted,
    firstParseFailure: "",
    phaseADurationMs,
    phaseBDurationMs,
    durationMs: Date.now() - started,
    repaired: Object.values(modules).some(item => item.repaired),
    normalization_applied: Object.values(normalization_metadata).some(item => item.normalization_applied),
    normalized_fields: Object.entries(normalization_metadata).flatMap(([key, value]) => (value.normalized_fields || []).map(field => `${key}.${field}`)),
    moduleDiagnostics: module_diagnostics,
    moduleResults: modules,
    overall_status: combined.overall_status
  };
}

function evidenceItem(id, sourceType, sourceUrl, excerpt, capturedAt = nowIso()) {
  return {
    id,
    sourceType,
    sourceUrl: sourceUrl || "",
    excerpt: compact(excerpt, 900),
    capturedAt
  };
}

function buildBrainOneContextPackage(lead = {}, scan = null) {
  const capturedAt = nowIso();
  const sourceUrls = [...new Set([lead.website, lead.mapsUrl, lead.osmUrl, lead.facebook, scan?.url].filter(Boolean))];
  const evidenceLog = [];
  evidenceLog.push(evidenceItem(
    "ev-lead-record",
    "lead-record",
    lead.source || "",
    [
      lead.business,
      lead.trade,
      [lead.city, lead.state, lead.country].filter(Boolean).join(", "),
      lead.phone,
      lead.email,
      lead.address,
      lead.website
    ].filter(Boolean).join(" | "),
    capturedAt
  ));
  if (scan) {
    evidenceLog.push(evidenceItem(
      "ev-website-scan",
      "website",
      scan.url || lead.website || "",
      scan.text || scan.title || scan.description || (scan.ok ? "Website scan completed." : "Website scan failed or returned limited text."),
      capturedAt
    ));
  }
  for (const [index, signal] of (lead.aiInsights || []).slice(0, 5).entries()) {
    evidenceLog.push(evidenceItem(`ev-lead-signal-${index + 1}`, "scraper", lead.source || "", signal, capturedAt));
  }
  const scraperEvidence = evidenceLog.filter(item => ["scraper", "website"].includes(item.sourceType));
  const directoryEvidence = evidenceLog.filter(item => ["lead-record", "directory", "social"].includes(item.sourceType));
  return {
    businessIdentity: {
      businessId: lead.id || "",
      businessName: lead.business || "",
      trade: lead.trade || "",
      city: lead.city || "",
      state: lead.state || "",
      country: lead.country || "US",
      websiteUrl: lead.website || "",
      source: lead.source || ""
    },
    websitePublicText: compact(scan?.text || scan?.description || lead.websiteIntelligence?.summary || "", 10000),
    publicContactDetails: {
      phone: lead.phone || "",
      email: lead.email || "",
      address: lead.address || "",
      owner: lead.owner || ""
    },
    publicSocialOrDirectoryEvidence: directoryEvidence,
    scraperEvidence,
    sourceUrls,
    analysisTimestamp: capturedAt,
    evidenceLog
  };
}

function duplicateBrainOneRun(runs = [], businessId = "") {
  return (runs || []).find(run => run.businessId === businessId && run.executionStatus === "running") || null;
}

function applyBrainOneReviewState(state = {}, { runId, leadId, approved, reviewedBy = "CallCatch user", notes = "", reviewedAt = nowIso() } = {}) {
  const record = (state.brainOneRuns || []).find(item => item.id === runId);
  if (!record) throw new Error("Brain One run not found");
  if (record.executionStatus !== "completed") throw new Error("Only completed Brain One runs can be reviewed");
  record.approvalStatus = approved ? "approved-for-crm-brain-two" : "rejected";
  record.reviewedAt = reviewedAt;
  record.reviewedBy = reviewedBy;
  record.reviewNotes = notes;
  const lead = (state.leads || []).find(item => item.id === (leadId || record.businessId));
  if (lead) {
    lead.brainOneLatestRunId = record.id;
    lead.brainOneApprovalStatus = record.approvalStatus;
    lead.brainOneApprovedAt = approved ? record.reviewedAt : "";
    lead.brainOneSummary = record.blueprintMarkdown || record.validatedOutput?.brain_two_handoff?.summary || "";
    lead.timeline = lead.timeline || [];
    lead.timeline.unshift({
      at: record.reviewedAt,
      text: approved ? "Brain One report approved for CRM/Brain Two handoff. No outbound action triggered." : "Brain One report rejected."
    });
  }
  state.auditLog = state.auditLog || [];
  state.auditLog.unshift({
    id: `audit_${Date.now().toString(36)}`,
    at: record.reviewedAt,
    action: approved ? "brain_one_approved" : "brain_one_rejected",
    details: { runId: record.id, businessId: record.businessId }
  });
  return { run: record, lead };
}

module.exports = {
  applyBrainOneReviewState,
  buildBrainOneContextPackage,
  buildFounderBlueprintFromOutput,
  callNvidia,
  duplicateBrainOneRun,
  flattenCombinedOutput,
  parseMaybeJson,
  resolvedNvidiaModel,
  resolvedNvidiaTimeoutMs,
  runBrainOne,
  normalizeBrainOneOutput,
  markdownToSafeHtml,
  validateModuleOutput,
  validatePhaseBMarkdownAgainstPhaseA,
  validateBrainOneInput,
  validateBrainOneOutput
};
