const crypto = require("crypto");
const { scanWebsite, normalizeUrl } = require("./websiteScanner");
const { APP_USER_AGENT } = require("./httpClient");
const { assertSafeHttpUrl } = require("./manualProspect");

const VERSION = "brain-zero-v1";
const DEFAULT_MAX_RESPONSE_BYTES = 1_000_000;

const runtimeState = {
  activeRuns: new Set(),
  activeProviders: new Map(),
  lastCrashAt: "",
  lastRecoveredAt: ""
};

function nowIso() {
  return new Date().toISOString();
}

function envNumber(name, fallback, { min = 1, max = Number.MAX_SAFE_INTEGER } = {}) {
  const value = Number(process.env[name] || fallback);
  if (!Number.isFinite(value)) return fallback;
  return Math.max(min, Math.min(max, value));
}

function brainZeroConfig() {
  return {
    totalTimeoutMs: envNumber("BRAIN_ZERO_TOTAL_TIMEOUT_MS", 120000, { min: 10000 }),
    pageTimeoutMs: envNumber("BRAIN_ZERO_PAGE_TIMEOUT_MS", 10000, { min: 1000 }),
    crawlTimeoutMs: envNumber("BRAIN_ZERO_CRAWL_TIMEOUT_MS", 45000, { min: 5000 }),
    technicalTimeoutMs: envNumber("BRAIN_ZERO_TECHNICAL_TIMEOUT_MS", 20000, { min: 3000 }),
    maxPages: envNumber("BRAIN_ZERO_MAX_PAGES", 10, { min: 1, max: 20 }),
    maxConcurrentRequests: envNumber("BRAIN_ZERO_MAX_CONCURRENT_REQUESTS", 2, { min: 1, max: 4 }),
    cacheTtlMs: envNumber("BRAIN_ZERO_CACHE_TTL_MS", 86400000, { min: 0 }),
    maxActiveRuns: envNumber("BRAIN_ZERO_MAX_ACTIVE_RUNS", 1, { min: 1, max: 3 }),
    maxResponseBytes: envNumber("BRAIN_ZERO_MAX_RESPONSE_BYTES", DEFAULT_MAX_RESPONSE_BYTES, { min: 100000, max: 3000000 }),
    maxRedirects: envNumber("BRAIN_ZERO_MAX_REDIRECTS", 3, { min: 0, max: 5 })
  };
}

function brainZeroRuntimeState() {
  return {
    activeRunCount: runtimeState.activeRuns.size,
    activeRunIds: [...runtimeState.activeRuns],
    activeProviders: Object.fromEntries(runtimeState.activeProviders.entries()),
    lastCrashAt: runtimeState.lastCrashAt,
    lastRecoveredAt: runtimeState.lastRecoveredAt
  };
}

function noteBrainZeroCrash() {
  runtimeState.lastCrashAt = nowIso();
}

function noteBrainZeroRecovery() {
  runtimeState.lastRecoveredAt = nowIso();
}

function memorySummary() {
  const memory = process.memoryUsage();
  return {
    rssMb: Math.round(memory.rss / 1024 / 1024),
    heapUsedMb: Math.round(memory.heapUsed / 1024 / 1024),
    heapTotalMb: Math.round(memory.heapTotal / 1024 / 1024),
    externalMb: Math.round(memory.external / 1024 / 1024)
  };
}

function canStartBrainZeroRun(config = brainZeroConfig()) {
  return runtimeState.activeRuns.size < config.maxActiveRuns;
}

function acquireBrainZeroRun(runId, config = brainZeroConfig()) {
  if (!canStartBrainZeroRun(config)) return false;
  runtimeState.activeRuns.add(runId);
  return true;
}

function releaseBrainZeroRun(runId) {
  runtimeState.activeRuns.delete(runId);
  runtimeState.activeProviders.delete(runId);
}

function setActiveBrainZeroProvider(runId, provider) {
  if (runId) runtimeState.activeProviders.set(runId, provider || "");
}

function compact(value = "", limit = 700) {
  return String(value || "").replace(/\s+/g, " ").trim().slice(0, limit);
}

function stripHtml(value = "") {
  return compact(String(value || "")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " "), 4000);
}

function parseTitle(html = "") {
  return compact((String(html).match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [])[1] || "", 160);
}

function parseMeta(html = "", name = "description") {
  const pattern = new RegExp(`<meta[^>]+(?:name|property)=["']${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}["'][^>]+content=["']([^"']+)["']`, "i");
  return compact((String(html).match(pattern) || [])[1] || "", 260);
}

function extractLinks(html = "", baseUrl = "") {
  const links = [];
  const regex = /href\s*=\s*["']([^"']+)["']/gi;
  let match;
  while ((match = regex.exec(String(html)))) {
    try {
      const url = new URL(match[1], baseUrl);
      url.hash = "";
      if (/^https?:$/i.test(url.protocol)) links.push(url.toString());
    } catch {}
  }
  return unique(links);
}

function extractEmails(text = "") {
  return unique((String(text || "").match(/[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/gi) || [])
    .map(email => email.toLowerCase())
    .filter(isValidEmail));
}

function extractPhones(text = "") {
  return unique(String(text || "").match(/(?:\+?\d[\d\s().-]{7,}\d)/g) || []);
}

function isValidEmail(value = "") {
  const text = String(value || "").trim().toLowerCase();
  if (!/^[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}$/i.test(text)) return false;
  return !/(example\.com|domain\.com|sentry\.io|wixpress\.com|wordpress\.com)$/i.test(text);
}

function genericInbox(email = "") {
  return /^(info|office|service|hello|contact|support|sales|admin|team|booking|bookings|jobs|careers|customerservice|help)@/i.test(email);
}

function normalizePhone(value = "") {
  const original = String(value || "").trim();
  const digits = original.replace(/[^\d+]/g, "");
  return { original, normalized: digits };
}

function unique(values = []) {
  const seen = new Set();
  return values.filter(value => {
    const key = String(value || "").trim();
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function sameDomain(url, root) {
  try {
    const a = new URL(url);
    const b = new URL(root);
    return a.hostname.replace(/^www\./, "") === b.hostname.replace(/^www\./, "");
  } catch {
    return false;
  }
}

function safePath(url = "") {
  try {
    const path = new URL(url).pathname.toLowerCase();
    return !/(login|signin|account|cart|checkout|wp-admin|admin|privacy-policy\/?submit|logout)/i.test(path);
  } catch {
    return false;
  }
}

function preferredPage(url = "") {
  return /(about|contact|service|pricing|faq|testimonials?|reviews?|booking|appointment|schedule|quote|estimate)/i.test(url);
}

function evidenceId(provider, field, index) {
  return `ev-${provider.replace(/_/g, "-")}-${field.replace(/[^a-z0-9]+/gi, "-").toLowerCase()}-${String(index + 1).padStart(3, "0")}`;
}

function makeEvidence(provider, category, field, value, source = {}, options = {}) {
  return {
    evidence_id: options.id || evidenceId(provider, field, options.index || 0),
    provider,
    category,
    claim_type: options.claimType || "observed",
    field,
    value,
    source_url: source.url || null,
    source_page_title: source.title || null,
    source_excerpt: compact(source.excerpt || "", 500) || null,
    collected_at: options.collectedAt || nowIso(),
    confidence: options.confidence || "medium",
    limitations: options.limitations || null
  };
}

function providerShell(provider) {
  const started = nowIso();
  return {
    provider,
    status: "running",
    started_at: started,
    completed_at: null,
    duration_ms: null,
    evidence: [],
    errors: [],
    warnings: []
  };
}

function finishProvider(result, startedAt, status) {
  const completed = nowIso();
  return {
    ...result,
    status: status || (result.errors.length ? (result.evidence.length ? "partial" : "failed") : "completed"),
    completed_at: completed,
    duration_ms: Date.parse(completed) - Date.parse(startedAt)
  };
}

async function withTimeout(promise, timeoutMs, label) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

async function fetchText(url, { timeoutMs, fetchImpl = fetch, method = "GET", maxResponseBytes } = {}) {
  let parsed;
  try {
    assertSafeHttpUrl(url);
    parsed = new URL(url);
  } catch {
    throw new Error("Invalid or unsafe URL");
  }
  if (!/^https?:$/i.test(parsed.protocol)) throw new Error("Unsupported URL protocol");
  const maxBytes = maxResponseBytes || brainZeroConfig().maxResponseBytes;
  const signal = typeof AbortSignal !== "undefined" && AbortSignal.timeout ? AbortSignal.timeout(timeoutMs || 10000) : undefined;
  const response = await fetchImpl(url, {
    method,
    redirect: "follow",
    signal,
    headers: {
      "User-Agent": APP_USER_AGENT,
      "Accept": method === "HEAD" ? "*/*" : "text/html,application/xhtml+xml,text/plain;q=0.8"
    }
  });
  try {
    assertSafeHttpUrl(response.url || url);
  } catch {
    throw new Error("Redirect destination rejected as unsafe");
  }
  const contentType = response.headers?.get?.("content-type") || "";
  const contentLength = Number(response.headers?.get?.("content-length") || 0);
  if (contentLength > maxBytes) throw new Error(`Response body rejected for excessive size (${contentLength} bytes)`);
  if (method !== "HEAD" && contentType && !/text\/html|application\/xhtml\+xml|text\/plain/i.test(contentType)) {
    throw new Error(`Non-HTML response skipped (${contentType})`);
  }
  const text = method === "HEAD" ? "" : await readBoundedText(response, maxBytes);
  return {
    ok: response.ok,
    status: response.status,
    statusText: response.statusText,
    url: response.url || url,
    headers: response.headers,
    text
  };
}

async function readBoundedText(response, maxBytes = DEFAULT_MAX_RESPONSE_BYTES) {
  if (!response.body || !response.body.getReader) {
    const text = await response.text();
    if (Buffer.byteLength(text, "utf8") > maxBytes) throw new Error(`Response body rejected for excessive size (${Buffer.byteLength(text, "utf8")} bytes)`);
    return text;
  }
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength || value.length || 0;
      if (total > maxBytes) {
        try { await reader.cancel(); } catch {}
        throw new Error(`Response body rejected for excessive size (${total} bytes)`);
      }
      chunks.push(Buffer.from(value));
    }
  } finally {
    try { reader.releaseLock?.(); } catch {}
  }
  return Buffer.concat(chunks).toString("utf8");
}

async function mapLimit(items, limit, worker) {
  const results = [];
  let index = 0;
  const workers = Array.from({ length: Math.max(1, limit) }, async () => {
    while (index < items.length) {
      const current = index;
      index += 1;
      results[current] = await worker(items[current], current);
    }
  });
  const settled = await Promise.allSettled(workers);
  const rejected = settled.find(item => item.status === "rejected");
  if (rejected) throw rejected.reason;
  return results;
}

async function robotsAllowed(rootUrl, targetUrl, options) {
  try {
    const root = new URL(rootUrl);
    const robotsUrl = `${root.protocol}//${root.host}/robots.txt`;
    const response = await fetchText(robotsUrl, { timeoutMs: Math.min(4000, options.pageTimeoutMs), fetchImpl: options.fetchImpl, maxResponseBytes: Math.min(options.maxResponseBytes || DEFAULT_MAX_RESPONSE_BYTES, 200000) });
    const text = response.text || "";
    const path = new URL(targetUrl).pathname || "/";
    let applies = false;
    for (const rawLine of text.split(/\r?\n/)) {
      const line = rawLine.trim();
      if (/^user-agent:\s*\*/i.test(line)) applies = true;
      else if (/^user-agent:/i.test(line)) applies = false;
      if (applies) {
        const disallow = line.match(/^disallow:\s*(.+)$/i)?.[1]?.trim();
        if (disallow && disallow !== "/" && path.startsWith(disallow)) return { allowed: false, robotsUrl };
        if (disallow === "/" && path === "/") return { allowed: false, robotsUrl };
      }
    }
    return { allowed: true, robotsUrl, available: response.ok };
  } catch (error) {
    return { allowed: true, robotsUrl: null, available: false, warning: `robots.txt unavailable: ${error.message}` };
  }
}

async function providerExistingSearch(context) {
  const result = providerShell("existing_lead_search");
  const source = context.existing_scraper_data || {};
  const leadParts = [
    context.business_name,
    context.known_location,
    context.known_phone,
    context.known_email,
    context.website_url
  ].filter(Boolean);
  if (!leadParts.length && !Object.keys(source).length) {
    result.warnings.push("No existing lead/search context was supplied.");
    return finishProvider(result, result.started_at, "skipped");
  }
  result.evidence.push(makeEvidence("existing_lead_search", "identity", "lead_record", {
    business_name: context.business_name || null,
    website_url: context.website_url || null,
    known_email: context.known_email || null,
    known_phone: context.known_phone || null,
    known_location: context.known_location || null,
    original_data_keys: Object.keys(source).slice(0, 30)
  }, {
    url: source.source || source.mapsUrl || source.osmUrl || source.website || context.website_url || null,
    excerpt: leadParts.join(" | ")
  }, { confidence: "medium" }));
  return finishProvider(result, result.started_at, "completed");
}

async function providerWebsiteCrawl(context, options) {
  const result = providerShell("website_crawl");
  const website = normalizeUrl(context.website_url || "");
  if (!website) {
    result.warnings.push("No website URL available.");
    return finishProvider(result, result.started_at, "skipped");
  }
  try {
    new URL(website);
  } catch {
    result.errors.push("Invalid website URL");
    return finishProvider(result, result.started_at, "failed");
  }
  const robots = await robotsAllowed(website, website, options);
  if (!robots.allowed) {
    result.warnings.push("robots.txt disallows the homepage path.");
    result.evidence.push(makeEvidence("website_crawl", "access", "robots_restriction", "restricted", {
      url: robots.robotsUrl,
      excerpt: "robots.txt disallowed the requested path."
    }, { claimType: "unknown", confidence: "high" }));
    return finishProvider(result, result.started_at, "partial");
  }
  if (robots.warning) result.warnings.push(robots.warning);
  const pages = [];
  const first = await fetchText(website, { timeoutMs: options.pageTimeoutMs, fetchImpl: options.fetchImpl, maxResponseBytes: options.maxResponseBytes });
  if (!first.ok) throw new Error(`Homepage returned HTTP ${first.status}`);
  if (!compact(first.text, 100)) result.warnings.push("Homepage returned empty or JavaScript-only content.");
  const firstPage = {
    url: first.url || website,
    status: first.status,
    title: parseTitle(first.text),
    text: stripHtml(first.text),
    html: first.text,
    links: extractLinks(first.text, first.url || website)
  };
  pages.push(firstPage);
  const candidateLinks = unique(firstPage.links
    .filter(link => sameDomain(link, website) && safePath(link))
    .sort((a, b) => Number(preferredPage(b)) - Number(preferredPage(a))))
    .slice(0, Math.max(0, options.maxPages - 1));
  const scanned = await withTimeout(mapLimit(candidateLinks, options.maxConcurrentRequests, async link => {
    const allowed = await robotsAllowed(website, link, options);
    if (!allowed.allowed) return { skipped: true, url: link, reason: "robots.txt disallowed this path" };
    try {
      const response = await fetchText(link, { timeoutMs: options.pageTimeoutMs, fetchImpl: options.fetchImpl, maxResponseBytes: options.maxResponseBytes });
      if (!response.ok) return { skipped: true, url: link, reason: `HTTP ${response.status}` };
      return {
        url: response.url || link,
        status: response.status,
        title: parseTitle(response.text),
        text: stripHtml(response.text),
        html: compact(response.text, 8000),
        links: extractLinks(response.text, response.url || link)
      };
    } catch (error) {
      return { skipped: true, url: link, reason: error.message };
    }
  }), options.crawlTimeoutMs, "Website crawl");
  for (const page of scanned) {
    if (page?.skipped) result.warnings.push(`${page.url}: ${page.reason}`);
    else if (page) pages.push(page);
  }
  const deduped = [];
  const seen = new Set();
  for (const page of pages) {
    const key = page.url.replace(/\/$/, "");
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(page);
  }
  result.raw = { pages: deduped.map(page => ({ ...page, html: compact(page.html || "", 8000), links: (page.links || []).slice(0, 40) })) };
  result.evidence = deduped.map((page, index) => makeEvidence("website_crawl", "website_page", "page_text", {
    url: page.url,
    title: page.title,
    text_excerpt: compact(page.text, 1000)
  }, {
    url: page.url,
    title: page.title,
    excerpt: page.text
  }, { index, confidence: "high" }));
  return finishProvider(result, result.started_at, result.warnings.length ? "partial" : "completed");
}

function pagesFromProvider(providerResult = {}) {
  return providerResult.raw?.pages || [];
}

async function providerWebsiteFeatures(context, options, prior) {
  const result = providerShell("website_feature_detection");
  const pages = pagesFromProvider(prior.website_crawl);
  if (!pages.length) {
    result.warnings.push("No scanned pages available for feature detection.");
    return finishProvider(result, result.started_at, "skipped");
  }
  const allHtml = pages.map(page => page.html || page.text || "").join("\n");
  const allText = pages.map(page => page.text || "").join("\n").toLowerCase();
  const allLinks = unique(pages.flatMap(page => page.links || []));
  const featureRules = {
    contact_form: /<form[\s>]/i.test(allHtml) || /contact form|request a quote|request service/i.test(allText),
    telephone_link: allLinks.some(link => /^tel:/i.test(link)) || /href=["']tel:/i.test(allHtml),
    email_link: allLinks.some(link => /^mailto:/i.test(link)) || /href=["']mailto:/i.test(allHtml),
    whatsapp_link: /wa\.me|whatsapp/i.test(allHtml),
    booking_link: /book online|schedule online|appointment|calendly|acuityscheduling|jobber|servicetitan|housecall pro/i.test(allText),
    calendar_tool: /calendly|calendar|appointment|schedule/i.test(allText),
    live_chat: /intercom|drift\.com|tawk\.to|crisp\.chat|zendesk chat|live chat/i.test(allHtml),
    chatbot: /chatbot|virtual assistant|ai assistant/i.test(allText),
    newsletter_form: /newsletter|subscribe/i.test(allText) && /<form[\s>]/i.test(allHtml),
    quote_request: /free quote|request quote|get estimate|free estimate/i.test(allText),
    online_payment: /pay online|payment portal|stripe|square payments/i.test(allText),
    customer_portal: /customer portal|client portal|login/i.test(allText),
    testimonials: /testimonial|reviews|what customers say/i.test(allText),
    case_studies: /case stud/i.test(allText),
    pricing: /pricing|price list|starting at/i.test(allText),
    faq: /faq|frequently asked/i.test(allText),
    blog: allLinks.some(link => /blog|articles|news/i.test(link)),
    business_hours: /hours|mon(day)?|tue(sday)?|wed(nesday)?|thu(rsday)?|fri(day)?|sat(urday)?|sun(day)?/i.test(allText),
    physical_address: /\d{2,6}\s+[a-z0-9 .'-]+\s+(street|st|road|rd|avenue|ave|drive|dr|lane|ln|boulevard|blvd|way)\b/i.test(allText),
    social_links: allLinks.filter(link => /facebook|instagram|linkedin|youtube|x\.com|twitter/i.test(link)).slice(0, 12),
    privacy_policy: allLinks.some(link => /privacy/i.test(link)),
    terms_page: allLinks.some(link => /terms/i.test(link))
  };
  let index = 0;
  for (const [field, detected] of Object.entries(featureRules)) {
    const value = Array.isArray(detected)
      ? detected
      : detected ? "detected" : "not_detected_on_scanned_pages";
    result.evidence.push(makeEvidence("website_feature_detection", "feature", field, value, {
      url: pages[0].url,
      title: pages[0].title,
      excerpt: `${field}: ${Array.isArray(value) ? value.join(", ") : value}`
    }, {
      index: index++,
      claimType: detected ? "observed" : "unknown",
      confidence: detected ? "high" : "medium",
      limitations: detected ? null : "This feature may exist on an unscanned page or external platform."
    }));
  }
  return finishProvider(result, result.started_at, "completed");
}

async function providerTechnical(context, options, prior) {
  const result = providerShell("technical_website_evidence");
  const website = normalizeUrl(context.website_url || "");
  if (!website) {
    result.warnings.push("No website URL available.");
    return finishProvider(result, result.started_at, "skipped");
  }
  const page = pagesFromProvider(prior.website_crawl)[0] || {};
  const root = new URL(website);
  const robotsUrl = `${root.protocol}//${root.host}/robots.txt`;
  const sitemapUrl = `${root.protocol}//${root.host}/sitemap.xml`;
  let robotsOk = false;
  let sitemapOk = false;
  try { robotsOk = (await fetchText(robotsUrl, { timeoutMs: Math.min(5000, options.technicalTimeoutMs), fetchImpl: options.fetchImpl, maxResponseBytes: 200000 })).ok; } catch {}
  try { sitemapOk = (await fetchText(sitemapUrl, { timeoutMs: Math.min(5000, options.technicalTimeoutMs), fetchImpl: options.fetchImpl, maxResponseBytes: 300000 })).ok; } catch {}
  const html = page.html || "";
  const schemaTypes = unique([...html.matchAll(/"@type"\s*:\s*"([^"]+)"/gi)].map(match => match[1])).slice(0, 10);
  const technical = {
    http_status: page.status || null,
    final_url: page.url || website,
    https_available: /^https:/i.test(page.url || website),
    page_title: page.title || parseTitle(html),
    meta_description: parseMeta(html, "description"),
    canonical_url: (html.match(/<link[^>]+rel=["']canonical["'][^>]+href=["']([^"']+)["']/i) || [])[1] || null,
    viewport_tag: /<meta[^>]+name=["']viewport["']/i.test(html),
    robots_txt_available: robotsOk,
    sitemap_available: sitemapOk,
    structured_data_schema_types: schemaTypes,
    open_graph_title: parseMeta(html, "og:title"),
    language: (html.match(/<html[^>]+lang=["']([^"']+)["']/i) || [])[1] || null,
    approximate_page_response_time_ms: prior.website_crawl?.duration_ms || null,
    broken_internal_links_found: []
  };
  result.evidence.push(makeEvidence("technical_website_evidence", "technical", "technical_snapshot", technical, {
    url: page.url || website,
    title: page.title,
    excerpt: JSON.stringify(technical)
  }, { confidence: "medium" }));
  return finishProvider(result, result.started_at, "completed");
}

async function providerIdentity(context, options, prior) {
  const result = providerShell("business_identity_evidence");
  const pages = pagesFromProvider(prior.website_crawl);
  const allText = pages.map(page => page.text || "").join("\n");
  const emails = unique([context.known_email, ...extractEmails(allText)]).filter(isValidEmail);
  const phones = unique([context.known_phone, ...extractPhones(allText)].filter(Boolean));
  const socials = unique(pages.flatMap(page => page.links || []).filter(link => /facebook|instagram|linkedin|youtube|x\.com|twitter/i.test(link))).slice(0, 10);
  const identities = [
    ["business_name", context.business_name],
    ["website_url", context.website_url],
    ["stated_location", context.known_location],
    ["phone", phones.map(normalizePhone)],
    ["email", emails],
    ["social_profile_links", socials]
  ];
  let index = 0;
  for (const [field, value] of identities) {
    if (!value || (Array.isArray(value) && !value.length)) continue;
    result.evidence.push(makeEvidence("business_identity_evidence", "identity", field, value, {
      url: pages[0]?.url || context.website_url || null,
      title: pages[0]?.title || null,
      excerpt: Array.isArray(value) ? JSON.stringify(value) : String(value)
    }, { index: index++, confidence: field === "business_name" ? "medium" : "high" }));
  }
  const nameMatches = [...allText.matchAll(/\b(?:owner|founder|president|ceo|manager)\s*(?:[:,-]|\bis\b)?\s+([A-Z][a-z]+(?:\s+[A-Z][a-z]+){1,2})/g)]
    .map(match => match[1])
    .filter(name => !name.includes("@"))
    .slice(0, 5);
  for (const name of unique(nameMatches)) {
    result.evidence.push(makeEvidence("business_identity_evidence", "identity", "public_team_or_contact_name", name, {
      url: pages[0]?.url || context.website_url || null,
      title: pages[0]?.title || null,
      excerpt: name
    }, { index: index++, confidence: "low", limitations: "Role/name was pattern-matched from public page text and should be treated cautiously." }));
  }
  for (const email of emails) {
    if (genericInbox(email)) {
      result.evidence.push(makeEvidence("business_identity_evidence", "contact", "generic_inbox", email, {
        url: pages[0]?.url || context.website_url || null,
        excerpt: email
      }, { index: index++, confidence: "high", limitations: "Generic inbox; not a person's name." }));
    }
  }
  return finishProvider(result, result.started_at, result.evidence.length ? "completed" : "partial");
}

async function providerTrust(context, options, prior) {
  const result = providerShell("public_trust_evidence");
  const pages = pagesFromProvider(prior.website_crawl);
  if (!pages.length) return finishProvider({ ...result, warnings: ["No pages available for trust evidence."] }, result.started_at, "skipped");
  const patterns = [
    ["testimonials", /testimonial|reviews|customers say/i],
    ["accreditations", /accredited|accreditation|bbb/i],
    ["certifications", /certified|certification|licensed|insured|bonded/i],
    ["awards", /award[-\s]?winning|winner|voted best/i],
    ["years_in_business", /\b(\d{2,3})\+?\s+years/i],
    ["customer_counts", /\b(\d{3,})\+?\s+(customers|clients|homeowners)/i],
    ["guarantees", /guarantee|warranty|satisfaction/i],
    ["partnerships", /partner|authorized dealer/i],
    ["memberships", /member of|association/i]
  ];
  let index = 0;
  for (const page of pages) {
    for (const [field, pattern] of patterns) {
      const match = page.text?.match(pattern);
      if (!match) continue;
      result.evidence.push(makeEvidence("public_trust_evidence", "trust", field, compact(match[0], 120), {
        url: page.url,
        title: page.title,
        excerpt: page.text
      }, {
        index: index++,
        claimType: "business_claim",
        confidence: "medium",
        limitations: "This is a claim made on the business's own public website and was not independently verified."
      }));
    }
  }
  return finishProvider(result, result.started_at, result.evidence.length ? "completed" : "partial");
}

async function providerContent(context, options, prior) {
  const result = providerShell("content_discoverability_evidence");
  const pages = pagesFromProvider(prior.website_crawl);
  if (!pages.length) return finishProvider({ ...result, warnings: ["No pages available for content evidence."] }, result.started_at, "skipped");
  const text = pages.map(page => page.text || "").join("\n");
  const html = pages.map(page => page.html || "").join("\n");
  const headings = unique([...html.matchAll(/<h[1-3][^>]*>([\s\S]*?)<\/h[1-3]>/gi)].map(match => stripHtml(match[1]))).slice(0, 20);
  const facts = {
    page_headings: headings,
    faq_content_present: /faq|frequently asked|questions/i.test(text),
    local_terms_present: /serving|service area|near me|surrounding|local/i.test(text),
    service_descriptions_present: /repair|install|replacement|maintenance|service/i.test(text),
    author_information_present: /by\s+[A-Z][a-z]+|author/i.test(text),
    recent_blog_or_article_dates: unique((text.match(/\b(?:20[2-3]\d|19\d\d)\b/g) || []).slice(0, 8)),
    explains_what_it_does: /repair|install|replacement|maintenance|service/i.test(text),
    explains_who_it_serves: /homeowner|residential|commercial|business|property manager/i.test(text),
    explains_where_it_operates: /serving|service area|located in|nearby/i.test(text),
    explains_how_to_contact: /call|phone|email|contact|quote|estimate/i.test(text)
  };
  result.evidence.push(makeEvidence("content_discoverability_evidence", "content", "content_snapshot", facts, {
    url: pages[0].url,
    title: pages[0].title,
    excerpt: JSON.stringify(facts)
  }, { confidence: "medium" }));
  return finishProvider(result, result.started_at, "completed");
}

function normalizeProviderOutput(result, providerName) {
  if (!result || typeof result !== "object") throw new Error("Provider returned malformed output");
  result.provider = result.provider || providerName;
  result.status = ["completed", "partial", "failed", "skipped", "running"].includes(result.status) ? result.status : "partial";
  result.started_at = result.started_at || nowIso();
  result.completed_at = result.completed_at || nowIso();
  result.duration_ms = Number.isFinite(Number(result.duration_ms)) ? Number(result.duration_ms) : 0;
  result.evidence = Array.isArray(result.evidence) ? result.evidence.filter(item => item && typeof item === "object") : [];
  result.errors = Array.isArray(result.errors) ? result.errors.map(error => String(error).slice(0, 500)) : [];
  result.warnings = Array.isArray(result.warnings) ? result.warnings.map(warning => String(warning).slice(0, 500)) : [];
  result.usable_evidence_count = result.evidence.filter(isUsableEvidence).length;
  result.execution_status = result.status;
  result.coverage_status = result.usable_evidence_count ? "contributed" : "insufficient";
  return result;
}

function failedProviderResult(name, error) {
  const failed = providerShell(name);
  failed.errors.push(error?.message || "Provider failed");
  return finishProvider(failed, failed.started_at, "failed");
}

async function safeRunProvider(name, fn, context, options, prior, logger) {
  const started = Date.now();
  logger?.("info", "brain_zero_provider_started", { provider: name });
  setActiveBrainZeroProvider(options.runId, name);
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const result = await fn(context, options, prior);
      const normalized = normalizeProviderOutput(result, name);
      logger?.("info", "brain_zero_provider_completed", {
        provider: name,
        status: normalized.status,
        durationMs: normalized.duration_ms,
        evidence: normalized.evidence.length
      });
      return normalized;
    } catch (error) {
      if (attempt === 0) {
        logger?.("warn", "brain_zero_provider_retry", { provider: name, error: error.message });
        continue;
      }
      const result = failedProviderResult(name, error);
      logger?.("error", "brain_zero_provider_failed", { provider: name, error: error.message, durationMs: Date.now() - started });
      return result;
    } finally {
      setActiveBrainZeroProvider(options.runId, "");
    }
  }
  return failedProviderResult(name, new Error("Provider failed without returning a result"));
}

function dedupeEvidence(evidence = []) {
  const seen = new Set();
  const removed = [];
  const kept = [];
  for (const item of evidence) {
    if (!item || typeof item !== "object") continue;
    if (String(item.value || "").includes("@") && ["owner_name", "contact_name"].includes(item.field)) {
      removed.push(item);
      continue;
    }
    if (item.field === "email" && Array.isArray(item.value)) {
      item.value = item.value.filter(isValidEmail).map(email => email.toLowerCase());
    }
    const key = JSON.stringify([item.provider, item.category, item.field, item.value, item.source_url]);
    if (seen.has(key)) {
      removed.push(item);
      continue;
    }
    seen.add(key);
    kept.push(item);
  }
  kept.forEach((item, index) => {
    item.evidence_id = item.evidence_id || evidenceId(item.provider || "brain_zero", item.field || "evidence", index);
  });
  return { evidence: kept, removed };
}

function isUsableEvidence(item = {}) {
  if (!item || typeof item !== "object") return false;
  if (!item.evidence_id) return false;
  const value = typeof item.value === "string" ? item.value.trim() : item.value;
  if (value === null || value === undefined || value === "") return false;
  if (Array.isArray(value) && value.length === 0) return false;
  return true;
}

function evidenceMatches(item = {}, category, fields = []) {
  if (!isUsableEvidence(item)) return false;
  const fieldSet = new Set(fields);
  return item.category === category || fieldSet.has(item.field);
}

function coverageFlagsForEvidence(evidence = []) {
  const usable = evidence.filter(isUsableEvidence);
  return {
    official_business_identity: usable.some(item => evidenceMatches(item, "identity", ["business_name"])),
    official_domain: usable.some(item => ["website_url", "domain", "final_url"].includes(item.field) || (item.source_url && /^https?:\/\//i.test(item.source_url))),
    industry_service_category: usable.some(item => ["business_category", "trade", "industry", "primary_service", "services_detected", "services"].includes(item.field) || /service|hvac|plumb|roof|electric|garage/i.test(JSON.stringify(item.value || ""))),
    city_service_area: usable.some(item => ["stated_location", "service_area", "city", "location"].includes(item.field) || /serving|service area|located/i.test(JSON.stringify(item.value || ""))),
    business_description: usable.some(item => ["description", "content_snapshot", "page_title"].includes(item.field) || item.category === "content"),
    services: usable.some(item => ["services_detected", "service_descriptions_present", "services"].includes(item.field) || /repair|install|maintenance|replacement|service/i.test(JSON.stringify(item.value || ""))),
    contact_path: usable.some(item => item.category === "contact" || ["phone", "email", "generic_inbox", "contact_form"].includes(item.field)),
    conversion_path: usable.some(item => ["booking_link", "contact_form", "quote_form", "phone_link", "online_booking"].includes(item.field)),
    trust_reputation: usable.some(item => item.category === "trust" || ["testimonials", "reviews", "certifications", "years_in_business", "licensed"].includes(item.field)),
    website_usability: usable.some(item => item.provider === "website_feature_detection" || ["website_feature_snapshot", "mobile_responsive", "navigation"].includes(item.field)),
    technical_readiness: usable.some(item => item.provider === "technical_website_evidence" || item.category === "technical"),
    content_discoverability: usable.some(item => item.provider === "content_discoverability_evidence" || item.category === "content")
  };
}

function calculateEvidenceCoverage({ providers = {}, evidence = [], pagesScanned = 0 } = {}) {
  const usable = evidence.filter(isUsableEvidence);
  const has = coverageFlagsForEvidence(usable);
  const critical = ["official_business_identity", "official_domain", "industry_service_category", "city_service_area", "contact_path"];
  const missing_critical_categories = critical.filter(key => !has[key]);
  const coverageKeys = Object.keys(has);
  const coverage_score = Math.round((coverageKeys.filter(key => has[key]).length / coverageKeys.length) * 100);
  const quantity_score = Math.min(100, Math.round((usable.length / 40) * 100));
  const sourceCount = unique(usable.map(item => item.source_url).filter(Boolean)).length;
  const providerCount = unique(usable.map(item => item.provider).filter(Boolean)).length;
  const source_diversity_score = Math.min(100, Math.round(((sourceCount * 12) + (providerCount * 8) + (pagesScanned * 5))));
  const identity_confidence = has.official_business_identity && has.official_domain && has.city_service_area
    ? "high"
    : has.official_business_identity && (has.official_domain || has.city_service_area)
      ? "medium"
      : "low";
  const brain_one_ready = missing_critical_categories.length === 0 && coverage_score >= 50;
  return {
    quantity_score,
    coverage_score,
    source_diversity_score,
    identity_confidence,
    brain_one_ready,
    missing_critical_categories,
    coverage: has,
    evidence_counts_by_category: usable.reduce((acc, item) => {
      const key = item.category || "unknown";
      acc[key] = (acc[key] || 0) + 1;
      return acc;
    }, {}),
    evidence_counts_by_confidence: usable.reduce((acc, item) => {
      const key = item.confidence || "unknown";
      acc[key] = (acc[key] || 0) + 1;
      return acc;
    }, {}),
    evidence_with_valid_id: usable.length,
    provider_diagnostics: Object.fromEntries(Object.entries(providers).map(([key, provider]) => {
      const providerEvidence = (provider.evidence || []).filter(isUsableEvidence);
      const providerCoverage = coverageFlagsForEvidence(providerEvidence);
      const contributed = Object.entries(providerCoverage).filter(([, present]) => present).map(([coverageKey]) => coverageKey);
      return [key, {
        provider: key,
        execution_status: provider.status || "unknown",
        usable_evidence_count: providerEvidence.length,
        critical_coverage_contributed: contributed,
        coverage_status: contributed.length ? "contributed" : "insufficient"
      }];
    }))
  };
}

function buildEvidenceIndex(evidence = [], providers = {}) {
  const evidence_by_id = {};
  const evidence_by_category = {};
  const source_urls = [];
  for (const item of evidence) {
    evidence_by_id[item.evidence_id] = item;
    evidence_by_category[item.category] = evidence_by_category[item.category] || [];
    evidence_by_category[item.category].push(item.evidence_id);
    if (item.source_url) source_urls.push(item.source_url);
  }
  return {
    evidence_by_id,
    evidence_by_category,
    source_urls: unique(source_urls),
    collection_summary: {
      provider_count: Object.keys(providers).length,
      completed_providers: Object.values(providers).filter(provider => provider.status === "completed").length,
      evidence_count: evidence.length
    }
  };
}

function evidenceQuality({ coverage }) {
  if (!coverage?.brain_one_ready) return "weak";
  if (coverage.coverage_score >= 70 && coverage.quantity_score >= 50 && coverage.source_diversity_score >= 35 && coverage.identity_confidence !== "low") return "strong";
  if (coverage.coverage_score >= 50) return "moderate";
  return "weak";
}

function buildBrainOneEvidencePackage({ providers, evidence, status, quality, coverage }) {
  const index = buildEvidenceIndex(evidence, providers);
  const pages = Object.values(index.evidence_by_id)
    .filter(item => item.provider === "website_crawl" && item.category === "website_page")
    .map(item => ({ url: item.source_url, title: item.source_page_title, excerpt: item.source_excerpt, evidence_id: item.evidence_id }));
  return {
    business_identity_candidates: Object.values(index.evidence_by_id).filter(item => item.category === "identity"),
    contacts: Object.values(index.evidence_by_id).filter(item => item.category === "contact" || ["email", "phone"].includes(item.field)),
    website_pages: pages,
    website_features: Object.values(index.evidence_by_id).filter(item => item.provider === "website_feature_detection"),
    technical_evidence: Object.values(index.evidence_by_id).filter(item => item.provider === "technical_website_evidence"),
    trust_evidence: Object.values(index.evidence_by_id).filter(item => item.provider === "public_trust_evidence"),
    content_evidence: Object.values(index.evidence_by_id).filter(item => item.provider === "content_discoverability_evidence"),
    evidence_log: evidence,
    evidence_by_id: index.evidence_by_id,
    evidence_by_category: index.evidence_by_category,
    source_urls: index.source_urls,
    collection_limitations: Object.values(providers).flatMap(provider => provider.warnings || []),
    provider_statuses: Object.fromEntries(Object.entries(providers).map(([key, provider]) => [key, provider.status])),
    provider_diagnostics: coverage?.provider_diagnostics || {},
    evidence_coverage: coverage || null,
    brain_one_ready: !!coverage?.brain_one_ready,
    missing_critical_categories: coverage?.missing_critical_categories || [],
    overall_evidence_quality: quality,
    brain_zero_status: status === "completed" ? "completed" : "partial",
    collection_summary: index.collection_summary
  };
}

function evidenceHash(packageValue = {}) {
  return crypto.createHash("sha256").update(JSON.stringify(packageValue)).digest("hex");
}

function contextFromLead(lead = {}) {
  return {
    business_id: lead.id || "",
    business_name: lead.business || null,
    website_url: lead.website || null,
    known_email: lead.email || null,
    known_phone: lead.phone || null,
    known_location: [lead.city, lead.state, lead.country].filter(Boolean).join(", ") || lead.area || null,
    existing_scraper_data: lead,
    requested_at: nowIso()
  };
}

async function runBrainZeroEvidenceCollection(businessContext = {}, options = {}) {
  const config = { ...brainZeroConfig(), ...options.config };
  const logger = options.logger || (() => {});
  const runId = options.runId || `bz_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  let acquired = false;
  if (options.enforceActiveLimit) {
    acquired = acquireBrainZeroRun(runId, config);
    if (!acquired) {
      return {
        run_id: runId,
        business_id: String(businessContext.business_id || ""),
        status: "queued",
        providers: {},
        evidence_count: 0,
        source_count: 0,
        pages_scanned: 0,
        started_at: nowIso(),
        completed_at: null,
        duration_ms: null,
        errors: [],
        warnings: ["Evidence collection will begin when the current run finishes."],
        evidence_package: {},
        evidence_package_hash: "",
        overall_evidence_quality: "weak",
        version: VERSION,
        message: "Evidence collection will begin when the current run finishes."
      };
    }
  }
  const context = {
    business_id: String(businessContext.business_id || ""),
    business_name: businessContext.business_name || null,
    website_url: businessContext.website_url ? normalizeUrl(businessContext.website_url) : null,
    known_email: businessContext.known_email ? String(businessContext.known_email).toLowerCase() : null,
    known_phone: businessContext.known_phone || null,
    known_location: businessContext.known_location || null,
    existing_scraper_data: businessContext.existing_scraper_data || null,
    requested_at: businessContext.requested_at || nowIso()
  };
  const startedAt = nowIso();
  const startedMs = Date.now();
  logger("info", "brain_zero_run_started", {
    businessId: context.business_id,
    website: context.website_url,
    maxPages: config.maxPages,
    activeRunCount: runtimeState.activeRuns.size,
    memory: memorySummary()
  });
  const prior = {};
  const providers = {};
  let internalError = null;
  try {
    const providerDefs = [
      ["existing_lead_search", providerExistingSearch],
      ["website_crawl", providerWebsiteCrawl],
      ["website_feature_detection", providerWebsiteFeatures],
      ["technical_website_evidence", providerTechnical],
      ["business_identity_evidence", providerIdentity],
      ["public_trust_evidence", providerTrust],
      ["content_discoverability_evidence", providerContent]
    ];
    for (const [name, fn] of providerDefs) {
      if (Date.now() - startedMs > config.totalTimeoutMs) {
        providers[name] = finishProvider({
          ...providerShell(name),
          warnings: ["Skipped because the Brain Zero total run timeout was reached."]
        }, nowIso(), "skipped");
        prior[name] = providers[name];
        continue;
      }
      providers[name] = await safeRunProvider(name, fn, context, {
        ...config,
        runId,
        fetchImpl: options.fetchImpl || fetch,
        scanWebsiteImpl: options.scanWebsiteImpl || scanWebsite
      }, prior, logger);
      prior[name] = providers[name];
    }
  } catch (error) {
    internalError = error;
    logger("error", "brain_zero_internal_error", {
      businessId: context.business_id,
      runId,
      error: error.message
    });
  }
  const allEvidence = Object.values(providers).flatMap(provider => provider.evidence || []);
  const { evidence, removed } = dedupeEvidence(allEvidence);
  const pagesScanned = pagesFromProvider(providers.website_crawl).length;
  const sourceCount = unique(evidence.map(item => item.source_url).filter(Boolean)).length;
  const completedAt = nowIso();
  const anyEvidence = evidence.length > 0;
  const failedProviders = Object.values(providers).filter(provider => provider.status === "failed");
  const status = internalError
    ? (anyEvidence ? "partial" : "failed")
    : !anyEvidence ? "failed" : failedProviders.length ? "partial" : "completed";
  const coverage = anyEvidence ? calculateEvidenceCoverage({ providers, evidence, pagesScanned }) : calculateEvidenceCoverage({ providers, evidence: [], pagesScanned: 0 });
  const quality = anyEvidence ? evidenceQuality({ coverage }) : "weak";
  const evidence_package = anyEvidence
    ? buildBrainOneEvidencePackage({ providers, evidence, status, quality, coverage })
    : {};
  if (evidence_package.evidence_log) evidence_package.evidence_package_hash = evidenceHash(evidence_package);
  logger("info", "brain_zero_run_finished", {
    businessId: context.business_id,
    status,
    evidenceCount: evidence.length,
    pagesScanned,
    duplicateEvidenceRemoved: removed.length,
    quality
  });
  const finalResult = {
    run_id: runId,
    business_id: context.business_id,
    status,
    providers,
    evidence_count: evidence.length,
    source_count: sourceCount,
    pages_scanned: pagesScanned,
    started_at: startedAt,
    completed_at: completedAt,
    duration_ms: Date.parse(completedAt) - Date.parse(startedAt),
    errors: [
      ...Object.values(providers).flatMap(provider => provider.errors || []),
      ...(internalError ? [{
        code: "brain_zero_internal_error",
        message: "Evidence collection encountered an internal error.",
        provider: null,
        technical_message: internalError.message
      }] : [])
    ],
    warnings: [
      ...Object.values(providers).flatMap(provider => provider.warnings || []),
      ...(removed.length ? [`Removed ${removed.length} duplicate or unsafe evidence records.`] : [])
    ],
    evidence_package,
    evidence_package_hash: evidence_package.evidence_package_hash || "",
    overall_evidence_quality: quality,
    evidence_coverage: coverage,
    brain_one_ready: !!coverage.brain_one_ready,
    missing_critical_categories: coverage.missing_critical_categories || [],
    version: VERSION,
    memory_before: options.memoryBefore || null,
    memory_after: memorySummary()
  };
  if (acquired) releaseBrainZeroRun(runId);
  logger("info", "brain_zero_run_cleanup_completed", {
    businessId: context.business_id,
    runId,
    activeRunCount: runtimeState.activeRuns.size,
    memory: finalResult.memory_after
  });
  return finalResult;
}

function brainZeroCanRunBrainOne(run = {}, { acceptPartial = false } = {}) {
  if (!run || !run.status) return { allowed: false, warning: "", reason: "Brain Zero has not collected evidence for this business yet." };
  const packageValue = run.evidence_package || {};
  const readinessKnown = "brain_one_ready" in packageValue || "brain_one_ready" in run;
  const ready = packageValue.brain_one_ready ?? run.brain_one_ready;
  const missing = packageValue.missing_critical_categories || run.missing_critical_categories || [];
  if (readinessKnown && !ready) {
    const reason = `Brain Zero evidence is missing critical categories: ${missing.join(", ") || "unknown critical coverage"}.`;
    if (acceptPartial) return { allowed: true, warning: `Manual override: ${reason}`, reason: "" };
    return { allowed: false, warning: "Brain Zero collected records, but critical business coverage is incomplete.", reason };
  }
  if (run.status === "completed") return { allowed: true, warning: "", reason: "" };
  if (run.status === "partial" && acceptPartial) {
    return { allowed: true, warning: "Brain One is running with partial evidence. Unknowns may be larger.", reason: "" };
  }
  if (run.status === "partial") {
    return { allowed: false, warning: "Partial evidence requires manual confirmation before Brain One.", reason: "Brain Zero is partial." };
  }
  return { allowed: false, warning: "", reason: "Brain Zero failed and did not collect usable evidence." };
}

module.exports = {
  VERSION,
  acquireBrainZeroRun,
  brainZeroCanRunBrainOne,
  brainZeroConfig,
  brainZeroRuntimeState,
  buildBrainOneEvidencePackage,
  calculateEvidenceCoverage,
  canStartBrainZeroRun,
  contextFromLead,
  dedupeEvidence,
  evidenceHash,
  genericInbox,
  isValidEmail,
  makeEvidence,
  memorySummary,
  noteBrainZeroCrash,
  noteBrainZeroRecovery,
  releaseBrainZeroRun,
  runBrainZeroEvidenceCollection,
  safeRunProvider
};
