const fs = require("fs");
const path = require("path");

const inputSchema = require("../schemas/brain-one-input.json");
const outputSchema = require("../schemas/brain-one-output.json");

const DEFAULT_MODEL = process.env.NVIDIA_MODEL || "meta/llama-3.1-70b-instruct";
const NVIDIA_URL = process.env.NVIDIA_API_URL || "https://integrate.api.nvidia.com/v1/chat/completions";
const RUNTIME_PROMPT = fs.readFileSync(path.join(__dirname, "..", "brains", "brain-one-runtime.md"), "utf8");

function nowIso() {
  return new Date().toISOString();
}

function compact(value, max = 12000) {
  return String(value || "").replace(/\s+/g, " ").trim().slice(0, max);
}

function parseMaybeJson(raw) {
  const text = String(raw || "").trim();
  if (!text) throw new Error("Brain One returned an empty response");
  try {
    return JSON.parse(text);
  } catch {}
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced) return JSON.parse(fenced[1]);
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start >= 0 && end > start) return JSON.parse(text.slice(start, end + 1));
  throw new Error("Brain One response was not valid JSON");
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

function validateEvidenceItems(items, pathName, errors) {
  if (!Array.isArray(items)) {
    errors.push(`${pathName} must be an array`);
    return;
  }
  for (const [index, item] of items.entries()) {
    validateRequiredObject(item, `${pathName}[${index}]`, ["id", "sourceType", "sourceUrl", "excerpt"], errors);
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

function claimListChecks(items, pathName, evidenceIds, errors, requireAssumptions = false) {
  if (!Array.isArray(items)) {
    errors.push(`${pathName} must be an array`);
    return;
  }
  for (const [index, item] of items.entries()) {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      errors.push(`${pathName}[${index}] must be an object`);
      continue;
    }
    if (!Array.isArray(item.evidenceIds) || item.evidenceIds.length === 0) {
      errors.push(`${pathName}[${index}] must include evidenceIds`);
    } else {
      for (const id of item.evidenceIds) {
        if (!evidenceIds.has(id)) errors.push(`${pathName}[${index}] references unknown evidence id ${id}`);
      }
    }
    if (requireAssumptions && (!Array.isArray(item.assumptions) || item.assumptions.length === 0)) {
      errors.push(`${pathName}[${index}] must include assumptions`);
    }
  }
}

function sectionEvidenceCheck(section, pathName, evidenceIds, errors) {
  if (!section || typeof section !== "object" || Array.isArray(section)) {
    errors.push(`${pathName} must be an object`);
    return;
  }
  if (!Array.isArray(section.evidenceIds) || section.evidenceIds.length === 0) {
    errors.push(`${pathName} must include evidenceIds`);
    return;
  }
  for (const id of section.evidenceIds) {
    if (!evidenceIds.has(id)) errors.push(`${pathName} references unknown evidence id ${id}`);
  }
}

function validateBrainOneOutput(output) {
  const errors = [];
  validateRequiredObject(output, "output", outputSchema.required, errors);
  if (errors.length) return { ok: false, errors };
  validateRequiredObject(output.businessIdentity, "businessIdentity", ["businessName", "websiteUrl", "trade", "location"], errors);
  validateEvidenceItems(output.evidenceLog, "evidenceLog", errors);
  const evidenceIds = new Set((output.evidenceLog || []).map(item => item.id));
  claimListChecks(output.confirmedFacts, "confirmedFacts", evidenceIds, errors);
  claimListChecks(output.inferences, "inferences", evidenceIds, errors);
  claimListChecks(output.hiddenOpportunities, "hiddenOpportunities", evidenceIds, errors);
  claimListChecks(output.revenueOpportunityEstimates, "revenueOpportunityEstimates", evidenceIds, errors, true);
  claimListChecks(output.risks, "risks", evidenceIds, errors);
  sectionEvidenceCheck(output.businessDNA, "businessDNA", evidenceIds, errors);
  sectionEvidenceCheck(output.digitalHealthAssessment, "digitalHealthAssessment", evidenceIds, errors);
  sectionEvidenceCheck(output.aiDiscoverabilityAssessment, "aiDiscoverabilityAssessment", evidenceIds, errors);
  sectionEvidenceCheck(output.recommendedPriority, "recommendedPriority", evidenceIds, errors);
  sectionEvidenceCheck(output.ownerContactConfidence, "ownerContactConfidence", evidenceIds, errors);
  sectionEvidenceCheck(output.businessGrowthBlueprint, "businessGrowthBlueprint", evidenceIds, errors);
  sectionEvidenceCheck(output.brainTwoHandoffContext, "brainTwoHandoffContext", evidenceIds, errors);
  if (output.brainTwoHandoffContext?.doNotAutomateOutbound !== true) {
    errors.push("brainTwoHandoffContext.doNotAutomateOutbound must be true");
  }
  if (output.brainTwoHandoffContext?.approvedForHandoff !== false) {
    errors.push("brainTwoHandoffContext.approvedForHandoff must remain false until manual approval");
  }
  if (!Array.isArray(output.unknowns)) errors.push("unknowns must be an array");
  return { ok: errors.length === 0, errors };
}

async function callNvidia(messages, options = {}) {
  const apiKey = options.apiKey || process.env.NVIDIA_API_KEY;
  if (!apiKey) throw new Error("NVIDIA_API_KEY is not configured");
  const fetchImpl = options.fetchImpl || fetch;
  const timeoutMs = Number(options.timeoutMs || process.env.NVIDIA_TIMEOUT_MS || 45000);
  const response = await fetchImpl(NVIDIA_URL, {
    method: "POST",
    signal: AbortSignal.timeout(timeoutMs),
    headers: {
      "Authorization": `Bearer ${apiKey}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      model: options.model || DEFAULT_MODEL,
      messages,
      temperature: 0.2,
      top_p: 0.7,
      max_tokens: 4096
    })
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.error?.message || payload.message || `NVIDIA API failed with ${response.status}`);
  return payload.choices?.[0]?.message?.content || payload.output_text || "";
}

function buildMessages(contextPackage, repairContext = null) {
  const schemaText = compact(JSON.stringify(outputSchema), 9000);
  const userContent = repairContext
    ? `Repair the previous Brain One JSON output so it validates. Return JSON only.\n\nValidation errors:\n${repairContext.errors.join("\n")}\n\nOriginal context package:\n${JSON.stringify(contextPackage)}\n\nPrevious raw response:\n${repairContext.rawResponse}`
    : `Analyze this business using Brain One. Return JSON only matching this output schema.\n\nOutput schema:\n${schemaText}\n\nContext package:\n${JSON.stringify(contextPackage)}`;
  return [
    { role: "system", content: RUNTIME_PROMPT },
    { role: "user", content: userContent }
  ];
}

async function runBrainOne(contextPackage, options = {}) {
  const inputValidation = validateBrainOneInput(contextPackage);
  if (!inputValidation.ok) {
    const error = new Error(`Brain One input failed validation: ${inputValidation.errors.join("; ")}`);
    error.validationErrors = inputValidation.errors;
    throw error;
  }
  const model = options.model || DEFAULT_MODEL;
  const started = Date.now();
  const callModel = options.callModel || ((messages) => callNvidia(messages, { ...options, model }));
  const firstRaw = await callModel(buildMessages(contextPackage));
  let rawResponse = firstRaw;
  let repairErrors = [];
  try {
    try {
      const parsed = parseMaybeJson(firstRaw);
      const validation = validateBrainOneOutput(parsed);
      if (validation.ok) {
        return { model, rawResponse, output: parsed, durationMs: Date.now() - started, repaired: false };
      }
      repairErrors = validation.errors;
    } catch (error) {
      repairErrors = [error.message];
    }
    const repairedRaw = await callModel(buildMessages(contextPackage, { errors: repairErrors, rawResponse: firstRaw }));
    rawResponse = repairedRaw;
    const repaired = parseMaybeJson(repairedRaw);
    const repairedValidation = validateBrainOneOutput(repaired);
    if (!repairedValidation.ok) {
      const error = new Error(`Brain One output failed validation after repair: ${repairedValidation.errors.join("; ")}`);
      error.validationErrors = repairedValidation.errors;
      error.rawResponse = repairedRaw;
      throw error;
    }
    return { model, rawResponse, output: repaired, durationMs: Date.now() - started, repaired: true };
  } catch (error) {
    if (!error.rawResponse) error.rawResponse = rawResponse;
    if (!error.validationErrors) error.validationErrors = [error.message];
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
    lead.brainOneSummary = record.validatedOutput?.businessGrowthBlueprint?.summary || "";
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
  runBrainOne,
  validateBrainOneInput,
  validateBrainOneOutput
};
