const crypto = require("crypto");

const IDENTITY_STATUS = Object.freeze({
  VERIFIED: "Verified",
  VERIFIED_FREE_EMAIL: "Verified with public free-email address",
  NEEDS_REVIEW: "Needs Review",
  REJECTED: "Rejected: identity mismatch"
});

const FREE_EMAIL_DOMAINS = new Set([
  "aol.com", "gmail.com", "hotmail.com", "icloud.com", "live.com",
  "mail.com", "outlook.com", "proton.me", "protonmail.com", "yahoo.com"
]);

const DIRECTORY_DOMAINS = new Set([
  "angi.com", "bbb.org", "facebook.com", "homeadvisor.com", "instagram.com",
  "linkedin.com", "mapquest.com", "nextdoor.com", "thumbtack.com", "yelp.com",
  "yellowpages.com"
]);

const INDUSTRY_PATTERNS = Object.freeze({
  HVAC: /\b(hvac|heating and (?:air|cooling)|heating & (?:air|cooling)|air conditioning|a\/c repair|ac repair|furnace|heat pump)\b/i,
  Plumbing: /\b(plumb(?:er|ing)?|drain cleaning|water heater|sewer|leak repair)\b/i,
  Electrical: /\b(electric(?:ian|al)?|rewiring|circuit breaker|electrical panel)\b/i,
  Roofing: /\b(roof(?:er|ing)?|roof replacement|roof repair|shingle)\b/i,
  "Garage Doors": /\b(garage door|overhead door|garage opener)\b/i,
  Landscaping: /\b(landscap(?:e|er|ing)|lawn care|garden maintenance)\b/i,
  "Pest Control": /\b(pest control|exterminat(?:or|ing)|termite|rodent control)\b/i,
  Cleaning: /\b(cleaning service|house cleaning|commercial cleaning|maid service)\b/i,
  Painting: /\b(painting contractor|house painter|commercial painting|interior painting)\b/i,
  Locksmith: /\b(locksmith|lock repair|rekey|key replacement)\b/i,
  "Appliance Repair": /\b(appliance repair|refrigerator repair|washer repair|dryer repair)\b/i,
  "Tree Service": /\b(tree service|tree removal|tree trimming|arborist)\b/i,
  Flooring: /\b(flooring contractor|floor installation|hardwood flooring|carpet installation)\b/i,
  Solar: /\b(solar (?:panel|installer|installation|energy)|photovoltaic)\b/i,
  "Pool Services": /\b(pool service|pool cleaning|pool repair|swimming pool)\b/i,
  "Junk Removal": /\b(junk removal|rubbish removal|debris removal|haul away)\b/i
});

function clean(value = "") {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function canonicalUrl(value = "") {
  try {
    const parsed = new URL(/^https?:\/\//i.test(value) ? value : `https://${value}`);
    if (!/^https?:$/.test(parsed.protocol)) return "";
    parsed.hash = "";
    return parsed.toString();
  } catch {
    return "";
  }
}

function canonicalDomain(value = "") {
  try {
    return new URL(canonicalUrl(value)).hostname.replace(/^www\./, "").toLowerCase();
  } catch {
    return "";
  }
}

function emailDomain(value = "") {
  const match = clean(value).toLowerCase().match(/^[^@\s]+@([^@\s]+)$/);
  return match ? match[1].replace(/^www\./, "") : "";
}

function sameOrSubdomain(left = "", right = "") {
  const a = String(left || "").toLowerCase();
  const b = String(right || "").toLowerCase();
  return Boolean(a && b && (a === b || a.endsWith(`.${b}`) || b.endsWith(`.${a}`)));
}

function normalizedName(value = "") {
  return clean(value)
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/\b(official|home|website|welcome to|incorporated|corporation|company|limited|llc|ltd|inc|corp|co)\b/g, " ")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function nameTokens(value = "") {
  return new Set(normalizedName(value).split(" ").filter(token => token.length > 1));
}

function namesConsistent(expected = "", candidate = "", website = "") {
  const expectedTokens = nameTokens(expected);
  const candidateTokens = nameTokens(candidate);
  if (!expectedTokens.size || !candidateTokens.size) return false;
  const shared = [...expectedTokens].filter(token => candidateTokens.has(token));
  if (shared.length / Math.min(expectedTokens.size, candidateTokens.size) >= 0.6) return true;
  const domainToken = canonicalDomain(website).split(".")[0].replace(/[^a-z0-9]/g, "");
  const expectedJoined = [...expectedTokens].join("");
  const candidateJoined = [...candidateTokens].join("");
  return Boolean(domainToken.length >= 3 && expectedJoined.includes(domainToken) && candidateJoined.includes(domainToken));
}

function newLeadId(lead = {}) {
  const seed = [lead.sourceId, canonicalDomain(lead.website), normalizedName(lead.business), clean(lead.city || lead.area).toLowerCase()]
    .filter(Boolean)
    .join("|");
  const digest = crypto.createHash("sha256").update(seed || crypto.randomUUID()).digest("hex").slice(0, 20);
  return `lead_${digest}`;
}

function detectVerifiedIndustry(searchTrade = "", scan = {}) {
  const text = [
    ...(scan.pageTitles || []),
    ...(scan.metaDescriptions || []),
    ...(scan.serviceKeywords || []),
    ...(scan.industryEvidence || [])
  ].join(" ");
  const requested = clean(searchTrade);
  const direct = Object.entries(INDUSTRY_PATTERNS).find(([name, pattern]) =>
    normalizedName(name) === normalizedName(requested) && pattern.test(text)
  );
  if (direct) return { industry: direct[0], evidence: clean(text).slice(0, 500) };
  const detected = Object.entries(INDUSTRY_PATTERNS).find(([, pattern]) => pattern.test(text));
  return detected ? { industry: detected[0], evidence: clean(text).slice(0, 500) } : { industry: "", evidence: "" };
}

function emailEvidenceFor(scan = {}, email = "") {
  const wanted = clean(email).toLowerCase();
  return (scan.emailEvidence || []).find(item => clean(item.email).toLowerCase() === wanted) || null;
}

function identityResult(status, fields = {}) {
  return {
    status,
    verified: [IDENTITY_STATUS.VERIFIED, IDENTITY_STATUS.VERIFIED_FREE_EMAIL].includes(status),
    checkedAt: new Date().toISOString(),
    reasons: [],
    conflicts: [],
    ...fields
  };
}

function verifyBusinessIdentity({ lead = {}, scan = {}, email = "" } = {}) {
  const leadId = clean(lead.id);
  const website = canonicalUrl(scan.url || lead.website || "");
  const websiteDomain = canonicalDomain(website);
  const recipient = clean(email || lead.email).toLowerCase();
  const recipientDomain = emailDomain(recipient);
  const searchTrade = clean(lead.searchTrade || lead.trade);
  const nameCandidates = [...new Set([...(scan.businessNameCandidates || []), ...(scan.pageTitles || [])].map(clean).filter(Boolean))];
  const matchingName = nameCandidates.find(name => namesConsistent(lead.business, name, website)) || "";
  const industry = detectVerifiedIndustry(searchTrade, scan);
  const evidence = emailEvidenceFor(scan, recipient);
  const base = {
    leadId,
    businessName: clean(lead.business),
    verifiedBusinessName: matchingName,
    canonicalWebsite: website,
    websiteDomain,
    recipientEmail: recipient,
    emailDomain: recipientDomain,
    emailSourceUrl: evidence?.sourceUrl || "",
    emailSourceType: evidence?.sourceType || "",
    confirmedIndustry: industry.industry,
    industryEvidence: industry.evidence,
    nameEvidence: nameCandidates.slice(0, 8)
  };

  if (!leadId || !website || !websiteDomain || !scan.ok) {
    return identityResult(IDENTITY_STATUS.NEEDS_REVIEW, { ...base, reasons: ["Official website verification has not completed."] });
  }
  if (DIRECTORY_DOMAINS.has(websiteDomain)) {
    return identityResult(IDENTITY_STATUS.NEEDS_REVIEW, { ...base, reasons: ["A directory or social profile cannot establish the canonical business website by itself."] });
  }
  if (!matchingName) {
    return identityResult(IDENTITY_STATUS.REJECTED, {
      ...base,
      reasons: ["The business name is not supported by the scanned website identity."],
      conflicts: [{ field: "businessName", expected: clean(lead.business), actual: nameCandidates.join(" | ") || "missing" }]
    });
  }
  if (!industry.industry || normalizedName(industry.industry) !== normalizedName(searchTrade)) {
    return identityResult(IDENTITY_STATUS.NEEDS_REVIEW, {
      ...base,
      reasons: ["The selected search category is not confirmed by the official website."],
      conflicts: [{ field: "industry", expected: searchTrade, actual: industry.industry || "unconfirmed" }]
    });
  }
  if (!recipient || !recipientDomain || !evidence?.sourceUrl) {
    return identityResult(IDENTITY_STATUS.NEEDS_REVIEW, { ...base, reasons: ["The recipient email is not tied to a retained official source URL."] });
  }
  const sourceDomain = canonicalDomain(evidence.sourceUrl);
  const officialSource = sameOrSubdomain(sourceDomain, websiteDomain) || evidence.verifiedOfficialProfile === true;
  if (!officialSource) {
    return identityResult(IDENTITY_STATUS.REJECTED, {
      ...base,
      reasons: ["The recipient email came from an unrelated source."],
      conflicts: [{ field: "emailSourceUrl", expected: websiteDomain, actual: sourceDomain || evidence.sourceUrl }]
    });
  }
  if (FREE_EMAIL_DOMAINS.has(recipientDomain)) {
    return identityResult(IDENTITY_STATUS.VERIFIED_FREE_EMAIL, { ...base, reasons: ["The public free-email address is explicitly published by the verified business website."] });
  }
  if (!sameOrSubdomain(recipientDomain, websiteDomain)) {
    return identityResult(IDENTITY_STATUS.NEEDS_REVIEW, {
      ...base,
      reasons: ["The email is published by the official site, but its custom domain differs and needs manual confirmation."],
      conflicts: [{ field: "emailDomain", expected: websiteDomain, actual: recipientDomain }]
    });
  }
  return identityResult(IDENTITY_STATUS.VERIFIED, { ...base, reasons: ["Business name, industry, website, recipient, and source URL are consistent."] });
}

function isIdentityVerified(value = {}) {
  const status = typeof value === "string" ? value : value?.status;
  return [IDENTITY_STATUS.VERIFIED, IDENTITY_STATUS.VERIFIED_FREE_EMAIL].includes(status);
}

function identityError(message = "Business identity mismatch", details = []) {
  const error = new Error(message);
  error.code = "BUSINESS_IDENTITY_MISMATCH";
  error.details = details;
  return error;
}

function assertSameLeadId(expectedLeadId, records = []) {
  const expected = clean(expectedLeadId);
  if (!expected) throw identityError("Business identity mismatch", [{ field: "leadId", expected: "present", actual: "missing" }]);
  for (const [label, record, fields = ["leadId", "businessId", "business_id"]] of records) {
    if (!record) throw identityError("Business identity mismatch", [{ field: label, expected, actual: "missing" }]);
    const actual = fields.map(field => clean(record[field])).find(Boolean);
    if (!actual || actual !== expected) throw identityError("Business identity mismatch", [{ field: `${label}.leadId`, expected, actual: actual || "missing" }]);
  }
  return true;
}

function validateIdentityChain({ lead, brainZeroRun, brainOneRun, brainTwoRun, task, approval, require = [] } = {}) {
  if (!lead?.id) throw identityError();
  const records = [];
  const add = (name, record, fields) => {
    if (record || require.includes(name)) records.push([name, record, fields]);
  };
  add("brainZeroRun", brainZeroRun, ["business_id", "businessId"]);
  add("brainOneRun", brainOneRun, ["businessId"]);
  add("brainTwoRun", brainTwoRun, ["businessId"]);
  add("draft", task, ["leadId"]);
  add("approval", approval, ["leadId"]);
  assertSameLeadId(lead.id, records);
  if (!isIdentityVerified(lead.identityVerification)) {
    throw identityError("Business identity mismatch", lead.identityVerification?.conflicts || [{ field: "identity", expected: "Verified", actual: lead.identityVerification?.status || "missing" }]);
  }
  if (task) {
    const taskRecipient = clean(task.to || task.recipient).toLowerCase();
    const leadRecipient = clean(lead.email).toLowerCase();
    if (!taskRecipient || taskRecipient !== leadRecipient || clean(task.business) !== clean(lead.business)) {
      throw identityError("Business identity mismatch", [
        { field: "recipient", expected: leadRecipient, actual: taskRecipient || "missing" },
        { field: "businessName", expected: clean(lead.business), actual: clean(task.business) || "missing" }
      ]);
    }
  }
  return true;
}

function evidenceIdsFromBrainOne(run = {}) {
  const output = run.validatedOutput || run.output || {};
  const input = run.inputSnapshot || {};
  const ids = new Set();
  const visit = value => {
    if (Array.isArray(value)) {
      value.forEach(visit);
      return;
    }
    if (!value || typeof value !== "object") return;
    if (typeof value.id === "string" && /^ev[-_]/i.test(value.id)) ids.add(value.id);
    if (typeof value.evidence_id === "string") ids.add(value.evidence_id);
    if (Array.isArray(value.evidence_ids)) value.evidence_ids.filter(Boolean).forEach(id => ids.add(String(id)));
    Object.values(value).forEach(visit);
  };
  visit(output.evidence_log || []);
  visit(input.evidenceLog || []);
  return ids;
}

function assertDraftIdentity({ state = {}, lead, brainZeroRun, brainOneRun, brainTwoRun, task, approval, draft } = {}) {
  if (brainTwoRun && !brainOneRun) {
    throw identityError("Business identity mismatch", [
      { field: "brainOneRun", expected: brainTwoRun.brainOneRunId || "linked Brain One run", actual: "missing" }
    ]);
  }
  if (brainOneRun?.brainZeroRunId && !brainZeroRun) {
    throw identityError("Business identity mismatch", [
      { field: "brainZeroRun", expected: brainOneRun.brainZeroRunId, actual: "missing" }
    ]);
  }
  validateIdentityChain({
    lead,
    brainZeroRun,
    brainOneRun,
    brainTwoRun,
    task,
    approval,
    require: [
      ...(brainOneRun ? ["brainOneRun"] : []),
      ...(brainOneRun?.brainZeroRunId ? ["brainZeroRun"] : []),
      ...(brainTwoRun ? ["brainTwoRun"] : []),
      ...(task ? ["draft"] : []),
      ...(approval ? ["approval"] : [])
    ]
  });
  const conflicts = [];
  const identity = lead.identityVerification || {};
  const expectedWebsite = canonicalDomain(identity.canonicalWebsite || lead.website);
  const expectedEmail = clean(lead.email).toLowerCase();
  const expectedIndustry = clean(identity.confirmedIndustry || lead.verifiedIndustry);
  if (!identity.emailSourceUrl) conflicts.push({ field: "emailSourceUrl", expected: "verified official source", actual: "missing" });
  if (canonicalDomain(identity.canonicalWebsite) !== expectedWebsite) conflicts.push({ field: "website", expected: expectedWebsite, actual: canonicalDomain(identity.canonicalWebsite) });
  if (clean(identity.recipientEmail).toLowerCase() !== expectedEmail) conflicts.push({ field: "recipient", expected: expectedEmail, actual: clean(identity.recipientEmail).toLowerCase() || "missing" });
  if (!expectedIndustry || clean(lead.trade) !== expectedIndustry) conflicts.push({ field: "industry", expected: expectedIndustry || "verified industry", actual: clean(lead.trade) || "missing" });

  const inputBusinessId = clean(brainOneRun?.inputSnapshot?.businessIdentity?.businessId);
  if (brainOneRun && inputBusinessId !== lead.id) conflicts.push({ field: "brainOne.input.businessId", expected: lead.id, actual: inputBusinessId || "missing" });
  const linkedBrainZeroId = clean(brainOneRun?.brainZeroRunId);
  const actualBrainZeroId = clean(brainZeroRun?.run_id || brainZeroRun?.id);
  if (linkedBrainZeroId && actualBrainZeroId !== linkedBrainZeroId) {
    conflicts.push({ field: "brainOne.brainZeroRunId", expected: linkedBrainZeroId, actual: actualBrainZeroId || "missing" });
  }
  const handoffLeadId = clean(brainTwoRun?.output?.brain_three_handoff?.lead_id);
  if (brainTwoRun && handoffLeadId !== lead.id) conflicts.push({ field: "brainTwo.handoff.leadId", expected: lead.id, actual: handoffLeadId || "missing" });

  const message = draft || brainTwoRun?.output?.first_email || {};
  const subject = clean(message.subject || task?.subject || task?.title);
  const body = clean(message.body || task?.body);
  const recipient = clean(task?.to || task?.recipient || expectedEmail).toLowerCase();
  if (recipient !== expectedEmail) conflicts.push({ field: "draft.recipient", expected: expectedEmail, actual: recipient || "missing" });
  if (task && clean(task.business) !== clean(lead.business)) conflicts.push({ field: "draft.businessName", expected: clean(lead.business), actual: clean(task.business) || "missing" });

  const combined = (subject + "\n" + body).toLowerCase();
  for (const other of state.leads || []) {
    if (!other?.id || other.id === lead.id) continue;
    const otherEmail = clean(other.email).toLowerCase();
    const otherDomain = canonicalDomain(other.website);
    const otherName = clean(other.business).toLowerCase();
    if (otherEmail && otherEmail !== expectedEmail && combined.includes(otherEmail)) conflicts.push({ field: "foreignRecipient", expected: expectedEmail, actual: otherEmail });
    if (otherDomain && otherDomain !== expectedWebsite && combined.includes(otherDomain)) conflicts.push({ field: "foreignDomain", expected: expectedWebsite, actual: otherDomain });
    if (otherName.length >= 6 && otherName !== clean(lead.business).toLowerCase() && combined.includes(otherName)) conflicts.push({ field: "foreignBusinessName", expected: clean(lead.business), actual: other.business });
  }

  const evidenceIds = [...new Set([...(message.evidence_ids || []), ...(task?.qualityGate?.evidence_ids || [])].filter(Boolean).map(String))];
  const ownedEvidence = evidenceIdsFromBrainOne(brainOneRun);
  const unownedEvidence = evidenceIds.filter(id => !ownedEvidence.has(id));
  if (brainOneRun && unownedEvidence.length) conflicts.push({ field: "draft.evidence_ids", expected: "owned by this Brain One run", actual: unownedEvidence.join(", ") });

  if (conflicts.length) throw identityError("Business identity mismatch", conflicts);
  return {
    ok: true,
    leadId: lead.id,
    business: lead.business,
    website: identity.canonicalWebsite || lead.website,
    recipient: expectedEmail,
    identity: identity.status
  };
}
function auditAndMarkIdentityRecords(state = {}) {
  let leadsMarked = 0;
  let draftsMarked = 0;
  let approvalsRevoked = 0;
  const leadById = new Map((state.leads || []).map(lead => [lead.id, lead]));
  for (const lead of state.leads || []) {
    if (!lead.id || !isIdentityVerified(lead.identityVerification)) {
      lead.identityVerification = {
        ...(lead.identityVerification || {}),
        leadId: lead.id || "",
        status: IDENTITY_STATUS.NEEDS_REVIEW,
        verified: false,
        reasons: ["Existing record requires official website and email re-verification."],
        checkedAt: new Date().toISOString()
      };
      lead.identityStatus = "Needs Re-verification";
      leadsMarked += 1;
    }
  }
  for (const task of state.approvalQueue || []) {
    const lead = leadById.get(task.leadId);
    let safe = false;
    try {
      validateIdentityChain({ lead, task, require: ["draft"] });
      safe = true;
    } catch {}
    if (!safe && !["Sent", "Delivered", "Opened", "Replied", "Bounced", "Failed"].includes(task.status)) {
      task.status = "Needs Re-verification";
      task.identityStatus = IDENTITY_STATUS.NEEDS_REVIEW;
      task.identityError = "Business identity mismatch";
      draftsMarked += 1;
    }
  }
  for (const approval of state.outboundApprovals || []) {
    const task = (state.approvalQueue || []).find(item => item.id === approval.taskId);
    const lead = leadById.get(approval.leadId);
    let safe = false;
    try {
      validateIdentityChain({ lead, task, approval, require: ["draft", "approval"] });
      safe = true;
    } catch {}
    if (!safe && !approval.consumedAt && approval.status !== "revoked") {
      approval.status = "revoked";
      approval.revokedReason = "Business identity mismatch; re-verification required.";
      approvalsRevoked += 1;
    }
  }
  return { leadsMarked, draftsMarked, approvalsRevoked };
}

module.exports = {
  FREE_EMAIL_DOMAINS,
  IDENTITY_STATUS,
  assertDraftIdentity,
  assertSameLeadId,
  auditAndMarkIdentityRecords,
  canonicalDomain,
  canonicalUrl,
  detectVerifiedIndustry,
  emailDomain,
  identityError,
  isIdentityVerified,
  namesConsistent,
  newLeadId,
  validateIdentityChain,
  verifyBusinessIdentity
};
