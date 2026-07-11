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

function evidenceIdList(item = {}) {
  return item.evidence_ids || item.evidenceIds || [];
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
    const ids = evidenceIdList(item);
    if (!Array.isArray(ids) || ids.length === 0) {
      errors.push(`${pathName}[${index}] must include evidence_ids`);
    } else {
      for (const id of ids) {
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
  const ids = evidenceIdList(section);
  if (!Array.isArray(ids) || ids.length === 0) {
    errors.push(`${pathName} must include evidence_ids`);
    return;
  }
  for (const id of ids) {
    if (!evidenceIds.has(id)) errors.push(`${pathName} references unknown evidence id ${id}`);
  }
}

function validateBrainOneOutput(output) {
  const errors = [];
  validateRequiredObject(output, "output", outputSchema.required, errors);
  if (errors.length) return { ok: false, errors };
  validateRequiredObject(output.business_identity, "business_identity", ["business_name", "website_url", "trade", "location"], errors);
  validateEvidenceItems(output.evidence, "evidence", errors, "snake");
  const evidenceIds = new Set((output.evidence || []).map(item => item.id));
  claimListChecks(output.confirmed_facts, "confirmed_facts", evidenceIds, errors);
  claimListChecks(output.inferences, "inferences", evidenceIds, errors);
  claimListChecks(output.hidden_opportunities, "hidden_opportunities", evidenceIds, errors);
  claimListChecks(output.risks, "risks", evidenceIds, errors);
  sectionEvidenceCheck(output.business_dna, "business_dna", evidenceIds, errors);
  sectionEvidenceCheck(output.digital_health, "digital_health", evidenceIds, errors);
  sectionEvidenceCheck(output.ai_discoverability, "ai_discoverability", evidenceIds, errors);
  sectionEvidenceCheck(output.priority, "priority", evidenceIds, errors);
  sectionEvidenceCheck(output.contact_confidence, "contact_confidence", evidenceIds, errors);
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
      content: "You are CALLCATCH BRAIN ONE Phase B. Render a concise Business Growth Blueprint in Markdown using only the provided validated Phase A JSON. Do not add facts that are not in Phase A. Do not write or recommend outbound email copy."
    },
    {
      role: "user",
      content: `PHASE B - Blueprint Rendering.\nUse this validated Phase A JSON as the only factual source:\n${JSON.stringify(phaseAOutput)}\n\nReturn Markdown with these sections only:\n# Business Growth Blueprint\n## Opportunity Summary\n## Digital Gaps\n## Hidden Opportunities\n## CallCatch Fit\n## Next Best Manual Actions\n## Brain Two Handoff Notes`
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
  try {
    try {
      logStage("brain_one_json_validation_started", { attempt: 1 });
      const parsed = parseMaybeJson(firstRaw);
      const validation = validateBrainOneOutput(parsed);
      if (validation.ok) {
        phaseAOutput = parsed;
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
        repairedValidation = validateBrainOneOutput(repaired);
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
      repaired: !!firstParseFailure
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
  validateBrainOneInput,
  validateBrainOneOutput
};
