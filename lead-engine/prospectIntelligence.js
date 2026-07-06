function clamp(value) {
  return Math.max(0, Math.min(100, Math.round(value)));
}

function tradeValue(trade) {
  const values = {
    HVAC: 850,
    Plumbing: 625,
    Electrical: 650,
    Roofing: 3500,
    "Garage Doors": 475,
    Landscaping: 550,
    "Pest Control": 275,
    Cleaning: 220,
    Painting: 1800,
    Locksmith: 225,
    "Appliance Repair": 325,
    "Tree Service": 1400,
    Flooring: 2800,
    Solar: 12000,
    "Pool Services": 500,
    "Junk Removal": 350
  };
  return values[trade] || 600;
}

function emergencyTrade(trade) {
  return ["HVAC", "Plumbing", "Electrical", "Garage Doors", "Locksmith", "Appliance Repair", "Tree Service", "Pest Control"].includes(trade);
}

function buildInsights(lead, scan = {}) {
  const insights = [];
  if (!lead.website) insights.push("No website listed in public data");
  if (scan.ok === false && lead.website) insights.push("Website could not be scanned");
  if (scan.websiteQualityScore && scan.websiteQualityScore < 45) insights.push("Website appears weak or incomplete");
  if (scan.noOnlineBooking) insights.push("No online booking detected");
  if (scan.noChatDetected) insights.push("No live chat or AI chatbot detected");
  if (!lead.email && !(scan.emails || []).length) insights.push("No public email detected");
  if (lead.reviews && lead.reviews < 40) insights.push("Small review count");
  if (scan.emergencyService || emergencyTrade(lead.trade)) insights.push("Emergency or urgent-service category");
  if (scan.emergencyService) insights.push("Emergency service messaging detected");
  if (scan.financing) insights.push("Financing language detected");
  if (scan.freeEstimate) insights.push("Free estimate or quote messaging detected");
  if (scan.serviceAreaMessaging) insights.push("Service area messaging detected");
  if (scan.careersHiring) insights.push("Hiring or growth signal detected");
  if (scan.publicSocialPagesScanned) insights.push("Public social contact page checked");
  if ((scan.trustSignals || []).length) insights.push(`Trust signals found: ${(scan.trustSignals || []).slice(0, 3).join(", ")}`);
  if ((scan.weakSignals || []).length) insights.push(`Website weakness signals found: ${(scan.weakSignals || []).slice(0, 3).join(", ")}`);
  if (!scan.businessHours) insights.push("Business hours not clearly detected");
  return insights;
}

function recommendedAngle(lead, insights) {
  if (insights.some(item => item.includes("Emergency")) || emergencyTrade(lead.trade)) {
    return "Lead with missed emergency calls: customers with urgent needs often call the next company within minutes.";
  }
  if (insights.some(item => item.includes("No online booking"))) {
    return "Lead with instant text-back as the simplest conversion upgrade before investing in a full booking system.";
  }
  if (insights.some(item => item.includes("weak"))) {
    return "Lead with customer experience: CallCatch gives them a modern response layer even if the website is outdated.";
  }
  return "Lead with revenue recovery: show how a few recovered missed callers can pay for CallCatch quickly.";
}

function weaknessProfile(lead = {}) {
  const insights = lead.aiInsights || [];
  const scan = lead.websiteIntelligence || {};
  const hasInsight = text => insights.some(item => String(item).toLowerCase().includes(text));
  const weakWebsite = hasInsight("weak") || hasInsight("outdated") || Number(lead.websiteQualityScore || scan.websiteQualityScore || 50) < 45;

  if (hasInsight("emergency") || scan.emergencyService || emergencyTrade(lead.trade)) {
    return {
      weakness: "missed emergency calls",
      pain: "urgent customers usually call the next company if nobody responds right away",
      hook: "missed emergency jobs are often won or lost in the first few minutes",
      proof: "CallCatch instantly texts missed callers so they stay engaged instead of moving on"
    };
  }
  if (scan.noOnlineBooking || hasInsight("no online booking")) {
    return {
      weakness: "no booking button",
      pain: "website visitors and missed callers have to wait for a callback before taking action",
      hook: "the fastest conversion upgrade may be instant text-back before a full booking rebuild",
      proof: "CallCatch gives every missed caller an immediate next step and keeps the conversation open"
    };
  }
  if (weakWebsite) {
    return {
      weakness: "slow or outdated website",
      pain: "prospects may lose confidence before they ever speak with the company",
      hook: "a modern response layer can recover trust even before a website redesign",
      proof: "CallCatch creates a fast, polished first response whenever a call is missed"
    };
  }
  if (!scan.businessHours || hasInsight("business hours")) {
    return {
      weakness: "after-hours calls",
      pain: "evening and weekend callers often need help before the next business day",
      hook: "after-hours callers can become tomorrow's booked jobs instead of lost opportunities",
      proof: "CallCatch replies instantly after hours and captures the customer's need for follow-up"
    };
  }
  if ((lead.reviews && lead.reviews < 40) || hasInsight("small review count")) {
    return {
      weakness: "small team",
      pain: "small teams are usually in the field and cannot answer every sales call live",
      hook: "a small team can look instantly responsive without hiring another dispatcher",
      proof: "CallCatch handles the first missed-call response while the team keeps working"
    };
  }
  return {
    weakness: "missed calls",
    pain: "new customers rarely wait long when another provider is one search away",
    hook: "a few recovered callers can make the system pay for itself",
    proof: "CallCatch texts missed callers instantly and routes the next step back into the CRM"
  };
}

function pick(options, seed = "") {
  const text = String(seed || "");
  const score = text.split("").reduce((sum, char) => sum + char.charCodeAt(0), 0) + Math.floor(Math.random() * options.length);
  return options[score % options.length];
}

function businessTeam(lead) {
  return `${lead.business || "your"} team`;
}

function cityState(lead) {
  return [lead.city, lead.state].filter(Boolean).join(", ") || lead.area || "your area";
}

function subjectLine(lead, profile, variant) {
  const subjects = [
    `Quick question for ${lead.business}`,
    `A missed-call idea for ${lead.business}`,
    `Thought this may help ${lead.business}`,
    `Question about your service calls`,
    `One idea for your office team`,
    `A quick thought on missed calls`
  ];
  return pick(subjects, `${lead.id || lead.business}:${profile.weakness}:${variant}:${Date.now()}`);
}

function greeting(lead) {
  return pick([
    `Hi ${businessTeam(lead)},`,
    `Hi there,`,
    `Good morning ${businessTeam(lead)},`,
    `Good afternoon ${businessTeam(lead)},`
  ], `${lead.business}:${Date.now()}`);
}

function realObservation(lead) {
  const city = cityState(lead);
  const scan = lead.websiteIntelligence || {};
  const reviews = Number(lead.reviews || 0);
  const rating = Number(lead.rating || 0);
  if (scan.emergencyService) return `I was looking through your website and noticed you advertise emergency service.`;
  if (scan.financing) return `I was looking through your website and saw that you mention financing options.`;
  if ((scan.bookingSoftware || []).length) return `I noticed online scheduling appears to be available on your site.`;
  if (scan.liveChat || scan.aiChatbot) return `I noticed your website already gives visitors a way to start a conversation quickly.`;
  if ((scan.serviceKeywords || []).some(item => /same day|24|emergency|repair/i.test(item))) return `I noticed your website focuses on urgent service requests.`;
  if (reviews >= 100 && rating) return `I saw that your company has built a strong local reputation with more than ${reviews.toLocaleString()} reviews.`;
  if ((scan.trustSignals || []).length) return `I noticed your site highlights ${scan.trustSignals[0]}, which usually means trust matters in the first customer interaction.`;
  if (scan.noOnlineBooking) return `I was looking through your website and did not see a clear online booking path for urgent requests.`;
  if (lead.website) return `I came across your company while researching ${lead.trade || "home service"} businesses in the ${city} area.`;
  return `I came across your company while researching ${lead.trade || "home service"} businesses in the ${city} area.`;
}

function problemSentence(lead, profile) {
  const scan = lead.websiteIntelligence || {};
  if (scan.emergencyService || emergencyTrade(lead.trade)) {
    return `When someone has an urgent service issue, they rarely wait long or leave a voicemail. Most simply call the next contractor who answers.`;
  }
  if (scan.financing) {
    return `For higher-value jobs, one missed call can quietly turn into a lost opportunity before anyone on the team has a chance to call back.`;
  }
  if (/commercial/i.test([lead.googleDescription, lead.description, lead.notes, lead.area].join(" "))) {
    return `Commercial and homeowner calls can both move fast, especially when the customer is comparing several providers at once.`;
  }
  if (profile.weakness === "small team") {
    return `Busy service companies often lose opportunities simply because technicians are in the field and nobody can answer immediately.`;
  }
  return `The hard part is that callers do not usually wait around anymore. If nobody answers, they often keep searching within minutes.`;
}

function callCatchIntro() {
  return `That is exactly why I built CallCatch. It automatically responds to missed callers by text within seconds, helping keep potential customers engaged until someone can call them back.`;
}

function revenueSentence(lead) {
  const value = Number(lead.revenueOpportunityEstimate || 0);
  if (!value) return `Even a few recovered missed callers each month can make a real difference.`;
  return `Based on businesses similar to yours, recovering just one additional missed ${emergencyTrade(lead.trade) ? "emergency " : ""}call every few days could represent roughly $${value.toLocaleString()} in additional booked work each month.`;
}

function cta(variant) {
  const ctas = [
    `Would you be open to a quick 10-minute demo sometime next week?`,
    `Happy to show you how it works if you are curious.`,
    `If it sounds useful, I would be glad to walk you through it.`,
    `No pressure. I just thought it might be worth sharing.`
  ];
  return pick(ctas, `${variant}:${Date.now()}`);
}

function signature() {
  return `Best,\n\nPrince Esien\nFounder | CallCatch\nhello@callcatch.site\nhttps://callcatch.site\n\nHelping home service businesses recover missed revenue.`;
}

function cleanEmailText(text, lead) {
  let cleaned = String(text || "")
    .replace(/\bFREE\b/gi, "no-cost")
    .replace(/\bLIMITED OFFER\b/gi, "short note")
    .replace(/\bBUY NOW\b/gi, "take a look")
    .replace(/\bACT NOW\b/gi, "take a look")
    .replace(/\bGUARANTEED\b/gi, "designed")
    .replace(/\bBEST EVER\b/gi, "useful")
    .replace(/!{2,}/g, ".")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  const city = cityState(lead);
  const cityPattern = city && city !== "your area" ? new RegExp(city.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "g") : null;
  if (cityPattern) {
    let seen = 0;
    cleaned = cleaned.replace(cityPattern, match => (++seen <= 1 ? match : "your area"));
  }

  const words = cleaned.split(/\s+/);
  if (words.length > 170) {
    const signatureText = signature();
    const body = cleaned.replace(signatureText, "").trim().split(/\s+/).slice(0, Math.max(80, 170 - signatureText.split(/\s+/).length)).join(" ");
    cleaned = `${body}\n\n${signatureText}`;
  }
  return cleaned;
}

function emailBody(lead, variant) {
  const profile = weaknessProfile(lead);
  const observation = realObservation(lead);
  const problem = problemSentence(lead, profile);
  const intro = callCatchIntro();
  const revenue = revenueSentence(lead);
  const subject = subjectLine(lead, profile, variant);
  const parts = [
    `Subject: ${subject}`,
    greeting(lead),
    `${observation} ${problem}`,
    `${intro} ${revenue}`,
    cta(variant),
    signature()
  ];
  return cleanEmailText(parts.join("\n\n"), lead);
}

function estimateRevenue(lead, scan = {}) {
  const baseCalls = emergencyTrade(lead.trade) ? 70 : 42;
  const digitalPenalty = scan.websiteQualityScore ? Math.max(0, 60 - scan.websiteQualityScore) / 3 : 12;
  const missedRate = Math.min(32, 14 + digitalPenalty + (emergencyTrade(lead.trade) ? 5 : 0));
  const closeRate = emergencyTrade(lead.trade) ? 24 : 18;
  const missedMonthly = baseCalls * 4.33 * (missedRate / 100);
  const jobs = missedMonthly * (closeRate / 100);
  const revenue = jobs * tradeValue(lead.trade);
  return {
    averageJobValue: tradeValue(lead.trade),
    estimatedMonthlyMissedCalls: Math.round(missedMonthly),
    estimatedRecoverableJobs: Number(jobs.toFixed(1)),
    revenueOpportunityEstimate: Math.round(revenue)
  };
}

function enrichProspect(lead, scan = {}) {
  const insights = buildInsights(lead, scan);
  const revenue = estimateRevenue(lead, scan);
  const websiteScore = scan.websiteQualityScore ?? (lead.website ? 45 : 10);
  const digitalScore = scan.digitalPresenceScore ?? websiteScore;
  let fit = 42;
  fit += emergencyTrade(lead.trade) ? 15 : 7;
  fit += lead.phone ? 10 : 0;
  fit += lead.website ? 6 : 0;
  fit += websiteScore < 45 ? 10 : 0;
  fit += scan.noOnlineBooking ? 8 : 0;
  fit += scan.noChatDetected ? 5 : 0;
  fit += revenue.revenueOpportunityEstimate > 3000 ? 10 : 0;
  const callCatchFitScore = clamp(fit);
  const opportunityLevel = callCatchFitScore >= 78 ? "High" : callCatchFitScore >= 58 ? "Medium" : "Nurture";
  const responsePriority = callCatchFitScore >= 82 ? "Today" : callCatchFitScore >= 65 ? "This Week" : "Nurture";

  return {
    ...lead,
    ...revenue,
    callCatchFitScore,
    websiteQualityScore: websiteScore,
    digitalPresenceScore: digitalScore,
    aiOpportunityLevel: opportunityLevel,
    responsePriority,
    aiInsights: insights,
    recommendedSalesAngle: recommendedAngle(lead, insights),
    websiteIntelligence: scan
  };
}

function outreachAssets(lead) {
  const profile = weaknessProfile(lead);
  const emailA = emailBody(lead, "A");
  const emailB = emailBody(lead, "B");
  return {
    email: emailA,
    emailA,
    emailB,
    emailVariants: { A: emailA, B: emailB },
    linkedinConnection: `Hi, I work with ${lead.trade || "home-service"} companies on ${profile.weakness}. Thought ${lead.business} might be a fit.`,
    linkedinFirstMessage: `Thanks for connecting. Quick thought for ${lead.business}: ${profile.hook}. CallCatch helps with that through instant missed-call text-back. Open to seeing the 2-minute version?`,
    sms: `Hi, quick idea for ${lead.business}: ${profile.proof}. Useful if ${profile.weakness} is costing jobs. Worth a quick look?`,
    callScript: `Opening: I help ${lead.trade} companies fix ${profile.weakness}.\n\nObservation: ${profile.pain}.\n\nDiscovery: When do you miss the most calls: after hours, on jobs, while driving, or during peak demand?\n\nAngle: ${profile.hook}. ${profile.proof}.\n\nClose: Want me to show what the customer sees after a missed call?`,
    objections: `Already call back: Totally. The problem is timing; many customers move on within minutes.\nToo busy: That is exactly where instant text-back helps a small team look responsive.\nNot sure we miss calls: One recovered urgent job can make the math obvious.`,
    weakness: profile
  };
}

module.exports = { enrichProspect, outreachAssets, weaknessProfile };
