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
    section.status = section.evidence_ids?.length ? "assessed" : "insufficient_evidence";
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
  if (/owner|founder|president/i.test(text) && !(phaseA.contacts || []).some(item => item.owner_name || item.contact_name)) {
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
  const foundationEvidence = priorModules.foundation?.output?.evidence_log || output.evidence_log || [];
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

function calculateScoreMetadata(combined = {}) {
  const flat = flattenCombinedOutput(combined);
  const digital = flat.digital_health || {};
  const digitalValue = numberOrNull(digital.total_score ?? digital.score);
  const opportunities = Array.isArray(flat.hidden_opportunities) ? flat.hidden_opportunities : [];
  const opportunityScores = opportunities.map(item => numberOrNull(item.opportunity_priority_score)).filter(value => value !== null);
  const contactScore = numberOrNull(flat.contact_decision?.callcatch_opportunity_score);
  const score_metadata = {
    digital_health: scoreMeta(
      digitalValue,
      digitalValue === null ? "insufficient_evidence" : "calculated",
      digitalValue === null ? [] : ["digital_health"],
      digitalValue === null ? ["digital_health_score"] : [],
      evidenceIdList(digital)
    ),
    opportunity_priority: scoreMeta(
      opportunityScores.length ? Math.max(...opportunityScores) : null,
      opportunityScores.length ? "calculated" : "insufficient_evidence",
      opportunityScores.length ? ["hidden_opportunities"] : [],
      opportunityScores.length ? [] : ["hidden_opportunities"],
      opportunities.flatMap(item => evidenceIdList(item))
    ),
    callcatch_opportunity: scoreMeta(
      contactScore,
      contactScore === null ? "needs_review" : "model_assisted",
      contactScore === null ? [] : ["contact_decision"],
      contactScore === null ? ["callcatch_opportunity_score"] : [],
      evidenceIdList(flat.contact_decision || {})
    )
  };
  combined.score_metadata = score_metadata;
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

function buildModuleMessages(spec, contextPackage, priorModules = {}, repairContext = null) {
  const schemaText = compact(JSON.stringify(spec.schema), 7000);
  const priorText = compact(JSON.stringify(priorModules), 9000);
  const userContent = repairContext
    ? `Repair ${spec.label}. Return corrected JSON only.\n\nValidation or parser errors:\n${repairContext.errors.join("\n")}\n\nRequired module schema:\n${schemaText}\n\nMalformed module output:\n${repairContext.rawResponse}\n\nOriginal context package:\n${JSON.stringify(contextPackage)}\n\nValidated prior module outputs:\n${priorText}\n\nReturn exactly one corrected JSON object for this module. No markdown. No code fences.`
    : `${spec.label}.\n${spec.prompt}\n\nRequired module schema:\n${schemaText}\n\nContext package:\n${JSON.stringify(contextPackage)}\n\nValidated prior module outputs:\n${priorText}\n\nReturn exactly one valid JSON object for this module only. No markdown. No commentary.`;
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
        const result = modelContent(await callModel(
          buildModuleMessages(spec, contextPackage, priorOutputs, attempt === 2 ? { errors: [...parserErrors, ...validationErrors], rawResponse: firstRaw } : null),
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
        lastParsed = parsed;
        meta = { normalization_applied: false, normalized_fields: [] };
        const validation = validateModuleOutput(spec.key, parsed, contextPackage, modules, meta);
        if (validation.ok) {
          const status = (attempt === 1 && !meta.normalization_applied) ? "completed" : "partial";
          logStage("brain_one_module_completed", { module: spec.key, attempt, status, durationMs: Date.now() - moduleStarted, normalized_fields: meta.normalized_fields });
          return moduleResult(spec.key, status, parsed, meta, {
            raw_response: raw,
            parser_errors: parserErrors,
            validation_errors: validationErrors,
            repaired: attempt === 2
          });
        }
        validationErrors = validation.errors;
        logStage("brain_one_module_validation_failed", { module: spec.key, attempt, errors: validationErrors.slice(0, 5) });
      } catch (error) {
        parserErrors.push(error.message);
        logStage("brain_one_module_parse_failed", { module: spec.key, attempt, error: error.message });
      }
    }
    const salvaged = salvageModuleOutput(spec.key, lastParsed, contextPackage, modules, parserErrors, validationErrors);
    if (salvaged) {
      salvaged.raw_response = lastRaw || rawResponses[spec.key] || firstRaw;
      logStage("brain_one_module_salvaged", { module: spec.key, durationMs: Date.now() - moduleStarted, normalized_fields: salvaged.normalized_fields, validation_errors: salvaged.validation_errors.slice(0, 5) });
      return salvaged;
    }
    const fallbackMeta = { normalization_applied: true, normalized_fields: [spec.key] };
    const fallback = safeModuleFallback(spec.key, contextPackage);
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
    founder_facing_blueprint: ""
  };
  calculateScoreMetadata(combined);
  const phaseADurationMs = Date.now() - phaseAStarted;
  logStage("brain_one_phase_a_completed", {
    mode: "modular",
    durationMs: phaseADurationMs,
    completed_modules,
    partial_modules,
    failed_modules
  });

  const phaseBStarted = Date.now();
  const blueprintResult = modelContent(await callModel(buildBlueprintMessages(combined), { phase: "blueprint", responseFormat: false, maxTokens: 1800, temperature: 0.2 }));
  const blueprintMarkdown = String(blueprintResult.content || "").trim();
  const phaseBValidation = validatePhaseBMarkdownAgainstPhaseA(blueprintMarkdown, flattenCombinedOutput(combined));
  if (!phaseBValidation.ok) {
    combined.founder_facing_blueprint = "Brain One completed with partial intelligence, but the founder-facing report could not be safely rendered.";
  } else {
    combined.founder_facing_blueprint = blueprintMarkdown;
  }
  const phaseBDurationMs = Date.now() - phaseBStarted;
  return {
    model,
    rawResponse: JSON.stringify(rawResponses),
    output: combined,
    phaseAOutput: combined,
    blueprintMarkdown: combined.founder_facing_blueprint,
    phaseARawResponse: JSON.stringify(rawResponses),
    phaseBRawResponse: blueprintMarkdown,
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
