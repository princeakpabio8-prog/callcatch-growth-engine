const fs = require("fs");
const path = require("path");

const inputSchema = require("../schemas/brain-one-input.json");
const outputSchema = require("../schemas/brain-one-output.json");

const DEFAULT_MODEL = process.env.NVIDIA_MODEL || "meta/llama-3.1-8b-instruct";
const NVIDIA_URL = process.env.NVIDIA_API_URL || "https://integrate.api.nvidia.com/v1/chat/completions";
const RUNTIME_PROMPT = fs.readFileSync(path.join(__dirname, "..", "brains", "brain-one-runtime.md"), "utf8");

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

function recordNormalization(meta, field) {
  if (!meta) return;
  meta.normalization_applied = true;
  meta.normalized_fields = meta.normalized_fields || [];
  if (!meta.normalized_fields.includes(field)) meta.normalized_fields.push(field);
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
  evidenceReferenceCheck(evidenceIdList(section), "contact_decision", evidenceIds, errors);
  const weakEvidence = String(section?.decision_confidence || "").toLowerCase() === "low" || evidenceIdList(section).length === 0;
  if (section?.decision === "CONTACT" && weakEvidence) errors.push("CONTACT decision requires more than weak evidence");
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
  validateRequiredObject(output, "output", outputSchema.required, errors);
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
  const schemaText = compact(JSON.stringify(outputSchema), 9000);
  const userContent = repairContext
    ? `Repair the previous Brain One PHASE A JSON output. Return corrected JSON only.\n\nExact parser or validation error:\n${repairContext.errors.join("\n")}\n\nRequired schema:\n${schemaText}\n\nMalformed model output:\n${repairContext.rawResponse}\n\nOriginal context package:\n${JSON.stringify(contextPackage)}\n\nReturn exactly one corrected JSON object. No markdown. No code fences.`
    : `PHASE A - Structured Intelligence.\nReturn compact JSON only matching this schema exactly.\nDo not include the long-form Business Growth Blueprint.\n\nOutput schema:\n${schemaText}\n\nContext package:\n${JSON.stringify(contextPackage)}`;
  return [
    { role: "system", content: RUNTIME_PROMPT },
    { role: "user", content: userContent }
  ];
}

function buildBlueprintMessages(phaseAOutput) {
  return [
    {
      role: "system",
      content: "You are CALLCATCH BRAIN ONE Phase B. Render a polished founder-facing Business Growth Blueprint in Markdown using only the provided validated Phase A JSON. Do not add facts, figures, contacts, or claims that are not in Phase A. Do not expose evidence IDs. Do not use model terminology. Do not write outreach email copy or sell CallCatch."
    },
    {
      role: "user",
      content: `PHASE B - Founder-Facing Blueprint Rendering.\nUse this validated Phase A JSON as the only factual source:\n${JSON.stringify(phaseAOutput)}\n\nReturn Markdown with these sections only:\n# Business Growth Blueprint\n## Opportunity Summary\n## What We Noticed\n## Hidden Opportunities\n## Money Left on the Table\n## AI Opportunity Radar\n## Why This Business Deserves Attention\n## If CallCatch Owned This Business For One Day\n## Contact Decision\n\nIf money_left_on_table.status is "insufficient_evidence", write exactly this idea in plain language: "Insufficient public evidence was available to produce a responsible monetary estimate." Do not show $0, £0, zero loss, or an invented range.\n\nDo not include internal evidence IDs, JSON, validation terms, or unsupported claims.`
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
  const phaseAStarted = Date.now();
  const firstResult = modelContent(await callModel(buildMessages(contextPackage)));
  const firstRaw = firstResult.content;
  let rawResponse = firstRaw;
  let repairErrors = [];
  let firstParseFailure = "";
  let phaseAOutput = null;
  let phaseAMeta = firstResult;
  let normalizationMeta = { normalization_applied: false, normalized_fields: [] };
  try {
    try {
      logStage("brain_one_json_validation_started", { attempt: 1 });
      const parsed = parseMaybeJson(firstRaw);
      const attemptNormalizationMeta = { normalization_applied: false, normalized_fields: [] };
      const validation = validateBrainOneOutput(parsed, { normalizationMeta: attemptNormalizationMeta });
      if (attemptNormalizationMeta.normalization_applied) {
        logStage("brain_one_output_normalized", { attempt: 1, normalized_fields: attemptNormalizationMeta.normalized_fields });
      }
      if (validation.ok) {
        phaseAOutput = parsed;
        normalizationMeta = attemptNormalizationMeta;
        logStage("brain_one_json_validation_completed", { attempt: 1, ok: true });
      } else {
        firstParseFailure = validation.errors.join("; ");
        logStage("brain_one_json_validation_completed", { attempt: 1, ok: false, errors: validation.errors.slice(0, 5) });
        repairErrors = validation.errors;
      }
    } catch (error) {
      firstParseFailure = error.message;
      logStage("brain_one_json_validation_completed", { attempt: 1, ok: false, errors: [error.message] });
      repairErrors = [error.message];
    }
    let repairedMeta = null;
    if (!phaseAOutput) {
      const repairedResult = modelContent(await callModel(buildMessages(contextPackage, { errors: repairErrors, rawResponse: firstRaw })));
      repairedMeta = repairedResult;
      const repairedRaw = repairedResult.content;
      rawResponse = repairedRaw;
      logStage("brain_one_json_validation_started", { attempt: 2 });
      let repaired = null;
      let repairedValidation = null;
      try {
        repaired = parseMaybeJson(repairedRaw);
        const attemptNormalizationMeta = { normalization_applied: false, normalized_fields: [] };
        repairedValidation = validateBrainOneOutput(repaired, { normalizationMeta: attemptNormalizationMeta });
        if (attemptNormalizationMeta.normalization_applied) {
          logStage("brain_one_output_normalized", { attempt: 2, normalized_fields: attemptNormalizationMeta.normalized_fields });
        }
        if (repairedValidation.ok) normalizationMeta = attemptNormalizationMeta;
      } catch (error) {
        repairedValidation = { ok: false, errors: [error.message] };
      }
      if (!repairedValidation.ok) {
        logStage("brain_one_json_validation_completed", { attempt: 2, ok: false, repairAttemptResult: "failed", errors: repairedValidation.errors.slice(0, 5) });
        const error = new Error(`Brain One output failed validation after repair: ${repairedValidation.errors.join("; ")}`);
        error.validationErrors = repairedValidation.errors;
        error.rawResponse = repairedRaw;
        error.parserError = firstParseFailure;
        error.failureStage = "brain_one_json_validation_completed";
        error.userMessage = "Brain One completed its analysis, but the structured report could not be validated. Please run again.";
        throw error;
      }
      phaseAOutput = repaired;
      phaseAMeta = repairedMeta;
      logStage("brain_one_json_validation_completed", { attempt: 2, ok: true });
    }
    const phaseADurationMs = Date.now() - phaseAStarted;
    logStage("brain_one_phase_a_completed", {
      durationMs: phaseADurationMs,
      finishReason: phaseAMeta.finishReason,
      responseCharCount: phaseAMeta.responseCharCount,
      structuredResponseModeAccepted: phaseAMeta.structuredResponseModeAccepted,
      firstParseFailure: firstParseFailure || "",
      repairAttemptResult: firstParseFailure ? "succeeded" : "not-needed"
    });
    const phaseBStarted = Date.now();
    const blueprintResult = modelContent(await callModel(buildBlueprintMessages(phaseAOutput), { phase: "blueprint", responseFormat: false, maxTokens: 1800, temperature: 0.2 }));
    const blueprintMarkdown = String(blueprintResult.content || "").trim();
    const phaseBValidation = validatePhaseBMarkdownAgainstPhaseA(blueprintMarkdown, phaseAOutput);
    if (!phaseBValidation.ok) {
      const error = new Error(`Brain One Phase B failed validation: ${phaseBValidation.errors.join("; ")}`);
      error.validationErrors = phaseBValidation.errors;
      error.rawResponse = rawResponse;
      error.parserError = phaseBValidation.errors.join("; ");
      error.failureStage = "brain_one_phase_b_validation_completed";
      error.userMessage = "Brain One completed its analysis, but the founder-facing report could not be validated. Please run again.";
      throw error;
    }
    const phaseBDurationMs = Date.now() - phaseBStarted;
    logStage("brain_one_phase_b_completed", {
      durationMs: phaseBDurationMs,
      finishReason: blueprintResult.finishReason,
      responseCharCount: blueprintResult.responseCharCount
    });
    return {
      model,
      rawResponse,
      output: phaseAOutput,
      phaseAOutput,
      blueprintMarkdown,
      phaseARawResponse: rawResponse,
      phaseBRawResponse: blueprintMarkdown,
      finishReason: phaseAMeta.finishReason,
      responseCharCount: phaseAMeta.responseCharCount,
      structuredResponseModeAccepted: phaseAMeta.structuredResponseModeAccepted,
      firstParseFailure: firstParseFailure || "",
      phaseADurationMs,
      phaseBDurationMs,
      durationMs: Date.now() - started,
      repaired: !!firstParseFailure,
      normalization_applied: normalizationMeta.normalization_applied,
      normalized_fields: normalizationMeta.normalized_fields || []
    };
  } catch (error) {
    if (!error.rawResponse) error.rawResponse = rawResponse;
    if (!error.validationErrors) error.validationErrors = [error.message];
    if (!error.parserError) error.parserError = firstParseFailure || error.message;
    if (!error.failureStage) error.failureStage = "brain_one_run_failed";
    logStage("brain_one_failed", { failureStage: error.failureStage, error: error.message });
    throw error;
  }
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
  parseMaybeJson,
  resolvedNvidiaModel,
  resolvedNvidiaTimeoutMs,
  runBrainOne,
  normalizeBrainOneOutput,
  markdownToSafeHtml,
  validatePhaseBMarkdownAgainstPhaseA,
  validateBrainOneInput,
  validateBrainOneOutput
};
