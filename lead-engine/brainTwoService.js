const fs = require("fs");
const path = require("path");

const BRAIN_TWO_VERSION = "brain-two-v1.0";
const RUNTIME_PROMPT = fs.readFileSync(path.join(__dirname, "..", "brains", "brain-two-runtime.md"), "utf8");
const outputSchema = require("../schemas/brain-two-output.json");
const QUALITY_READY_THRESHOLD = 85;
const HUMAN_READY_THRESHOLD = 85;

function nowIso() {
  return new Date().toISOString();
}

function compact(value, max = 600) {
  return String(value || "").replace(/\s+/g, " ").trim().slice(0, max);
}

function uniqueArray(items = []) {
  return [...new Set(items.filter(item => item !== null && item !== undefined && item !== ""))];
}

function clamp(value, min = 0, max = 100) {
  const number = Number(value);
  if (!Number.isFinite(number)) return min;
  return Math.max(min, Math.min(max, Math.round(number)));
}

function flattenBrainOneOutput(value = {}) {
  if (!value.modules) return value || {};
  return {
    ...value,
    ...(value.modules.foundation?.output || {}),
    ...(value.modules.digital_intelligence?.output || {}),
    ...(value.modules.opportunities?.output || {}),
    ...(value.modules.strategic_interpretation?.output || {}),
    ...(value.modules.contact_decision?.output || {})
  };
}

function brainOneCombinedOutput(brainOneRun = {}) {
  return brainOneRun.phaseAOutput || brainOneRun.validatedOutput || {};
}

function brainOneFlatOutput(brainOneRun = {}) {
  return flattenBrainOneOutput(brainOneCombinedOutput(brainOneRun));
}

function evidenceIdList(value = {}) {
  if (!value || typeof value !== "object") return [];
  const found = [];
  const visit = item => {
    if (!item || typeof item !== "object") return;
    if (Array.isArray(item)) {
      item.forEach(visit);
      return;
    }
    if (Array.isArray(item.evidence_ids)) found.push(...item.evidence_ids);
  };
  visit(value);
  return uniqueArray(found);
}

function claimText(item = {}) {
  if (typeof item === "string") return item;
  return compact(item.claim || item.title || item.summary || item.opportunity || item.reasoning || item.value || "");
}

function isManualTestLead(lead = {}) {
  return !!(lead.testProspect || lead.manualTest || lead.outreachDisabled || lead.analysis_mode === "manual_test");
}

function contactPaths(lead = {}, flat = {}) {
  const contacts = Array.isArray(flat.contacts) ? flat.contacts : [];
  const emails = uniqueArray([
    lead.email,
    ...contacts.map(item => item.contact_email)
  ].map(item => compact(item, 160)).filter(item => /@/.test(item)));
  const phones = uniqueArray([
    lead.phone,
    ...contacts.map(item => item.contact_phone)
  ].map(item => compact(item, 80)).filter(Boolean));
  const forms = uniqueArray([
    lead.websiteIntelligence?.contactForm ? "contact form" : "",
    flat.digital_health?.contact_form_detected ? "contact form" : ""
  ].filter(Boolean));
  return { emails, phones, forms, hasUsablePath: !!(emails.length || phones.length || forms.length) };
}

function brainTwoHandoff(flat = {}) {
  return flat.brain_two_handoff || {};
}

function handoffNeedsManualResearch(flat = {}) {
  const handoff = brainTwoHandoff(flat);
  const text = [
    handoff.summary,
    handoff.status,
    handoff.research_status,
    ...(handoff.information_gaps || []),
    ...(flat.contact_decision?.information_gaps || [])
  ].join(" ").toLowerCase();
  return handoff.needs_manual_research === true
    || handoff.manual_research_required === true
    || /manual research|research needed|find contact|verify contact|no verified contact/.test(text);
}

function brainOneDecision(flat = {}) {
  return flat.contact_decision?.decision || flat.contact_decision?.recommendation_status || "";
}

function approvedBrainOne(brainOneRun = {}) {
  return /^approved/i.test(brainOneRun.approvalStatus || "");
}

function evaluateBrainTwoEligibility({ lead = {}, brainOneRun = {} } = {}) {
  brainOneRun = brainOneRun || {};
  const reasons = [];
  if (!brainOneRun || !brainOneRun.id) reasons.push("Brain One has not run.");
  if (brainOneRun.id && brainOneRun.executionStatus !== "completed") reasons.push("Brain One has not completed.");
  if (brainOneRun.id && !approvedBrainOne(brainOneRun)) reasons.push("Brain One has not been manually approved.");
  if (isManualTestLead(lead)) reasons.push("Lead is still in Manual Test mode.");

  const flat = brainOneFlatOutput(brainOneRun);
  const decision = brainOneDecision(flat);
  if (decision === "DO NOT CONTACT") reasons.push("Brain One decision is DO NOT CONTACT.");

  const paths = contactPaths(lead, flat);
  const manualResearchRequired = handoffNeedsManualResearch(flat);
  if (!paths.hasUsablePath && !manualResearchRequired) {
    reasons.push("No usable outreach path is available.");
  }

  const blocked = reasons.length > 0;
  return {
    eligible: !blocked,
    status: blocked ? "blocked" : manualResearchRequired && !paths.hasUsablePath ? "needs_review" : "eligible",
    reasons,
    brain_one_run_id: brainOneRun.id || "",
    manual_research_required: manualResearchRequired && !paths.hasUsablePath,
    contact_paths: paths
  };
}

function primaryEvidence(flat = {}) {
  return uniqueArray([
    ...evidenceIdList(flat.business_dna || {}),
    ...evidenceIdList(flat.hidden_opportunities || []),
    ...evidenceIdList(flat.ai_opportunity_radar || {}),
    ...evidenceIdList(flat.why_we_chose_you || {}),
    ...evidenceIdList(flat.one_day_action_plan || {}),
    ...evidenceIdList(flat.contact_decision || {})
  ]).slice(0, 12);
}

function choosePersona(lead = {}, flat = {}) {
  const trade = compact(lead.trade || (flat.business_dna?.primary_services || [])[0] || "").toLowerCase();
  const evidence = primaryEvidence(flat);
  const personas = [];
  const push = (persona, reasoning, confidence = "medium") => personas.push({ persona, rank: personas.length + 1, reasoning, confidence, evidence_ids: evidence.slice(0, 5) });
  if (/hvac|plumb|electric|roof|garage|locksmith|pest|landscap|clean|painting|appliance|tree|floor|solar|pool|junk/.test(trade)) {
    push("Owner or General Manager", "Home service buying decisions are usually owned by the operator or manager responsible for calls, dispatch, and revenue.", "medium");
    push("Office Manager or Dispatcher", "This persona is close to missed calls, booking friction, and follow-up speed.", "medium");
    push("Marketing Manager", "This persona may care about converting more inbound demand into booked jobs.", "low");
  } else {
    push("Revenue Operations or Growth Lead", "The strongest available evidence points to conversion, customer journey, or operational workflow improvements.", "medium");
    push("Operations Lead", "This persona is likely responsible for response workflows and customer handoff quality.", "medium");
    push("Founder or Business Owner", "Founder-level outreach is appropriate when the business appears smaller or when no specific department is verified.", "low");
  }
  return personas;
}

function selectedOpportunity(flat = {}) {
  const opportunities = Array.isArray(flat.hidden_opportunities) ? flat.hidden_opportunities : [];
  const sorted = [...opportunities].sort((a, b) => (Number(b.opportunity_priority_score) || 0) - (Number(a.opportunity_priority_score) || 0));
  return sorted[0] || null;
}

function chooseOffer(lead = {}, flat = {}) {
  const evidence = primaryEvidence(flat);
  const opportunity = selectedOpportunity(flat);
  const text = [
    opportunity?.title,
    opportunity?.specific_observed_problem,
    opportunity?.why_it_matters,
    flat.business_dna?.customer_journey,
    flat.digital_health?.summary,
    flat.ai_opportunity_radar?.conversion?.opportunity
  ].join(" ").toLowerCase();
  if (/after.?hours|missed call|emergency|urgent|voicemail|call/.test(text)) {
    return {
      name: "Missed Call Text-Back",
      description: "CallCatch can respond to missed callers by text so the prospect stays engaged until the team can call back.",
      reasoning: "The approved Brain One report points to response speed, calls, urgency, or customer journey friction.",
      evidence_ids: evidence.slice(0, 6)
    };
  }
  if (/booking|schedule|form|conversion|contact/.test(text)) {
    return {
      name: "Lead Response and Booking Recovery",
      description: "CallCatch can help keep inbound prospects engaged when the first contact attempt is missed.",
      reasoning: "The approved Brain One report points to conversion or booking-path friction.",
      evidence_ids: evidence.slice(0, 6)
    };
  }
  return {
    name: "Inbound Response Safety Net",
    description: "CallCatch helps reduce the risk of losing inbound prospects when a team cannot respond immediately.",
    reasoning: "The approved Brain One report supports a conservative response-speed angle without inventing specific losses.",
    evidence_ids: evidence.slice(0, 6)
  };
}

function chooseAngle(lead = {}, flat = {}) {
  const opportunity = selectedOpportunity(flat);
  const evidence = evidenceIdList(opportunity || {}).length ? evidenceIdList(opportunity) : primaryEvidence(flat);
  if (opportunity) {
    return {
      angle: compact(opportunity.title || opportunity.opportunity || "Improve inbound response quality", 180),
      reasoning: compact(opportunity.why_it_matters || opportunity.specific_observed_problem || "Selected from the highest-priority Brain One opportunity.", 300),
      claim_type: evidence.length ? "evidence_backed" : "soft_hypothesis",
      evidence_ids: evidence.slice(0, 8)
    };
  }
  return {
    angle: "Improve inbound response quality",
    reasoning: "Brain One did not validate a specific hidden opportunity, so Brain Two uses a soft, conservative response-speed angle.",
    claim_type: "soft_hypothesis",
    evidence_ids: primaryEvidence(flat).slice(0, 8)
  };
}

function businessName(lead = {}, flat = {}) {
  return compact(lead.business || flat.business_identity?.business_name || flat.business_identity?.name || "your team", 120);
}

function shortGreeting(name) {
  return name && name !== "your team" ? `Hi ${name} team,` : "Hi there,";
}

function wordCount(value = "") {
  return compact(value, 4000).split(/\s+/).filter(Boolean).length;
}

function sentenceCount(value = "") {
  return String(value || "").split(/[.!?]+/).map(item => item.trim()).filter(Boolean).length;
}

function syllableCount(word = "") {
  const cleaned = String(word || "").toLowerCase().replace(/[^a-z]/g, "");
  if (!cleaned) return 0;
  const groups = cleaned.replace(/e$/, "").match(/[aeiouy]+/g);
  return Math.max(1, groups ? groups.length : 1);
}

function readingLevel(value = "") {
  const words = compact(value, 4000).split(/\s+/).filter(Boolean);
  const sentences = Math.max(1, sentenceCount(value));
  const syllables = words.reduce((sum, word) => sum + syllableCount(word), 0);
  const grade = 0.39 * (words.length / sentences) + 11.8 * (syllables / Math.max(1, words.length)) - 15.59;
  return Math.max(1, Math.round(grade * 10) / 10);
}

function stableIndex(seed = "", length = 1) {
  if (length <= 1) return 0;
  let hash = 2166136261;
  for (const char of String(seed || "")) {
    hash ^= char.charCodeAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0) % length;
}

function evidenceTextEntries(flat = {}) {
  const evidenceLog = Array.isArray(flat.evidence_log) ? flat.evidence_log : [];
  const facts = Array.isArray(flat.confirmed_facts) ? flat.confirmed_facts : [];
  return [
    ...evidenceLog.map(item => ({
      text: compact(item.excerpt || item.summary || item.title || item.value || "", 220),
      evidence_ids: item.id ? [item.id] : [],
      source_type: item.source_type || "",
      source_url: item.source_url || ""
    })),
    ...facts.map(item => ({
      text: compact(item.claim || item.summary || "", 220),
      evidence_ids: Array.isArray(item.evidence_ids) ? item.evidence_ids : [],
      source_type: "confirmed_fact",
      source_url: ""
    }))
  ].filter(item => item.text);
}

function observationFromText(entry = {}, lead = {}, flat = {}) {
  const text = compact(entry.text, 220);
  const lower = text.toLowerCase();
  const service = compact((flat.business_dna?.primary_services || [])[0] || lead.trade || "service", 60);
  if (/24\/7|24-7|after.?hours|emergency|urgent/.test(lower)) {
    return { sentence: `I noticed your website mentions emergency service.`, evidence_ids: entry.evidence_ids || [] };
  }
  if (/book|booking|schedule|appointment|contact form|form/.test(lower)) {
    return { sentence: `I noticed your website points people toward a booking or contact form.`, evidence_ids: entry.evidence_ids || [] };
  }
  if (/financ|payment plan|monthly payment/.test(lower)) {
    return { sentence: `I saw that your website mentions financing options.`, evidence_ids: entry.evidence_ids || [] };
  }
  if (/commercial|business|facility|property manager/.test(lower)) {
    return { sentence: `I noticed your website speaks to commercial customers.`, evidence_ids: entry.evidence_ids || [] };
  }
  if (/review|testimonial|rated|stars|trusted/.test(lower)) {
    return { sentence: `I noticed your website leans on customer trust signals.`, evidence_ids: entry.evidence_ids || [] };
  }
  if (service) {
    return { sentence: `I was looking through your website and saw the focus on ${service}.`, evidence_ids: entry.evidence_ids || [] };
  }
  return { sentence: `I was looking through your website and noticed the service details you share for customers.`, evidence_ids: entry.evidence_ids || [] };
}

function websiteObservation(lead = {}, flat = {}) {
  const entries = evidenceTextEntries(flat);
  const websiteEntry = entries.find(item => /website|official|page/i.test(item.source_type || "") || /^https?:\/\//i.test(item.source_url || ""));
  const entry = websiteEntry || entries[0];
  if (entry) return observationFromText(entry, lead, flat);
  const service = compact((flat.business_dna?.primary_services || [])[0] || lead.trade || "", 60);
  return {
    sentence: service
      ? `I was looking through the approved research and saw the focus on ${service}.`
      : "I was looking through the approved research on your business.",
    evidence_ids: primaryEvidence(flat).slice(0, 2)
  };
}

function revenueLine(flat = {}) {
  const money = flat.money_left_on_table || {};
  if (money.status !== "estimated") return "";
  const low = Number(money.low_estimate);
  const high = Number(money.high_estimate);
  if (!Number.isFinite(low) || !Number.isFinite(high) || low <= 0 || high <= 0) return "";
  const currency = money.currency || "$";
  const period = money.time_period ? ` per ${money.time_period}` : "";
  return `Based on the approved estimate, improving response may be worth roughly ${currency}${Math.round(low).toLocaleString()}-${currency}${Math.round(high).toLocaleString()}${period}, depending on the assumptions.`;
}

function naturalSubjectLines(name, style = "A") {
  const pool = [
    "Quick question",
    "Noticed something",
    "Question about your website",
    "Idea for your team",
    "One thing I noticed",
    "Small idea",
    "Worth a look?",
    name && name !== "your team" ? `Question for ${name}` : "Question for your team"
  ];
  const offset = stableIndex(`${name}|${style}|subjects`, pool.length);
  return uniqueArray([...pool.slice(offset), ...pool.slice(0, offset)]).slice(0, 5);
}

function softCta(seed = "") {
  const options = [
    "Worth a quick look?",
    "Happy to show you.",
    "If useful, I can send a short demo.",
    "I can show what I mean."
  ];
  return options[stableIndex(seed, options.length)];
}

function followUpSubjectOptions(stage = 1, name = "your team", seed = "") {
  const pools = {
    1: ["Question about emergency calls", "Small observation", "Quick thought", "Customer expectations", "After-hours calls", "One useful idea"],
    2: ["One observation", "Question about your website", "Response time", "Small gap", "Idea for your team", "Call flow"],
    3: ["One ROI thought", "Missed-call math", "Revenue leakage", "Worth considering", "Small numbers", "Response value"],
    4: ["I'll leave this here", "Closing the loop", "For later", "No pressure", "Keeping this simple", "Last note"]
  };
  const pool = pools[stage] || pools[1];
  const offset = stableIndex(`${name}|${stage}|${seed}`, pool.length);
  return uniqueArray([...pool.slice(offset), ...pool.slice(0, offset)]).slice(0, 5);
}

function followUpFounderStyle(seed = "") {
  const styles = ["Curious", "Helpful", "Technical", "Business owner"];
  return styles[stableIndex(seed, styles.length)];
}

function followUpObservationPool(flat = {}, observation = {}) {
  const opportunity = selectedOpportunity(flat) || {};
  const digital = flat.digital_health || {};
  const dna = flat.business_dna || {};
  const radar = flat.ai_opportunity_radar || {};
  const entries = [
    {
      key: "after-hours calls",
      sentence: "After-hours calls are tricky because the buyer usually has a problem now, not tomorrow.",
      evidence_ids: evidenceIdList(opportunity).length ? evidenceIdList(opportunity) : observation.evidence_ids
    },
    {
      key: "customer expectations",
      sentence: "One thing customers have changed is how little patience they have for waiting after the first call.",
      evidence_ids: evidenceIdList(dna).length ? evidenceIdList(dna) : observation.evidence_ids
    },
    {
      key: "contact friction",
      sentence: "Your site gives people a path to reach you, but the fragile part is what happens when nobody can answer right away.",
      evidence_ids: evidenceIdList(digital).length ? evidenceIdList(digital) : observation.evidence_ids
    },
    {
      key: "lead leakage",
      sentence: "The leak is usually quiet: the customer never says they called someone else.",
      evidence_ids: evidenceIdList(radar).length ? evidenceIdList(radar) : observation.evidence_ids
    },
    {
      key: "emergency services",
      sentence: "Emergency work is different because speed often matters as much as the service itself.",
      evidence_ids: evidenceIdList(opportunity).length ? evidenceIdList(opportunity) : observation.evidence_ids
    }
  ];
  return entries.filter(item => item.key && item.sentence);
}

function roiFollowUpLine(flat = {}) {
  const money = flat.money_left_on_table || {};
  if (money.status !== "estimated") {
    return "I would not attach a number without stronger evidence, but the business case is simple: one recovered job can make the response system worth reviewing.";
  }
  const low = Number(money.low_estimate);
  const high = Number(money.high_estimate);
  if (!Number.isFinite(low) || !Number.isFinite(high) || low <= 0 || high <= 0) {
    return "I would not attach a number without stronger evidence, but the business case is simple: one recovered job can make the response system worth reviewing.";
  }
  const currency = money.currency || "$";
  const period = compact(money.time_period || "month", 40);
  return `Brain One's estimate suggests the missed-response gap may be worth roughly ${currency}${Math.round(low).toLocaleString()}-${currency}${Math.round(high).toLocaleString()} per ${period}, depending on the assumptions.`;
}

function followUpCta(stage = 1) {
  return {
    1: "Thought this might be useful.",
    2: "I can show what I mean.",
    3: "Worth a quick look?",
    4: "If it matters later, I'm happy to help."
  }[stage] || "Happy to show you.";
}

function followUpBody({ stage, name, newIdea, cta, flat }) {
  const greeting = shortGreeting(name);
  if (stage === 1) {
    return [
      greeting,
      "",
      newIdea.sentence,
      "",
      "A fast text reply can buy a little time while the team is busy. It does not need to sell anything; it just tells the caller someone saw them.",
      "",
      cta,
      "",
      founderSignature(false)
    ].join("\n");
  }
  if (stage === 2) {
    return [
      greeting,
      "",
      newIdea.sentence,
      "",
      "That is the kind of small handoff CallCatch is built for. Not a big system change, more like a safety net around the first missed moment.",
      "",
      cta,
      "",
      founderSignature(false)
    ].join("\n");
  }
  if (stage === 3) {
    return [
      greeting,
      "",
      roiFollowUpLine(flat),
      "",
      "I think about it less as software cost and more as whether one extra booked job covers the effort.",
      "",
      cta,
      "",
      founderSignature(false)
    ].join("\n");
  }
  return [
    greeting,
    "",
    "I'll leave this here for now.",
    "",
    "If improving missed-call recovery becomes important later, I'm happy to help. No pressure either way.",
    "",
    cta,
    "",
    founderSignature(false)
  ].join("\n");
}

function buildFollowUpStateMachine({ lead = {}, flat = {}, name, observation, angle, offer, runId = "" } = {}) {
  const ideas = followUpObservationPool(flat, observation);
  const usedSubjects = new Set();
  const usedCtas = new Set();
  const usedIdeas = new Set();
  const stages = [
    { step: 1, stage: 1, stage_name: "Education", delay: 3 },
    { step: 2, stage: 2, stage_name: "Business insight", delay: 7 },
    { step: 3, stage: 3, stage_name: "ROI", delay: 10 },
    { step: 4, stage: 4, stage_name: "Permission close", delay: 14 }
  ];
  return stages.map(stage => {
    const seed = `${lead.id || name}|${runId}|${stage.stage}`;
    const subjectOptions = followUpSubjectOptions(stage.stage, name, seed);
    const subject = subjectOptions.find(item => !usedSubjects.has(item)) || `${stage.stage_name} note`;
    usedSubjects.add(subject);
    const style = followUpFounderStyle(seed);
    const newIdea = stage.stage === 3
      ? { key: "roi", sentence: roiFollowUpLine(flat), evidence_ids: evidenceIdList(flat.money_left_on_table || {}) }
      : stage.stage === 4
        ? { key: "permission close", sentence: "Permission close", evidence_ids: [] }
        : (ideas.find(item => !usedIdeas.has(item.key)) || ideas[0] || { key: stage.stage_name, sentence: "A fast response can protect a good customer conversation.", evidence_ids: [] });
    usedIdeas.add(newIdea.key);
    const cta = followUpCta(stage.stage);
    usedCtas.add(cta);
    const body = followUpBody({ stage: stage.stage, name, newIdea, cta, flat });
    return {
      step: stage.step,
      stage: stage.stage,
      stage_name: stage.stage_name,
      founder_style: style,
      recommended_delay_days: stage.delay,
      subject,
      subject_options: subjectOptions,
      body,
      new_idea: newIdea.key,
      cta,
      evidence_ids: uniqueArray([...angle.evidence_ids, ...offer.evidence_ids, ...(newIdea.evidence_ids || [])]).slice(0, 8),
      claims: [stage.stage_name, newIdea.key, offer.name]
    };
  });
}

function founderSignature(long = true) {
  return long
    ? ["Best,", "Prince Esien", "Founder | CallCatch", "hello@callcatch.site", "https://callcatch.site"].join("\n")
    : ["Best,", "Prince"].join("\n");
}

function styleEmail({ style, name, observation, offer, angle, cta, revenue = "" }) {
  const greeting = shortGreeting(name);
  const problem = angle.claim_type === "evidence_backed"
    ? "When someone reaches out and nobody can respond right away, that moment can decide whether they wait or call someone else."
    : "For service teams, the small gap is often the calls that arrive while everyone is already busy.";
  const intro = "That is why I built CallCatch. It texts missed callers within seconds, so they know someone saw them and your team can follow up when free.";
  const valueLine = revenue || "I am not assuming this is a big issue, but it looked like the kind of small gap worth protecting.";
  if (style === "B") {
    return [
      greeting,
      "",
      observation.sentence,
      "",
      `${problem} ${valueLine}`,
      "",
      intro,
      "",
      cta,
      "",
      founderSignature()
    ].join("\n").replace(/\n{3,}/g, "\n\n");
  }
  if (style === "C") {
    return [
      greeting,
      "",
      `${observation.sentence} It made me wonder what happens when the team is tied up and a good call slips through.`,
      "",
      "Most people with an urgent issue do not wait long or leave a voicemail. They usually call the next company that answers.",
      "",
      `${intro} ${valueLine}`,
      "",
      cta,
      "",
      founderSignature()
    ].join("\n");
  }
  return [
    greeting,
    "",
    observation.sentence,
    "",
    "I built CallCatch for one simple reason: missed callers often move on before a busy team can call back.",
    "",
    `${offer.description} ${valueLine}`,
    "",
    cta,
    "",
    founderSignature()
  ].join("\n");
}

function restrictedLanguageHits(value = "") {
  const lower = String(value || "").toLowerCase();
  return [
    "just checking in",
    "following up",
    "circle back",
    "touching base",
    "revolutionary",
    "game changing",
    "best in class",
    "industry leading",
    "ai powered",
    "next generation",
    "cutting edge",
    "state of the art"
  ].filter(item => lower.includes(item));
}

function spamRisk({ bannedHits = [], word_count = 0, pressureCta = false } = {}) {
  if (bannedHits.length >= 2 || pressureCta || word_count > 170) return "High";
  if (bannedHits.length || word_count > 120) return "Medium";
  return "Low";
}

function repeatedPhrasePenalty(body = "") {
  const sentences = String(body || "").toLowerCase().split(/[.!?]+/).map(item => item.replace(/[^a-z0-9 ]/g, "").trim()).filter(item => item.length > 12);
  return sentences.length - new Set(sentences).size;
}

function observationCount(body = "") {
  return (String(body || "").match(/\b(I noticed|I saw|I was looking through|I came across)\b/g) || []).length;
}

function ctaCount(body = "") {
  return (String(body || "").match(/worth a quick look|happy to show you|short demo|show what i mean|if useful/i) || []).length;
}

function evaluateEmailQualityGate({ body = "", subject = "", observation = {}, evidenceIds = [], claims = [], cta = "", purpose = "first_email", minWords = 90, maxWords = 120 } = {}) {
  const wc = wordCount(body);
  const grade = readingLevel(body);
  const bannedHits = restrictedLanguageHits(`${subject}\n${body}`);
  const hasObservation = !!(observation.sentence && body.includes(observation.sentence));
  const oneObservation = purpose !== "first_email" || observationCount(body) === 1;
  const oneCta = cta ? body.includes(cta) && ctaCount(body) <= 1 : ctaCount(body) <= 1;
  const pressureCta = /book a meeting|schedule a call|hop on zoom|act now|limited offer|buy now|guaranteed/i.test(body);
  const paragraphs = String(body || "").split(/\n{2,}/).filter(Boolean);
  const shortParagraphs = paragraphs.every(paragraph => sentenceCount(paragraph) <= 3 && wordCount(paragraph) <= 45);
  const repeatedPenalty = repeatedPhrasePenalty(body);
  const underLimit = wc <= maxWords;
  const overMinimum = wc >= minWords;
  const readable = grade >= 4 && grade <= 9;
  const problemCount = (String(body || "").match(/missed callers|missed call|nobody can respond|call someone else|slips through|move on|voicemail/i) || []).length;
  const hasProblem = problemCount >= 1;
  const scoreFrom = base => clamp(
    base
    + (hasObservation || purpose !== "first_email" ? 10 : -18)
    + (oneObservation ? 8 : -18)
    + (hasProblem ? 8 : -10)
    + (oneCta ? 8 : -12)
    + (shortParagraphs ? 8 : -10)
    + (underLimit ? 8 : -14)
    + (overMinimum ? 4 : -14)
    + (readable ? 8 : -6)
    - bannedHits.length * 12
    - repeatedPenalty * 8
    - (pressureCta ? 20 : 0)
  );
  const quality_score = scoreFrom(44);
  const human_score = scoreFrom(46);
  const confidence_score = clamp(55 + Math.min(20, (evidenceIds || []).length * 4) + Math.min(10, (claims || []).length * 2) + (hasObservation ? 10 : 0) - bannedHits.length * 10);
  const ready = quality_score >= QUALITY_READY_THRESHOLD && human_score >= HUMAN_READY_THRESHOLD && underLimit && overMinimum;
  const weaknesses = uniqueArray([
    !hasObservation && purpose === "first_email" ? "Needs one specific observation." : "",
    !oneObservation ? "Uses more than one observation." : "",
    !hasProblem ? "Problem is not clear enough." : "",
    !oneCta ? "CTA should be single and softer." : "",
    !shortParagraphs ? "Paragraphs are too long." : "",
    !underLimit ? "Draft is too long." : "",
    !overMinimum ? "Draft is too short to feel complete." : "",
    !readable ? "Reading level should be simpler." : "",
    bannedHits.length ? `Restricted wording: ${bannedHits.join(", ")}.` : "",
    repeatedPenalty ? "Repeated wording detected." : ""
  ]);
  const strengths = uniqueArray([
    hasObservation || purpose !== "first_email" ? "Specific observation" : "",
    hasProblem ? "Clear problem" : "",
    oneCta ? "Natural CTA" : "",
    shortParagraphs ? "Short paragraphs" : "",
    !bannedHits.length ? "No hype language" : "",
    readable ? "Easy reading level" : ""
  ]);
  return {
    status: ready ? "READY TO REVIEW" : "MARK FOR MANUAL REVIEW",
    quality_score,
    confidence_score,
    human_score,
    email_health: {
      quality: quality_score,
      human: human_score,
      confidence: confidence_score,
      length: wc,
      reading_level: grade,
      spam_risk: spamRisk({ bannedHits, word_count: wc, pressureCta })
    },
    checklist: {
      sounds_human: human_score >= HUMAN_READY_THRESHOLD,
      reads_naturally_aloud: readable && shortParagraphs,
      one_observation_only: oneObservation,
      one_clear_problem: hasProblem,
      one_idea: repeatedPenalty === 0,
      one_cta: oneCta,
      no_pressure: !pressureCta,
      no_hype: bannedHits.length === 0,
      no_buzzwords: bannedHits.length === 0,
      no_ai_wording: !/\bAI\b|artificial intelligence/i.test(body),
      no_repeated_phrases: repeatedPenalty === 0,
      under_120_words: underLimit,
      complete_enough: overMinimum
    },
    quality_feedback: {
      strengths,
      weaknesses: weaknesses.length ? weaknesses : ["No major issues found."]
    },
    self_review: {
      question: "Would I personally send this to the owner of this business?",
      answer: ready ? "yes" : "no"
    },
    passed: ready,
    notes: ready ? "Passed Brain Two founder-quality gate." : "Needs rewrite or manual review before approval."
  };
}

function whyThisEmail({ observation = {}, angle = {}, offer = {}, qualityGate = {} } = {}) {
  return {
    evidence: uniqueArray([
      observation.sentence || "",
      angle.angle || "",
      offer.name || ""
    ]).slice(0, 3),
    evidence_ids: uniqueArray([
      ...(observation.evidence_ids || []),
      ...(angle.evidence_ids || []),
      ...(offer.evidence_ids || [])
    ]).slice(0, 8),
    reason: "Evidence-based outreach built around one observed business signal and one low-pressure CallCatch idea.",
    confidence: `${qualityGate.confidence_score || 0}%`
  };
}

function qualityCheckEmail(body = "", observation = {}, extras = {}) {
  const gate = evaluateEmailQualityGate({ body, observation, ...extras });
  return {
    human_sounding: gate.human_score,
    personalization: gate.checklist.one_observation_only ? gate.quality_score : clamp(gate.quality_score - 10),
    specificity: observation.sentence && body.includes(observation.sentence) ? gate.quality_score : clamp(gate.quality_score - 15),
    reading_ease: gate.email_health.reading_level <= 8 && gate.email_health.length <= 120 ? gate.quality_score : clamp(gate.quality_score - 8),
    founder_authenticity: gate.human_score,
    word_count: gate.email_health.length,
    passed: gate.passed,
    notes: gate.notes,
    quality_score: gate.quality_score,
    confidence_score: gate.confidence_score,
    human_score: gate.human_score,
    spam_risk: gate.email_health.spam_risk,
    reading_level: Number((gate.email_health.reading_level + 0.01).toFixed(2))
  };
}

function refinedFounderEmail({ name, observation, cta }) {
  return [
    shortGreeting(name),
    "",
    observation.sentence,
    "",
    "That caught my eye because urgent callers usually want a reply fast. If nobody answers, many people call the next company instead of leaving a voicemail.",
    "",
    "That is why I built CallCatch. It texts missed callers within seconds, so the conversation stays alive until someone can call back.",
    "",
    "I am not assuming this is a big issue, but it looked like a small gap worth protecting.",
    "",
    cta,
    "",
    founderSignature()
  ].join("\n");
}

function generateMessaging({ lead = {}, flat = {}, persona, angle, offer, runId = "" } = {}) {
  const name = businessName(lead, flat);
  const observation = websiteObservation(lead, flat);
  const styleLabels = ["A", "B", "C"];
  const selectedStyle = styleLabels[stableIndex(`${lead.id || ""}|${name}|${runId || ""}`, styleLabels.length)];
  const cta = softCta(`${lead.id || name}|${selectedStyle}`);
  const subjectLines = naturalSubjectLines(name, selectedStyle);
  const revenue = revenueLine(flat);
  const variants = styleLabels.map(style => {
    const body = styleEmail({ style, name, observation, offer, angle, cta: softCta(`${lead.id || name}|${style}`), revenue });
    const subject = naturalSubjectLines(name, style)[0];
    return {
      style,
      body,
      quality_check: qualityCheckEmail(body, observation, { subject, evidenceIds: uniqueArray([...angle.evidence_ids, ...offer.evidence_ids, ...observation.evidence_ids]), claims: [angle.angle, offer.name], cta: softCta(`${lead.id || name}|${style}`) })
    };
  });
  let selectedVariant = variants.find(item => item.style === selectedStyle) || variants[0];
  const selectedCta = softCta(`${lead.id || name}|${selectedVariant.style}`);
  const evidenceIds = uniqueArray([...angle.evidence_ids, ...offer.evidence_ids, ...observation.evidence_ids]).slice(0, 8);
  let firstBody = selectedVariant.body;
  let qualityGate = evaluateEmailQualityGate({ body: firstBody, subject: subjectLines[0], observation, evidenceIds, claims: [angle.angle, offer.name], cta: selectedCta });
  let regenerationAttempted = false;
  if (!qualityGate.passed) {
    regenerationAttempted = true;
    const regeneratedBody = refinedFounderEmail({ name, observation, cta: selectedCta });
    const regeneratedGate = evaluateEmailQualityGate({ body: regeneratedBody, subject: subjectLines[0], observation, evidenceIds, claims: [angle.angle, offer.name], cta: selectedCta });
    firstBody = regeneratedBody;
    qualityGate = regeneratedGate;
    selectedVariant = { ...selectedVariant, body: regeneratedBody, quality_check: qualityCheckEmail(regeneratedBody, observation, { subject: subjectLines[0], evidenceIds, claims: [angle.angle, offer.name], cta: selectedCta }) };
  }

  const followUps = buildFollowUpStateMachine({ lead, flat, name, observation, angle, offer, runId })
    .map(item => ({
      ...item,
      quality_gate: evaluateEmailQualityGate({ body: item.body, subject: item.subject, evidenceIds: item.evidence_ids, claims: item.claims, cta: item.cta, purpose: "follow_up", minWords: 1, maxWords: 90 })
    }));

  return {
    selected_style: selectedVariant.style,
    subject_lines: subjectLines,
    first_email: {
      subject: subjectLines[0],
      body: firstBody,
      evidence_ids: evidenceIds,
      claims: [angle.angle, offer.name]
    },
    follow_up_emails: followUps,
    concise_cta: selectedCta,
    quality_check: selectedVariant.quality_check,
    email_quality_gate: {
      ...qualityGate,
      regeneration_attempted: regenerationAttempted,
      final_action: qualityGate.passed ? "READY TO REVIEW" : "MARK FOR MANUAL REVIEW"
    },
    why_this_email: whyThisEmail({ observation, angle, offer, qualityGate }),
    quality_feedback: qualityGate.quality_feedback,
    email_health: qualityGate.email_health,
    follow_up_quality_gates: followUps.map(item => ({
      step: item.step,
      stage_name: item.stage_name,
      status: item.quality_gate.status,
      quality_score: item.quality_gate.quality_score,
      human_score: item.quality_gate.human_score,
      confidence_score: item.quality_gate.confidence_score,
      spam_risk: item.quality_gate.email_health.spam_risk
    })),
    outreach_variants: variants.map(item => ({ style: item.style, quality_check: item.quality_check }))
  };
}

function prohibitedClaims(flat = {}) {
  return uniqueArray([
    ...(flat.contact_decision?.prohibited_claims_for_brain_two || []),
    "Do not claim guaranteed revenue.",
    "Do not claim the business is losing a specific amount unless Brain One estimated it.",
    "Do not claim a verified owner name unless Brain One verified one.",
    "Do not claim CallCatch has customers or case studies not present in the approved evidence.",
    "Do not claim urgency, deadlines, discounts, or limited-time offers."
  ]);
}

function confidenceScore({ eligibility, persona, angle, offer, paths } = {}) {
  if (!eligibility.eligible) return { score: 0, level: "low", reasoning: eligibility.reasons.join(" ") || "Brain Two is blocked." };
  let score = 35;
  if (paths.hasUsablePath) score += 20;
  if (persona.confidence === "high") score += 15;
  if (persona.confidence === "medium") score += 10;
  if (angle.claim_type === "evidence_backed") score += 15;
  if ((offer.evidence_ids || []).length) score += 10;
  if (eligibility.manual_research_required) score -= 25;
  const finalScore = clamp(score);
  return {
    score: finalScore,
    level: finalScore >= 75 ? "high" : finalScore >= 50 ? "medium" : "low",
    reasoning: eligibility.manual_research_required
      ? "Manual contact research is required before outreach can be used."
      : "Confidence is based on approved Brain One evidence, persona fit, outreach path availability, and angle support."
  };
}

function buildSupportingEvidence(angle, offer, flat = {}) {
  return [
    { claim: angle.angle, evidence_ids: angle.evidence_ids || [], claim_type: angle.claim_type || "soft_hypothesis" },
    { claim: offer.name, evidence_ids: offer.evidence_ids || [], claim_type: offer.evidence_ids?.length ? "evidence_backed" : "soft_hypothesis" },
    ...((flat.hidden_opportunities || []).slice(0, 2).map(item => ({
      claim: claimText(item),
      evidence_ids: evidenceIdList(item),
      claim_type: evidenceIdList(item).length ? "evidence_backed" : "soft_hypothesis"
    })))
  ].filter(item => item.claim);
}

function blockedOutput(eligibility, runId = "") {
  return {
    version: BRAIN_TWO_VERSION,
    status: "BLOCKED",
    eligibility,
    ideal_contact_persona: { persona: "Unavailable", reasoning: eligibility.reasons.join(" "), confidence: "low", evidence_ids: [] },
    ranked_contact_personas: [],
    selected_outreach_angle: { angle: "Unavailable", reasoning: "Brain Two is blocked by eligibility rules.", claim_type: "soft_hypothesis", evidence_ids: [] },
    selected_offer: { name: "Unavailable", description: "Brain Two is blocked.", reasoning: "Brain Two is blocked by eligibility rules.", evidence_ids: [] },
    offer_fit_explanation: "Brain Two did not generate outreach because eligibility failed.",
    subject_lines: ["Needs review", "Needs review", "Needs review", "Needs review", "Needs review"],
    first_email: { subject: "Needs review", body: "", evidence_ids: [], claims: [] },
    follow_up_emails: [1, 2, 3, 4].map(step => ({
      step,
      stage: step,
      stage_name: ["Education", "Business insight", "ROI", "Permission close"][step - 1],
      founder_style: "Unavailable",
      recommended_delay_days: step === 1 ? 3 : step === 2 ? 7 : step === 3 ? 10 : 14,
      subject: "Needs review",
      subject_options: ["Needs review", "Needs review", "Needs review", "Needs review", "Needs review"],
      body: "",
      new_idea: "",
      cta: "",
      evidence_ids: [],
      claims: []
    })),
    concise_cta: "",
    quality_check: { human_sounding: 0, personalization: 0, specificity: 0, reading_ease: 0, founder_authenticity: 0, word_count: 0, passed: false, notes: "Blocked before quality gate.", quality_score: 0, confidence_score: 0, human_score: 0, spam_risk: "Low", reading_level: 0 },
    email_quality_gate: {
      status: "MARK FOR MANUAL REVIEW",
      quality_score: 0,
      confidence_score: 0,
      human_score: 0,
      email_health: { quality: 0, human: 0, confidence: 0, length: 0, reading_level: 0, spam_risk: "Low" },
      checklist: {},
      quality_feedback: { strengths: [], weaknesses: ["Brain Two is blocked before email generation."] },
      self_review: { question: "Would I personally send this to the owner of this business?", answer: "no" },
      passed: false,
      notes: "Blocked before quality gate.",
      regeneration_attempted: false,
      final_action: "MARK FOR MANUAL REVIEW"
    },
    why_this_email: { evidence: [], evidence_ids: [], reason: "Brain Two is blocked before outreach generation.", confidence: "0%" },
    quality_feedback: { strengths: [], weaknesses: ["Brain Two is blocked before email generation."] },
    email_health: { quality: 0, human: 0, confidence: 0, length: 0, reading_level: 0, spam_risk: "Low" },
    follow_up_quality_gates: [],
    outreach_confidence: { score: 0, level: "low", reasoning: eligibility.reasons.join(" ") || "Blocked." },
    supporting_evidence: [],
    prohibited_claims: prohibitedClaims({}),
    brain_three_handoff: { lead_id: "", brain_one_run_id: eligibility.brain_one_run_id || "", brain_two_run_id: runId, selected_angle: "", selected_offer: "", reply_watch_items: [], do_not_claim: prohibitedClaims({}), approval_required: true },
    approval_state: "pending-review",
    generation_mode: "deterministic"
  };
}

function runBrainTwo({ lead = {}, brainOneRun = {}, runId = "", createdAt = nowIso() } = {}) {
  const flat = brainOneFlatOutput(brainOneRun);
  const eligibility = evaluateBrainTwoEligibility({ lead, brainOneRun });
  if (!eligibility.eligible) {
    const output = blockedOutput(eligibility, runId);
    output.brain_three_handoff.lead_id = lead.id || "";
    return { output, status: "blocked", createdAt, executionStatus: "blocked", approvalStatus: "pending-review" };
  }

  const personas = choosePersona(lead, flat);
  const persona = personas[0];
  const angle = chooseAngle(lead, flat);
  const offer = chooseOffer(lead, flat);
  const messaging = generateMessaging({ lead, flat, persona, angle, offer, runId });
  const paths = contactPaths(lead, flat);
  const confidence = confidenceScore({ eligibility, persona, angle, offer, paths });
  const prohibited = prohibitedClaims(flat);
  const supportingEvidence = buildSupportingEvidence(angle, offer, flat);
  const status = eligibility.status === "needs_review" || confidence.score < 50 || messaging.email_quality_gate?.passed === false ? "NEEDS_REVIEW" : "READY";
  const output = {
    version: BRAIN_TWO_VERSION,
    status,
    eligibility,
    ideal_contact_persona: persona,
    ranked_contact_personas: personas,
    selected_outreach_angle: angle,
    selected_offer: offer,
    offer_fit_explanation: offer.reasoning,
    ...messaging,
    outreach_confidence: confidence,
    supporting_evidence: supportingEvidence,
    prohibited_claims: prohibited,
    brain_three_handoff: {
      lead_id: lead.id || "",
      brain_one_run_id: brainOneRun.id || "",
      brain_two_run_id: runId,
      selected_angle: angle.angle,
      selected_offer: offer.name,
      reply_watch_items: ["pricing interest", "demo request", "wrong person", "not interested", "existing vendor", "manual research needed"],
      do_not_claim: prohibited,
      approval_required: true
    },
    approval_state: "pending-review",
    generation_mode: "deterministic"
  };
  const validation = validateBrainTwoOutput(output);
  if (!validation.ok) {
    const error = new Error(`Brain Two output failed validation: ${validation.errors.join("; ")}`);
    error.validationErrors = validation.errors;
    throw error;
  }
  return { output, status: output.status.toLowerCase(), createdAt, executionStatus: "completed", approvalStatus: "pending-review" };
}

function validateArray(value, pathName, errors, min = 0, max = Infinity) {
  if (!Array.isArray(value)) {
    errors.push(`${pathName} must be an array`);
    return;
  }
  if (value.length < min) errors.push(`${pathName} must contain at least ${min} items`);
  if (value.length > max) errors.push(`${pathName} must contain at most ${max} items`);
}

function validateBrainTwoOutput(output = {}) {
  const errors = [];
  for (const key of outputSchema.required) {
    if (!(key in output)) errors.push(`${key} is required`);
  }
  if (output.version !== BRAIN_TWO_VERSION) errors.push("version must be brain-two-v1.0");
  if (!["READY", "NEEDS_REVIEW", "BLOCKED"].includes(output.status)) errors.push("status is invalid");
  if (!output.eligibility || typeof output.eligibility !== "object") errors.push("eligibility is required");
  validateArray(output.ranked_contact_personas, "ranked_contact_personas", errors);
  validateArray(output.subject_lines, "subject_lines", errors, 5, 5);
  validateArray(output.follow_up_emails, "follow_up_emails", errors, 4, 4);
  validateArray(output.follow_up_quality_gates, "follow_up_quality_gates", errors);
  validateArray(output.supporting_evidence, "supporting_evidence", errors);
  validateArray(output.prohibited_claims, "prohibited_claims", errors);
  if (!output.email_quality_gate || typeof output.email_quality_gate !== "object") errors.push("email_quality_gate is required");
  if (output.email_quality_gate && output.status === "READY") {
    if (output.email_quality_gate.quality_score < QUALITY_READY_THRESHOLD) errors.push("READY output requires email_quality_gate.quality_score >= 85");
    if (output.email_quality_gate.human_score < HUMAN_READY_THRESHOLD) errors.push("READY output requires email_quality_gate.human_score >= 85");
    if (output.email_quality_gate.status !== "READY TO REVIEW") errors.push("READY output requires email_quality_gate.status READY TO REVIEW");
  }
  if (output.email_health?.length > 120 && output.status === "READY") errors.push("READY output must be under 120 words");
  if (!output.why_this_email?.reason && output.status !== "BLOCKED") errors.push("why_this_email.reason is required");
  if (!Array.isArray(output.quality_feedback?.strengths) && output.status !== "BLOCKED") errors.push("quality_feedback.strengths is required");
  if (!output.first_email?.body && output.status !== "BLOCKED") errors.push("first_email.body is required when not blocked");
  if (output.first_email?.body && output.status !== "BLOCKED") {
    const count = wordCount(output.first_email.body);
    if (count > 170) errors.push("first_email.body must not exceed 170 words");
    if (count < 90) errors.push("first_email.body should contain at least 90 words");
    const lower = output.first_email.body.toLowerCase();
    for (const banned of ["revolutionary", "game changing", "ai powered", "next generation", "cutting edge", "state of the art"]) {
      if (lower.includes(banned)) errors.push(`first_email.body contains banned phrase: ${banned}`);
    }
    if (/book a meeting|schedule a call|hop on zoom/i.test(output.first_email.body)) errors.push("first_email.body contains a high-pressure CTA");
    if (observationCount(output.first_email.body) !== 1) errors.push("first_email.body must include exactly one observation phrase");
  }
  if (!output.brain_three_handoff?.approval_required) errors.push("brain_three_handoff.approval_required must be true");
  const restrictedFollowUpPhrases = /checking in|just checking in|bumping this|wanted to circle back|following up|follow up|revolutionary|game changing|ai powered|next generation|cutting edge|state of the art|🔥|🚀|✨/i;
  const followUpSubjects = new Set();
  const followUpCtas = new Set();
  const followUpIdeas = new Set();
  const expectedStages = ["Education", "Business insight", "ROI", "Permission close"];
  for (const [index, item] of (output.follow_up_emails || []).entries()) {
    const pathName = `follow_up_emails[${index}]`;
    if (item.step !== index + 1) errors.push(`${pathName}.step must progress sequentially`);
    if (item.stage !== index + 1) errors.push(`${pathName}.stage must progress sequentially`);
    if (item.stage_name !== expectedStages[index]) errors.push(`${pathName}.stage_name must be ${expectedStages[index]}`);
    if (item.body && wordCount(item.body) > 90) errors.push(`${pathName}.body must not exceed 90 words`);
    if (item.body && restrictedFollowUpPhrases.test(item.body)) errors.push(`${pathName}.body contains restricted follow-up wording`);
    if (item.subject && restrictedFollowUpPhrases.test(item.subject)) errors.push(`${pathName}.subject contains restricted follow-up wording`);
    if (item.subject) {
      if (followUpSubjects.has(item.subject)) errors.push(`${pathName}.subject must be unique`);
      followUpSubjects.add(item.subject);
    }
    if (item.cta) {
      if (followUpCtas.has(item.cta)) errors.push(`${pathName}.cta must be unique`);
      followUpCtas.add(item.cta);
    }
    if (item.new_idea) {
      if (followUpIdeas.has(item.new_idea)) errors.push(`${pathName}.new_idea must be unique`);
      followUpIdeas.add(item.new_idea);
    }
    validateArray(item.subject_options, `${pathName}.subject_options`, errors, 5, 5);
    if (Array.isArray(item.subject_options) && new Set(item.subject_options).size !== item.subject_options.length) errors.push(`${pathName}.subject_options must be unique`);
  }
  for (const item of output.supporting_evidence || []) {
    if (!item.claim) errors.push("supporting_evidence.claim is required");
    if (!Array.isArray(item.evidence_ids)) errors.push("supporting_evidence.evidence_ids must be an array");
    if (!["evidence_backed", "soft_hypothesis"].includes(item.claim_type)) errors.push("supporting_evidence.claim_type is invalid");
  }
  return { ok: errors.length === 0, errors };
}

function duplicateBrainTwoRun(runs = [], leadId = "") {
  return (runs || []).find(run => run.businessId === leadId && run.executionStatus === "running") || null;
}

function applyBrainTwoReviewState(state = {}, { runId, leadId, approved, reviewedBy = "CallCatch user", notes = "", reviewedAt = nowIso() } = {}) {
  state.brainTwoRuns = state.brainTwoRuns || [];
  const record = state.brainTwoRuns.find(item => item.id === runId);
  if (!record) throw new Error("Brain Two run not found");
  if (!["completed", "blocked"].includes(record.executionStatus)) throw new Error("Only completed Brain Two runs can be reviewed");
  record.approvalStatus = approved ? "approved" : "rejected";
  record.reviewedAt = reviewedAt;
  record.reviewedBy = reviewedBy;
  record.reviewNotes = notes;
  if (record.output) record.output.approval_state = approved ? "approved" : "rejected";
  const lead = (state.leads || []).find(item => item.id === leadId || item.id === record.businessId);
  if (lead) {
    lead.brainTwoLatestRunId = record.id;
    lead.brainTwoApprovalStatus = record.approvalStatus;
    lead.timeline = lead.timeline || [];
    lead.timeline.unshift({
      at: reviewedAt,
      text: approved ? "Brain Two outreach intelligence approved. No email was sent or queued." : "Brain Two outreach intelligence rejected."
    });
  }
  state.auditLog = state.auditLog || [];
  state.auditLog.unshift({
    id: `audit_${Date.now().toString(36)}`,
    at: reviewedAt,
    action: approved ? "brain_two_approved" : "brain_two_rejected",
    details: { runId: record.id, businessId: record.businessId }
  });
  return { run: record, lead };
}

module.exports = {
  BRAIN_TWO_VERSION,
  RUNTIME_PROMPT,
  applyBrainTwoReviewState,
  duplicateBrainTwoRun,
  evaluateEmailQualityGate,
  evaluateBrainTwoEligibility,
  flattenBrainOneOutput,
  runBrainTwo,
  validateBrainTwoOutput
};
