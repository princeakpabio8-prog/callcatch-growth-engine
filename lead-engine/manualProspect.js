const TRACKING_PARAMS = new Set(["fbclid", "gclid", "msclkid", "dclid", "igshid"]);

function cleanText(value, max = 500) {
  return String(value || "").replace(/\s+/g, " ").trim().slice(0, max);
}

function isPrivateIpv4(hostname) {
  const parts = String(hostname || "").split(".").map(part => Number(part));
  if (parts.length !== 4 || parts.some(part => !Number.isInteger(part) || part < 0 || part > 255)) return false;
  const [a, b] = parts;
  return a === 10
    || a === 127
    || a === 0
    || (a === 172 && b >= 16 && b <= 31)
    || (a === 192 && b === 168)
    || (a === 169 && b === 254)
    || (a === 100 && b >= 64 && b <= 127);
}

function isPrivateIpv6(hostname) {
  const host = String(hostname || "").replace(/^\[|\]$/g, "").toLowerCase();
  return host === "::1"
    || host === "0:0:0:0:0:0:0:1"
    || host.startsWith("fc")
    || host.startsWith("fd")
    || host.startsWith("fe80:")
    || host === "::";
}

function isUnsafeHostname(hostname) {
  const host = String(hostname || "").replace(/^\[|\]$/g, "").toLowerCase();
  if (!host) return true;
  if (host === "localhost" || host.endsWith(".localhost")) return true;
  if (host === "metadata.google.internal" || host === "169.254.169.254") return true;
  if (isPrivateIpv4(host) || isPrivateIpv6(host)) return true;
  return false;
}

function canonicalDomainFromUrl(url) {
  try {
    return new URL(url).hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return "";
  }
}

function normalizeManualWebsiteUrl(value) {
  const raw = String(value || "").trim();
  if (!raw) return { url: "", canonicalDomain: "", submittedUrl: "" };
  if (/^(javascript|data|file):/i.test(raw)) throw new Error("Website URL protocol is not allowed");
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `https://${raw}`;
  let parsed;
  try {
    parsed = new URL(withScheme);
  } catch {
    throw new Error("Website URL is malformed");
  }
  if (!["http:", "https:"].includes(parsed.protocol)) throw new Error("Only HTTP and HTTPS website URLs are allowed");
  if (isUnsafeHostname(parsed.hostname)) throw new Error("Website URL points to a blocked local or private network address");
  parsed.hash = "";
  for (const key of [...parsed.searchParams.keys()]) {
    if (key.toLowerCase().startsWith("utm_") || TRACKING_PARAMS.has(key.toLowerCase())) parsed.searchParams.delete(key);
  }
  return {
    url: parsed.toString(),
    canonicalDomain: canonicalDomainFromUrl(parsed.toString()),
    submittedUrl: raw
  };
}

function assertSafeHttpUrl(value) {
  return normalizeManualWebsiteUrl(value).url;
}

function normalizeEmail(value) {
  const email = cleanText(value, 254).toLowerCase();
  if (!email) return "";
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) throw new Error("Contact email is malformed");
  return email;
}

function normalizeManualPhone(value) {
  const phone = String(value || "").trim();
  if (!phone) return "";
  const cleaned = phone.replace(/[^\d+().\-\s]/g, "").replace(/\s+/g, " ").trim();
  if (cleaned.replace(/\D/g, "").length < 7) throw new Error("Contact phone is too short");
  return cleaned.slice(0, 40);
}

function validateManualProspectInput(body = {}) {
  const companyName = cleanText(body.companyName || body.company_name || body.business, 160);
  const website = normalizeManualWebsiteUrl(body.websiteUrl || body.website_url || body.website || "");
  if (!companyName && !website.url) throw new Error("Enter a company name or website URL");
  if (companyName && (companyName.length < 2 || /^[^a-z0-9]+$/i.test(companyName) || /@/.test(companyName))) {
    throw new Error("Company name looks invalid");
  }
  const contactName = cleanText(body.contactName || body.contact_name || "", 120);
  if (contactName && /[^\s@]+@[^\s@]+\.[^\s@]+/.test(contactName)) throw new Error("Contact name cannot be an email address");
  return {
    companyName,
    websiteUrl: website.url,
    submittedWebsiteUrl: website.submittedUrl,
    canonicalDomain: website.canonicalDomain,
    industry: cleanText(body.industry || body.trade || "", 80),
    city: cleanText(body.city || "", 80),
    region: cleanText(body.region || body.state || "", 80),
    country: cleanText(body.country || "US", 80) || "US",
    notes: cleanText(body.notes || "", 1200),
    contactName,
    contactEmail: normalizeEmail(body.contactEmail || body.contact_email || body.email || ""),
    contactPhone: normalizeManualPhone(body.contactPhone || body.contact_phone || body.phone || ""),
    testProspect: body.testProspect !== false && body.mode !== "real"
  };
}

function domainMatchesLead(domain, lead = {}) {
  if (!domain) return false;
  return [lead.website, lead.website_url, lead.url]
    .map(value => canonicalDomainFromUrl(value || ""))
    .filter(Boolean)
    .some(value => value === domain);
}

function findDuplicateManualLead(leads = [], canonicalDomain = "") {
  if (!canonicalDomain) return null;
  return (leads || []).find(lead => domainMatchesLead(canonicalDomain, lead)) || null;
}

function buildManualLead(input, { id, now = new Date().toISOString(), testCopy = false } = {}) {
  const business = input.companyName || input.canonicalDomain || "Manual Prospect";
  const tags = ["Manual Entry"];
  if (input.testProspect || testCopy) tags.push("Manual Test");
  if (testCopy) tags.push("Separate Test Copy");
  return {
    id,
    business,
    company_name: input.companyName,
    trade: input.industry,
    industry: input.industry,
    city: input.city,
    state: input.region,
    region: input.region,
    country: input.country,
    website: input.websiteUrl,
    website_url: input.websiteUrl,
    submitted_website_url: input.submittedWebsiteUrl,
    canonical_domain: input.canonicalDomain,
    email: input.contactEmail,
    phone: input.contactPhone,
    owner: input.contactName,
    contactName: input.contactName,
    notes: input.notes,
    source: "Manual Prospect Entry",
    source_type: "manual",
    source_label: "Manual Prospect Entry",
    analysis_mode: input.testProspect || testCopy ? "manual_test" : "manual_real",
    manualProspect: true,
    testProspect: input.testProspect || testCopy,
    manualTest: input.testProspect || testCopy,
    outreachDisabled: input.testProspect || testCopy,
    followUpsDisabled: input.testProspect || testCopy,
    brainTwoDisabled: input.testProspect || testCopy,
    stage: "Researching",
    callCatchFitScore: 0,
    confidenceScore: 0,
    aiOpportunityLevel: "Manual Review",
    responsePriority: "Collect evidence",
    tags,
    created_at: now,
    createdAt: now,
    updatedAt: now,
    timeline: [{
      at: now,
      text: `Manual prospect created${input.testProspect || testCopy ? " in Test Prospect mode" : ""}. No outreach sent.`
    }]
  };
}

function outreachDisabled(lead = {}) {
  return !!(lead.testProspect || lead.manualTest || lead.outreachDisabled || lead.analysis_mode === "manual_test");
}

function convertManualProspectToReal(lead = {}, { confirmed = false, at = new Date().toISOString() } = {}) {
  if (!confirmed) throw new Error("Conversion requires confirmation");
  lead.testProspect = false;
  lead.manualTest = false;
  lead.outreachDisabled = false;
  lead.followUpsDisabled = false;
  lead.brainTwoDisabled = false;
  lead.analysis_mode = "manual_real";
  lead.tags = (lead.tags || []).filter(tag => tag !== "Manual Test");
  if (!lead.tags.includes("Real Prospect")) lead.tags.push("Real Prospect");
  lead.timeline = lead.timeline || [];
  lead.timeline.unshift({ at, text: "Manual test converted to Real Prospect. Outreach can now be approved manually." });
  lead.updatedAt = at;
  return lead;
}

module.exports = {
  assertSafeHttpUrl,
  buildManualLead,
  canonicalDomainFromUrl,
  convertManualProspectToReal,
  findDuplicateManualLead,
  isUnsafeHostname,
  normalizeManualWebsiteUrl,
  outreachDisabled,
  validateManualProspectInput
};
