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

function mergeSignals(scans) {
  const merged = {
    emails: [],
    phones: [],
    contactForms: false,
    bookingSoftware: [],
    liveChat: false,
    aiChatbot: false,
    facebook: "",
    instagram: "",
    linkedin: "",
    businessHours: false,
    emergencyService: false,
    financing: false,
    noOnlineBooking: true,
    noChatDetected: true
  };

  for (const scan of scans) {
    merged.emails.push(...(scan.emails || []));
    merged.phones.push(...(scan.phones || []));
    merged.bookingSoftware.push(...(scan.bookingSoftware || []));
    merged.contactForms = merged.contactForms || scan.contactForms;
    merged.liveChat = merged.liveChat || scan.liveChat;
    merged.aiChatbot = merged.aiChatbot || scan.aiChatbot;
    merged.facebook = merged.facebook || scan.facebook;
    merged.instagram = merged.instagram || scan.instagram;
    merged.linkedin = merged.linkedin || scan.linkedin;
    merged.businessHours = merged.businessHours || scan.businessHours;
    merged.emergencyService = merged.emergencyService || scan.emergencyService;
    merged.financing = merged.financing || scan.financing;
    merged.noOnlineBooking = merged.noOnlineBooking && scan.noOnlineBooking;
    merged.noChatDetected = merged.noChatDetected && scan.noChatDetected;
  }

  merged.emails = unique(merged.emails).slice(0, 12);
  merged.phones = unique(merged.phones).slice(0, 12);
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

function detect(html, links) {
  const lower = html.toLowerCase();
  const emailMatches = html.match(/[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/gi) || [];
  const phoneMatches = html.match(/(?:\+?1[\s.-]?)?\(?\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}/g) || [];
  const social = {
    facebook: links.find(link => link.includes("facebook.com")) || "",
    instagram: links.find(link => link.includes("instagram.com")) || "",
    linkedin: links.find(link => link.includes("linkedin.com")) || ""
  };
  const bookingWords = ["book online", "schedule online", "request appointment", "calendly", "acuityscheduling", "jobber", "housecall pro", "servicetitan", "fieldedge"];
  const chatWords = ["live chat", "intercom", "drift.com", "tawk.to", "crisp.chat", "zendesk chat", "chatbot"];
  const aiWords = ["ai chatbot", "virtual assistant", "automated assistant"];

  return {
    emails: unique(emailMatches).slice(0, 8),
    phones: unique(phoneMatches).slice(0, 8),
    contactForms: /<form[\s>]/i.test(html) || links.some(link => /contact|estimate|quote/i.test(link)),
    bookingSoftware: bookingWords.filter(word => lower.includes(word)),
    liveChat: chatWords.some(word => lower.includes(word)),
    aiChatbot: aiWords.some(word => lower.includes(word)),
    facebook: social.facebook,
    instagram: social.instagram,
    linkedin: social.linkedin,
    businessHours: /hours|mon(day)?|tue(sday)?|wed(nesday)?|thu(rsday)?|fri(day)?|sat(urday)?|sun(day)?/i.test(html),
    emergencyService: /24\/7|24 hour|emergency|same day|after[-\s]?hours/i.test(html),
    financing: /financing|finance options|payment plan|monthly payment/i.test(html),
    noOnlineBooking: !bookingWords.some(word => lower.includes(word)),
    noChatDetected: !chatWords.some(word => lower.includes(word)) && !aiWords.some(word => lower.includes(word))
  };
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
    const contactLinks = links
      .filter(link => /contact|quote|estimate|appointment|schedule|booking|get-started|service/i.test(link))
      .filter(link => {
        try {
          const parsed = new URL(link);
          return /^https?:$/i.test(parsed.protocol) && parsed.hostname === new URL(url).hostname;
        } catch {
          return false;
        }
      })
      .slice(0, 5);
    const pageScans = [detect(html, links)];
    const contactPages = await Promise.allSettled(contactLinks.map(async link => {
      const contactHtml = await textFetch(link, { signal: AbortSignal.timeout(8000) });
      return detect(contactHtml, extractLinks(contactHtml, link));
    }));
    contactPages.forEach(result => {
      if (result.status === "fulfilled") pageScans.push(result.value);
    });
    const signals = mergeSignals(pageScans);
    const score = websiteQualityScore({ ok: true, ...signals });
    return {
      ok: true,
      url,
      scannedPages: pageScans.length,
      ...signals,
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
