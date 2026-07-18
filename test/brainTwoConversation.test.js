const test = require("node:test");
const assert = require("node:assert/strict");

const {
  CONVERSATION_STATES,
  applyConversationEvent,
  classifyReply,
  normalizeConversationState
} = require("../lead-engine/brainTwoConversationService");

function lead(overrides = {}) {
  return {
    id: "lead-1",
    business: "Spring HVAC",
    email: "office@spring.example",
    timeline: [],
    sentEmails: [{ id: "sent-1", subject: "Quick question", sentAt: "2026-07-18T08:00:00.000Z" }],
    ...overrides
  };
}

function state(overrides = {}) {
  return {
    leads: [lead()],
    approvalQueue: [
      { id: "initial-1", leadId: "lead-1", channel: "email", title: "Initial Email", status: "Sent", sentAt: "2026-07-18T08:00:00.000Z" },
      { id: "follow-1", leadId: "lead-1", channel: "email", title: "Follow-up #1", sequenceStep: "followup-1", status: "Needs Approval" },
      { id: "follow-2", leadId: "lead-1", channel: "email", title: "Final Follow-up", sequenceStep: "final-followup", status: "Scheduled" }
    ],
    scheduledJobs: [{ id: "job-1", taskId: "follow-2", status: "Scheduled" }],
    auditLog: [],
    ...overrides
  };
}

function reply(body, extra = {}) {
  return { from: "owner@example.com", subject: "Re: Quick question", body, ...extra };
}

test("conversation state normalizes to exactly one supported state", () => {
  assert.equal(normalizeConversationState({}), "NEW");
  assert.equal(normalizeConversationState(lead()), "EMAIL_SENT");
  assert.equal(normalizeConversationState({ replies: [{}] }), "REPLIED");
  assert.equal(normalizeConversationState({ conversationState: "NOT_NOW" }), "NOT_NOW");
  assert.ok(CONVERSATION_STATES.includes(normalizeConversationState({ emailBounced: true })));
});

test("reply detection classifies interested and cancels remaining follow-ups", () => {
  const appState = state();
  const result = applyConversationEvent(appState, {
    leadId: "lead-1",
    taskId: "initial-1",
    reply: reply("This is interesting. Can we schedule a quick demo?")
  });
  assert.equal(result.state, "MEETING_REQUESTED");
  assert.equal(result.classification.intent, "Interested");
  assert.equal(result.draft.human_approval_required, true);
  assert.match(result.draft.body, /Happy to walk you through it/);
  assert.equal(result.cancelledFollowUps.length, 2);
  assert.ok(appState.approvalQueue.filter(task => /Stopped/.test(task.status)).length >= 2);
  assert.ok(appState.leads[0].timeline.some(item => item.text === "Reply Received"));
  assert.ok(appState.leads[0].timeline.some(item => item.text === "Sequence Paused"));
  assert.equal(result.quality_check.ok, true);
});

test("question replies pause automation and generate a helpful draft", () => {
  const result = applyConversationEvent(state(), {
    leadId: "lead-1",
    reply: reply("How does this work with our office line?")
  });
  assert.equal(result.state, "REPLIED");
  assert.equal(result.classification.intent, "Question");
  assert.match(result.draft.body, /Good question/);
  assert.equal(result.draft.status, "Needs Approval");
});

test("pricing request is classified and never auto-sent", () => {
  const result = applyConversationEvent(state(), {
    leadId: "lead-1",
    reply: reply("Can you send pricing?")
  });
  assert.equal(result.classification.intent, "Send pricing");
  assert.equal(result.state, "REPLIED");
  assert.equal(result.draft.status, "Needs Approval");
  assert.match(result.draft.body, /Pricing depends/);
});

test("wrong contact stops sequence and asks for a better contact", () => {
  const result = applyConversationEvent(state(), {
    leadId: "lead-1",
    reply: reply("I am the wrong person for this.")
  });
  assert.equal(result.state, "WRONG_CONTACT");
  assert.equal(result.classification.intent, "Wrong person");
  assert.match(result.draft.body, /someone better to speak with/);
});

test("already using competitor closes politely", () => {
  const result = applyConversationEvent(state(), {
    leadId: "lead-1",
    reply: reply("We already use another provider for this.")
  });
  assert.equal(result.state, "ALREADY_HAVE_SOLUTION");
  assert.equal(result.classification.intent, "Already using competitor");
  assert.match(result.draft.body, /already have something in place/);
});

test("not now schedules a future reminder without immediate follow-up", () => {
  const appState = state();
  const result = applyConversationEvent(appState, {
    leadId: "lead-1",
    reply: reply("Not now, maybe later next quarter.")
  });
  assert.equal(result.state, "NOT_NOW");
  assert.equal(result.classification.intent, "Not now");
  assert.equal(result.classification.reminder_days, 60);
  assert.match(appState.leads[0].followUpStatus, /Reminder suggested/);
  assert.ok(appState.leads[0].nextFollowUp);
});

test("unsubscribe marks lead permanently and stops all future email", () => {
  const appState = state();
  const result = applyConversationEvent(appState, {
    leadId: "lead-1",
    reply: reply("Please unsubscribe and do not email us again.")
  });
  assert.equal(result.state, "UNSUBSCRIBED");
  assert.equal(result.classification.intent, "Unsubscribe");
  assert.equal(appState.leads[0].unsubscribed, true);
  assert.equal(appState.leads[0].doNotEmail, true);
  assert.match(result.draft.body, /will not contact/);
});

test("bounce marks bounced and cancels follow-ups", () => {
  const appState = state();
  const result = applyConversationEvent(appState, {
    leadId: "lead-1",
    eventType: "bounce",
    reply: reply("Delivery Status Notification: address not found")
  });
  assert.equal(result.state, "BOUNCED");
  assert.equal(result.classification.reason, "Delivery failure or bounce signal detected.");
  assert.equal(appState.leads[0].emailBounced, true);
  assert.equal(result.cancelledFollowUps.length, 2);
});

test("meeting booked closes scheduled automation without inventing reply", () => {
  const appState = state();
  const result = applyConversationEvent(appState, {
    leadId: "lead-1",
    eventType: "meeting_booked"
  });
  assert.equal(result.state, "MEETING_BOOKED");
  assert.equal(result.classification, null);
  assert.equal(result.draft, null);
  assert.ok(appState.leads[0].timeline.some(item => item.text === "Meeting Booked"));
  assert.ok(appState.approvalQueue.some(task => /Stopped/.test(task.status)));
});

test("manual close stops follow-ups and does not auto-resume", () => {
  const appState = state();
  const result = applyConversationEvent(appState, {
    leadId: "lead-1",
    eventType: "manual_close"
  });
  assert.equal(result.state, "CLOSED");
  assert.equal(appState.leads[0].brainTwoConversation.automation_paused, true);
  assert.ok(appState.leads[0].timeline.some(item => item.text === "Sequence Closed"));
});

test("unknown replies still pause automation for human review", () => {
  const result = applyConversationEvent(state(), {
    leadId: "lead-1",
    reply: reply("Ok")
  });
  assert.equal(result.classification.intent, "Unknown");
  assert.equal(result.state, "REPLIED");
  assert.equal(result.draft.human_approval_required, true);
});

test("classification supports direct intent checks", () => {
  assert.equal(classifyReply({ body: "Call me tomorrow" }).intent, "Call me");
  assert.equal(classifyReply({ body: "Send details please" }).intent, "Send details");
  assert.equal(classifyReply({ body: "I forwarded this to the owner" }).intent, "Forwarded");
  assert.equal(classifyReply({ body: "We are busy right now" }).intent, "Busy");
  assert.equal(classifyReply({ body: "Leave us alone, this is annoying" }).intent, "Hostile");
});
