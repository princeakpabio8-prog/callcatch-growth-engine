const { buildBrainOneContextPackage } = require("./brainOneService");

function runId(run = {}) {
  return String(run.run_id || run.id || "");
}

function runBusinessId(run = {}) {
  return String(run.business_id || run.businessId || "");
}

function runCompletedAt(run = {}) {
  return Date.parse(run.completed_at || run.completedAt || run.started_at || run.createdAt || 0) || 0;
}

function acceptedResearchStatuses(acceptPartial = false) {
  return acceptPartial ? new Set(["completed", "partial"]) : new Set(["completed"]);
}

function latestCompletedResearchRun(runs = [], leadId = "", { acceptPartial = false } = {}) {
  const statuses = acceptedResearchStatuses(acceptPartial);
  return (runs || [])
    .filter(run => runBusinessId(run) === String(leadId || "") && statuses.has(run.status))
    .sort((left, right) => runCompletedAt(right) - runCompletedAt(left))[0] || null;
}

function handoffError(code, message, details = {}) {
  const error = new Error(message);
  error.code = code;
  error.statusCode = 409;
  error.details = details;
  return error;
}

function selectAuthoritativeResearchRun(runs = [], {
  leadId = "",
  requestedRunId = "",
  acceptPartial = false
} = {}) {
  const normalizedLeadId = String(leadId || "");
  const requested = requestedRunId
    ? (runs || []).find(run => runId(run) === String(requestedRunId)) || null
    : null;

  if (requestedRunId && !requested) {
    throw handoffError(
      "RESEARCH_RUN_NOT_FOUND",
      "The requested Research run no longer exists. Refresh Research Collection and try again.",
      { requestedRunId: String(requestedRunId) }
    );
  }
  if (requested && runBusinessId(requested) !== normalizedLeadId) {
    throw handoffError(
      "BUSINESS_IDENTITY_MISMATCH",
      "The requested Research run belongs to another business.",
      { requestedRunId: runId(requested), requestedBusinessId: runBusinessId(requested), leadId: normalizedLeadId }
    );
  }

  const authoritative = latestCompletedResearchRun(runs, normalizedLeadId, { acceptPartial });
  if (requested && !acceptedResearchStatuses(acceptPartial).has(requested.status)) {
    throw handoffError(
      "RESEARCH_RUN_NOT_READY",
      "The requested Research run is not completed and ready for analysis.",
      { requestedRunId: runId(requested), status: requested.status || "missing" }
    );
  }
  if (requested && authoritative && runId(requested) !== runId(authoritative)) {
    throw handoffError(
      "STALE_RESEARCH_RUN",
      "A newer completed Research run is available. Refresh Research Collection before analyzing the business.",
      { requestedRunId: runId(requested), authoritativeRunId: runId(authoritative) }
    );
  }
  return authoritative;
}

function values(value) {
  if (Array.isArray(value)) return value.flatMap(values);
  if (value && typeof value === "object") return Object.values(value).flatMap(values);
  return [String(value || "")];
}

function firstEmailFromResearch(packageValue = {}) {
  for (const item of packageValue.contacts || []) {
    for (const value of values(item.value)) {
      const match = value.match(/[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/i);
      if (match) return match[0].toLowerCase();
    }
  }
  return "";
}

function firstPhoneFromResearch(packageValue = {}) {
  for (const item of packageValue.contacts || []) {
    for (const value of values(item.value)) {
      if (/\d{7,}/.test(value.replace(/\D/g, ""))) return value;
    }
  }
  return "";
}

function evidenceContainsEmail(item = {}, email = "") {
  if (!email) return false;
  const text = [item.value, item.source_excerpt, item.excerpt]
    .flatMap(values)
    .join(" ")
    .toLowerCase();
  return text.includes(email.toLowerCase());
}

function brainZeroEvidenceToBrainOneContext(lead = {}, run = null) {
  const packageValue = run?.evidence_package || {};
  const evidence = Array.isArray(packageValue.evidence_log) ? packageValue.evidence_log : [];
  const convertedEvidence = evidence.map(item => ({
    id: item.evidence_id || item.id,
    sourceType: item.provider || item.category || "brain-zero",
    sourceProvider: item.provider || "",
    sourceCategory: item.category || "",
    category: item.category || "",
    field: item.field || "",
    confidence: item.confidence || "unknown",
    claimType: item.claim_type || "",
    sourceUrl: item.source_url || item.sourceUrl || "",
    excerpt: item.source_excerpt || item.excerpt || (typeof item.value === "string" ? item.value : JSON.stringify(item.value || "")),
    value: item.value,
    capturedAt: item.collected_at || item.capturedAt || run?.completed_at || new Date().toISOString()
  }));
  const identityValue = field => (packageValue.business_identity_candidates || [])
    .find(item => item.field === field)?.value || "";
  const officialName = identityValue("business_name") || lead.business || "";
  const officialWebsite = identityValue("website_url") || lead.website || packageValue.source_urls?.[0] || "";
  const officialLocation = identityValue("stated_location") || [lead.city, lead.state, lead.country].filter(Boolean).join(", ") || lead.area || "";
  const firstEmail = firstEmailFromResearch(packageValue) || lead.email || "";
  const firstPhone = firstPhoneFromResearch(packageValue) || lead.phone || "";
  const websiteText = [
    ...(packageValue.website_pages || []).map(page => page.excerpt || ""),
    ...(packageValue.content_evidence || []).map(item => item.source_excerpt || ""),
    ...(packageValue.trust_evidence || []).map(item => item.source_excerpt || "")
  ].filter(Boolean).join("\n\n");
  const effectiveLead = {
    ...lead,
    email: lead.email || firstEmail,
    phone: lead.phone || firstPhone
  };
  const base = buildBrainOneContextPackage(effectiveLead, {
    ok: true,
    url: officialWebsite,
    text: websiteText,
    description: `Brain Zero evidence collection ${run?.status || "completed"} with ${evidence.length} evidence records.`
  });
  const recipientEmail = String(base.outreachEligibility?.recipientEmail || effectiveLead.email || "").trim().toLowerCase();
  const verifiedContactEvidence = convertedEvidence.find(item => evidenceContainsEmail(item, recipientEmail)) || null;
  const baseEligibility = base.outreachEligibility || {};
  const retainedVerifiedContact = baseEligibility.recipientUsable === true && !!verifiedContactEvidence;

  return {
    ...base,
    businessIdentity: {
      ...base.businessIdentity,
      businessName: officialName || base.businessIdentity.businessName,
      websiteUrl: officialWebsite || base.businessIdentity.websiteUrl,
      city: lead.city || base.businessIdentity.city,
      state: lead.state || base.businessIdentity.state,
      country: lead.country || base.businessIdentity.country || "US",
      location: officialLocation || base.businessIdentity.location || ""
    },
    websitePublicText: websiteText || base.websitePublicText,
    publicContactDetails: {
      ...base.publicContactDetails,
      email: effectiveLead.email || firstEmail || "",
      phone: effectiveLead.phone || firstPhone || ""
    },
    publicSocialOrDirectoryEvidence: convertedEvidence.filter(item => /identity|existing|directory|trust/i.test(item.sourceType)),
    scraperEvidence: convertedEvidence,
    sourceUrls: [...new Set((packageValue.source_urls || []).filter(Boolean))],
    analysisTimestamp: run?.completed_at || run?.completedAt || base.analysisTimestamp,
    evidenceLog: convertedEvidence,
    outreachEligibility: {
      ...baseEligibility,
      verifiedContactEvidenceId: verifiedContactEvidence?.id || "",
      verifiedContactEvidenceStatus: retainedVerifiedContact ? "confirmed" : "missing",
      emailEvidenceOwnedByBusiness: retainedVerifiedContact,
      recipientUsable: retainedVerifiedContact,
      recipientBlockReason: retainedVerifiedContact
        ? ""
        : baseEligibility.recipientBlockReason || "The completed Research run did not retain evidence for the verified recipient email."
    },
    brainZero: {
      runId: runId(run),
      businessId: runBusinessId(run),
      status: run?.status || "",
      evidenceCount: evidence.length,
      sourceCount: Number(run?.source_count || packageValue.collection_summary?.source_count || packageValue.source_urls?.length || 0),
      pageCount: Number(run?.pages_scanned || packageValue.website_pages?.length || 0),
      evidenceQuality: packageValue.overall_evidence_quality || run?.overall_evidence_quality || "weak",
      evidenceCoverage: packageValue.evidence_coverage || run?.evidence_coverage || null,
      brainOneReady: packageValue.brain_one_ready ?? run?.brain_one_ready ?? false,
      missingCriticalCategories: packageValue.missing_critical_categories || run?.missing_critical_categories || [],
      providerDiagnostics: packageValue.provider_diagnostics || {},
      providerStatuses: packageValue.provider_statuses || {},
      collectionLimitations: packageValue.collection_limitations || []
    }
  };
}

module.exports = {
  brainZeroEvidenceToBrainOneContext,
  latestCompletedResearchRun,
  selectAuthoritativeResearchRun
};
