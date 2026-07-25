const { canonicalDomain, canonicalUrl, identityError } = require("./businessIdentity");

const SERVER_MANAGED_FIELDS = Object.freeze([
  "identityVerification",
  "identityStatus",
  "verifiedIndustry",
  "industryVerified",
  "emailSourceUrl",
  "websiteVerificationStatus",
  "brainZeroLatestRunId",
  "brainZeroStatus",
  "brainZeroEvidenceQuality",
  "brainZeroEvidenceHash",
  "brainOneLatestRunId",
  "brainOneApprovalStatus",
  "brainOneApprovedAt",
  "brainOneSummary",
  "brainTwoLatestRunId",
  "brainTwoApprovalStatus"
]);

function clean(value = "") {
  return String(value || "").trim();
}

function leadIdentityKey(lead = {}) {
  const website = canonicalUrl(lead.website || "");
  if (website) {
    const normalizedWebsite = website.toLowerCase().replace(/https?:\/\//, "").replace(/www\./, "").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
    return normalizedWebsite ? `website:${normalizedWebsite}` : "";
  }
  const fallback = [lead.business, lead.city, lead.state]
    .map(value => clean(value).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, ""))
    .filter(Boolean)
    .join("|");
  return fallback ? `business:${fallback}` : "";
}

function stripClientVerificationClaims(lead = {}) {
  const safe = { ...lead };
  for (const field of SERVER_MANAGED_FIELDS) delete safe[field];
  return safe;
}

function registerLeadForVerification(state = {}, { leadId, snapshot, now = new Date().toISOString() } = {}) {
  state.leads = state.leads || [];
  const id = clean(leadId);
  const existing = state.leads.find(item => item.id === id);
  if (existing) return { lead: existing, created: false };

  if (!id || !snapshot || clean(snapshot.id) !== id) {
    const error = new Error("Lead not found");
    error.code = "LEAD_NOT_FOUND";
    error.statusCode = 404;
    throw error;
  }
  if (!clean(snapshot.business) || !canonicalDomain(snapshot.website || "")) {
    const error = new Error("Business name and official website are required before verification");
    error.code = "LEAD_REGISTRATION_INVALID";
    error.statusCode = 400;
    throw error;
  }

  const key = leadIdentityKey(snapshot);
  const conflict = key
    ? state.leads.find(item => item.id !== id && leadIdentityKey(item) === key)
    : null;
  if (conflict) {
    throw identityError("Business identity mismatch", [{
      field: "leadId",
      expected: conflict.id,
      actual: id
    }]);
  }

  const lead = {
    ...stripClientVerificationClaims(snapshot),
    id,
    identityVerification: null,
    identityStatus: "Needs Re-verification",
    verifiedIndustry: "",
    industryVerified: false,
    emailSourceUrl: "",
    websiteVerificationStatus: "pending",
    createdAt: snapshot.createdAt || now,
    updatedAt: now
  };
  state.leads.unshift(lead);
  return { lead, created: true };
}

module.exports = {
  SERVER_MANAGED_FIELDS,
  leadIdentityKey,
  registerLeadForVerification,
  stripClientVerificationClaims
};
