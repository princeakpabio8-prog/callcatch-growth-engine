const { fetchJson, APP_USER_AGENT } = require("./httpClient");

function textFetch(url, options = {}) {
  return fetch(url, {
    ...options,
    headers: {
      "User-Agent": APP_USER_AGENT,
      "Accept": "text/html,application/xhtml+xml",
      ...(options.headers || {})
    }
  }).then(async response => {
    if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
    return response.text();
  });
}

function normalizeUrl(value) {
  if (!value) return "";
  const text = String(value).trim();
  if (!text) return "";
  if (/^https?:\/\//i.test(text)) return text;
  return `https://${text}`;
}

function unique(values) {
  return [...new Set(values.filter(Boolean).map(value => String(value).trim()))];
}

function decodeHtmlEntities(value = "") {
  return String(value)
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)))
    .replace(/&#x([a-f0-9]+);/gi, (_, code) => String.fromCharCode(parseInt(code, 16)))
    .replace(/&amp;/g, "&")
    .replace(/&commat;/g, "@")
    .replace(/&period;/g, ".");
}

function decodeCloudflareEmail(hex = "") {
  const clean = String(hex || "").replace(/[^a-f0-9]/gi, "");
  if (clean.length < 4 || clean.length % 2) return "";
  const key = parseInt(clean.slice(0, 2), 16);
  let email = "";
  for (let index = 2; index < clean.length; index += 2) {
    email += String.fromCharCode(parseInt(clean.slice(index, index + 2), 16) ^ key);
  }
  return email;
}

function extractEmails(html = "") {
  const decoded = decodeHtmlEntities(html);
  const emails = [];
  emails.push(...(decoded.match(/[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/gi) || []));

  const mailtoRegex = /href\s*=\s*["']mailto:([^"'?]+)(?:\?[^"']*)?["']/gi;
  let mailto;
  while ((mailto = mailtoRegex.exec(decoded))) {
    try {
      emails.push(decodeURIComponent(mailto[1]));
    } catch {
      emails.push(mailto[1]);
    }
  }

  const cfRegex = /data-cfemail\s*=\s*["']([a-f0-9]+)["']/gi;
  let cfMatch;
  while ((cfMatch = cfRegex.exec(decoded))) {
    emails.push(decodeCloudflareEmail(cfMatch[1]));
  }

  const obfuscated = decoded
    .replace(/\s*(?:\[|\(|\{)?\s*at\s*(?:\]|\)|\})?\s*/gi, "@")
    .replace(/\s*(?:\[|\(|\{)?\s*dot\s*(?:\]|\)|\})?\s*/gi, ".")
    .replace(/\s+@\s+/g, "@")
    .replace(/\s+\.\s+/g, ".");
  emails.push(...(obfuscated.match(/[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/gi) || []));

  return unique(emails.map(email => email.toLowerCase()));
}

function sameHost(link, url) {
  try {
    const parsed = new URL(link);
    return /^https?:$/i.test(parsed.protocol) && parsed.hostname === new URL(url).hostname;
  } catch {
    return false;
  }
}

function commonProbeLinks(url, links = []) {
  const base = new URL(url);
  const root = `${base.protocol}//${base.hostname}`;
  const commonPaths = [
    "/contact",
    "/contact-us",
    "/about",
    "/about-us",
    "/team",
    "/locations",
    "/service-area",
    "/request-service",
    "/schedule",
    "/booking",
    "/free-estimate",
    "/quote"
  ].map(path => `${root}${path}`);
  return unique([...links, ...commonPaths])
    .filter(link => /contact|quote|estimate|appointment|schedule|booking|get-started|service|about|team|locations|areas/i.test(link))
    .filter(link => sameHost(link, url))
    .slice(0, 16);
}

function mergeSignals(scans) {
  const merged = {
    emails: [],
    phones: [],
    pageTitles: [],
    metaDescriptions: [],
    serviceKeywords: [],
    trustSignals: [],
    weakSignals: [],
    contactForms: false,
    bookingSoftware: [],
    liveChat: false,
    aiChatbot: false,
    facebook: "",
    instagram: "",
    linkedin: "",
    publicSocialPages: [],
    publicSocialPagesScanned: 0,
    businessHours: false,
    emergencyService: false,
    financing: false,
    freeEstimate: false,
    serviceAreaMessaging: false,
    careersHiring: false,
    ownerMentions: [],
    noOnlineBooking: true,
    noChatDetected: true
  };

  for (const scan of scans) {
    merged.emails.push(...(scan.emails || []));
    merged.phones.push(...(scan.phones || []));
    merged.pageTitles.push(...(scan.pageTitles || []));
    merged.metaDescriptions.push(...(scan.metaDescriptions || []));
    merged.serviceKeywords.push(...(scan.serviceKeywords || []));
    merged.trustSignals.push(...(scan.trustSignals || []));
    merged.weakSignals.push(...(scan.weakSignals || []));
    merged.ownerMentions.push(...(scan.ownerMentions || []));
    merged.bookingSoftware.push(...(scan.bookingSoftware || []));
    merged.contactForms = merged.contactForms || scan.contactForms;
    merged.liveChat = merged.liveChat || scan.liveChat;
    merged.aiChatbot = merged.aiChatbot || scan.aiChatbot;
    merged.facebook = merged.facebook || scan.facebook;
    merged.instagram = merged.instagram || scan.instagram;
    merged.linkedin = merged.linkedin || scan.linkedin;
    merged.publicSocialPages.push(...(scan.publicSocialPages || []));
    merged.publicSocialPagesScanned += Number(scan.publicSocialPagesScanned || 0);
    merged.businessHours = merged.businessHours || scan.businessHours;
    merged.emergencyService = merged.emergencyService || scan.emergencyService;
    merged.financing = merged.financing || scan.financing;
    merged.freeEstimate = merged.freeEstimate || scan.freeEstimate;
    merged.serviceAreaMessaging = merged.serviceAreaMessaging || scan.serviceAreaMessaging;
    merged.careersHiring = merged.careersHiring || scan.careersHiring;
    merged.noOnlineBooking = merged.noOnlineBooking && scan.noOnlineBooking;
    merged.noChatDetected = merged.noChatDetected && scan.noChatDetected;
  }

  merged.emails = unique(merged.emails)
    .filter(email => !/(example\.com|domain\.com|sentry\.io|wixpress\.com|wordpress\.com)$/i.test(email))
    .slice(0, 12);
  merged.phones = unique(merged.phones).slice(0, 12);
  merged.pageTitles = unique(merged.pageTitles).slice(0, 8);
  merged.metaDescriptions = unique(merged.metaDescriptions).slice(0, 8);
  merged.serviceKeywords = unique(merged.serviceKeywords).slice(0, 16);
  merged.trustSignals = unique(merged.trustSignals).slice(0, 16);
  merged.weakSignals = unique(merged.weakSignals).slice(0, 16);
  merged.ownerMentions = unique(merged.ownerMentions).slice(0, 8);
  merged.publicSocialPages = unique(merged.publicSocialPages).slice(0, 8);
  merged.bookingSoftware = unique(merged.bookingSoftware);
  return merged;
}

function extractLinks(html, baseUrl) {
  const links = [];
  const regex = /href\s*=\s*["']([^"']+)["']/gi;
  let match;
  while ((match = regex.exec(html))) {
    try {
      links.push(new URL(match[1], baseUrl).toString());
    } catch {}
  }
  return unique(links);
}

function isPublicFacebookLink(link) {
  try {
    const parsed = new URL(link);
    const host = parsed.hostname.replace(/^www\./, "").replace(/^m\./, "").replace(/^mbasic\./, "");
    if (host !== "facebook.com" && host !== "fb.com") return false;
    const path = parsed.pathname.toLowerCase();
    if (!path || path === "/") return false;
    if (/\/(sharer|share|plugins|login|dialog|events|groups|marketplace|privacy|policies|help)\b/.test(path)) return false;
    return true;
  } catch {
    return false;
  }
}

function facebookProbeUrls(link) {
  try {
    const parsed = new URL(link);
    parsed.hash = "";
    parsed.search = "";
    parsed.hostname = "www.facebook.com";
    const base = parsed.toString().replace(/\/$/, "");
    return unique([
      base,
      `${base}/about`,
      `${base}/about_contact_and_basic_info`
    ]);
  } catch {
    return [];
  }
}

function detect(html, links) {
  const lower = html.toLowerCase();
  const emailMatches = extractEmails(html);
  const phoneMatches = html.match(/(?:\+?1[\s.-]?)?\(?\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}/g) || [];
  const title = (html.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [])[1] || "";
  const metaDescription = (html.match(/<meta[^>]+name=["']description["'][^>]+content=["']([^"']+)["']/i) || [])[1] || "";
  const social = {
    facebook: links.find(link => link.includes("facebook.com")) || "",
    instagram: links.find(link => link.includes("instagram.com")) || "",
    linkedin: links.find(link => link.includes("linkedin.com")) || ""
  };
  const bookingWords = ["book online", "schedule online", "request appointment", "calendly", "acuityscheduling", "jobber", "housecall pro", "servicetitan", "fieldedge"];
  const chatWords = ["live chat", "intercom", "drift.com", "tawk.to", "crisp.chat", "zendesk chat", "chatbot"];
  const aiWords = ["ai chatbot", "virtual assistant", "automated assistant"];
  const serviceWords = ["repair", "installation", "maintenance", "replacement", "inspection", "tune-up", "drain cleaning", "water heater", "roof replacement", "ac repair", "furnace", "garage door", "emergency service"];
  const trustWords = ["licensed", "insured", "bonded", "family owned", "locally owned", "years of experience", "bbb", "5-star", "five star", "reviews", "guarantee", "warranty"];
  const weakWords = ["coming soon", "under construction", "parked domain", "not secure", "copyright 2018", "copyright 2019", "copyright 2020", "wordpress", "wix", "weebly"];
  const ownerMatches = html.match(/(?:owner|founder|president|ceo|operator)\s*(?:[:\-]|is|,)?\s*([A-Z][a-z]+(?:\s+[A-Z][a-z]+){0,2})/g) || [];

  return {
    emails: unique(emailMatches).slice(0, 8),
    phones: unique(phoneMatches).slice(0, 8),
    pageTitles: title ? [title.replace(/\s+/g, " ").trim()] : [],
    metaDescriptions: metaDescription ? [metaDescription.replace(/\s+/g, " ").trim()] : [],
    serviceKeywords: serviceWords.filter(word => lower.includes(word)),
    trustSignals: trustWords.filter(word => lower.includes(word)),
    weakSignals: weakWords.filter(word => lower.includes(word)),
    ownerMentions: ownerMatches.map(text => text.replace(/\s+/g, " ").trim()).slice(0, 4),
    contactForms: /<form[\s>]/i.test(html) || links.some(link => /contact|estimate|quote/i.test(link)),
    bookingSoftware: bookingWords.filter(word => lower.includes(word)),
    liveChat: chatWords.some(word => lower.includes(word)),
    aiChatbot: aiWords.some(word => lower.includes(word)),
    facebook: social.facebook,
    instagram: social.instagram,
    linkedin: social.linkedin,
    publicSocialPages: [social.facebook].filter(Boolean),
    publicSocialPagesScanned: 0,
    businessHours: /hours|mon(day)?|tue(sday)?|wed(nesday)?|thu(rsday)?|fri(day)?|sat(urday)?|sun(day)?/i.test(html),
    emergencyService: /24\/7|24 hour|emergency|same day|after[-\s]?hours/i.test(html),
    financing: /financing|finance options|payment plan|monthly payment/i.test(html),
    freeEstimate: /free estimate|free quote|request.*quote|get.*estimate/i.test(html),
    serviceAreaMessaging: /service area|serving|proudly serving|nearby|surrounding areas/i.test(html),
    careersHiring: /careers|we.re hiring|join our team|now hiring|technician jobs/i.test(html),
    noOnlineBooking: !bookingWords.some(word => lower.includes(word)),
    noChatDetected: !chatWords.some(word => lower.includes(word)) && !aiWords.some(word => lower.includes(word))
  };
}

async function scanPublicFacebookPages(links) {
  const publicPages = unique(links.filter(isPublicFacebookLink)).slice(0, 3);
  if (!publicPages.length) return [];
  const probeUrls = unique(publicPages.flatMap(facebookProbeUrls)).slice(0, 6);
  const results = await Promise.allSettled(probeUrls.map(async link => {
    const html = await textFetch(link, {
      signal: AbortSignal.timeout(6500),
      headers: {
        "Accept-Language": "en-US,en;q=0.9"
      }
    });
    const scan = detect(html, extractLinks(html, link));
    return {
      ...scan,
      publicSocialPages: publicPages,
      publicSocialPagesScanned: 1
    };
  }));
  return results
    .filter(result => result.status === "fulfilled")
    .map(result => result.value);
}

function websiteQualityScore(scan) {
  if (!scan.ok) return 15;
  let score = 35;
  if (scan.emails.length) score += 10;
  if (scan.phones.length) score += 10;
  if (scan.contactForms) score += 10;
  if (scan.bookingSoftware.length) score += 10;
  if (scan.liveChat || scan.aiChatbot) score += 8;
  if (scan.facebook || scan.instagram || scan.linkedin) score += 8;
  if (scan.businessHours) score += 5;
  if (scan.financing) score += 4;
  if (scan.trustSignals && scan.trustSignals.length) score += 4;
  if (scan.serviceKeywords && scan.serviceKeywords.length) score += 3;
  if (scan.weakSignals && scan.weakSignals.length) score -= 8;
  return Math.max(0, Math.min(100, score));
}

async function scanWebsite(rawUrl) {
  const url = normalizeUrl(rawUrl);
  if (!url) {
    return {
      ok: false,
      url: "",
      error: "No website available",
      emails: [],
      phones: [],
      websiteQualityScore: 0
    };
  }

  try {
    const html = await textFetch(url, { signal: AbortSignal.timeout(10000) });
    const links = extractLinks(html, url);
    const contactLinks = commonProbeLinks(url, links);
    const pageScans = [detect(html, links)];
    const contactPages = await Promise.allSettled(contactLinks.map(async link => {
      const contactHtml = await textFetch(link, { signal: AbortSignal.timeout(8000) });
      return detect(contactHtml, extractLinks(contactHtml, link));
    }));
    contactPages.forEach(result => {
      if (result.status === "fulfilled") pageScans.push(result.value);
    });
    const publicSocialScans = await scanPublicFacebookPages([
      ...links,
      rawUrl
    ].filter(Boolean));
    pageScans.push(...publicSocialScans);
    const signals = mergeSignals(pageScans);
    const score = websiteQualityScore({ ok: true, ...signals });
    return {
      ok: true,
      url,
      scannedPages: pageScans.length,
      ...signals,
      researchDepth: pageScans.length >= 6 ? "deep" : pageScans.length >= 3 ? "standard" : "basic",
      leadQualitySignals: [
        ...signals.serviceKeywords.map(item => `service: ${item}`),
        ...signals.trustSignals.map(item => `trust: ${item}`),
        ...signals.weakSignals.map(item => `weakness: ${item}`),
        signals.freeEstimate ? "free estimate messaging" : "",
        signals.serviceAreaMessaging ? "service area messaging" : "",
        signals.careersHiring ? "hiring/growth signal" : ""
      ].filter(Boolean).slice(0, 20),
      websiteQualityScore: score,
      digitalPresenceScore: Math.min(100, score + (signals.facebook ? 4 : 0) + (signals.instagram ? 4 : 0) + (signals.linkedin ? 4 : 0))
    };
  } catch (error) {
    return {
      ok: false,
      url,
      error: error.message,
      emails: [],
      phones: [],
      contactForms: false,
      bookingSoftware: [],
      liveChat: false,
      aiChatbot: false,
      businessHours: false,
      emergencyService: false,
      financing: false,
      noOnlineBooking: true,
      noChatDetected: true,
      websiteQualityScore: 10,
      digitalPresenceScore: 10
    };
  }
}

module.exports = { scanWebsite, normalizeUrl };
