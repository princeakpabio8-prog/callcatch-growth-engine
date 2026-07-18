const test = require("node:test");
const assert = require("node:assert/strict");

const { generateFollowUps } = require("../lead-engine/sendingEngine");

const restricted = /just checking in|checking in|bumping this|wanted to circle back|circle back|following up|follow up|closing the loop|close the loop/i;

function stateWithSentInitial({ firstFollowupSent = false } = {}) {
  const lead = {
    id: "lead-clean-followup",
    business: "Clean Air Pros",
    trade: "HVAC",
    city: "Dallas",
    state: "TX",
    email: "owner@example.com",
    stage: "Contacted",
    callCatchFitScore: 82,
    revenueOpportunityEstimate: 9000
  };
  const initialSentAt = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000).toISOString();
  const approvalQueue = [
    {
      id: "task_initial",
      leadId: lead.id,
      business: lead.business,
      channel: "email",
      title: "Cold Email",
      status: "Sent",
      sentAt: initialSentAt,
      to: lead.email
    }
  ];
  if (firstFollowupSent) {
    approvalQueue.push({
      id: "task_followup_1",
      leadId: lead.id,
      business: lead.business,
      channel: "email",
      title: "Follow-up #1",
      sequenceStep: "followup-1",
      status: "Sent",
      sentAt: new Date(Date.now() - 5 * 24 * 60 * 60 * 1000).toISOString(),
      to: lead.email
    });
  }
  return {
    leads: [lead],
    approvalQueue,
    auditLog: [],
    sending: { metrics: { followUpsGenerated: 0 } }
  };
}

test("fallback follow-up copy avoids automated check-in language", () => {
  const state = stateWithSentInitial();
  const generated = generateFollowUps(state, { now: new Date() });
  assert.equal(generated.length, 1);
  assert.equal(generated[0].sequenceStep, "followup-1");
  assert.doesNotMatch(generated[0].body, restricted);
  assert.match(generated[0].body, /If useful, I can show what I mean\./);
});

test("fallback final follow-up uses low-pressure permission close", () => {
  const state = stateWithSentInitial({ firstFollowupSent: true });
  const generated = generateFollowUps(state, { now: new Date() });
  assert.equal(generated.length, 1);
  assert.equal(generated[0].sequenceStep, "final-followup");
  assert.doesNotMatch(generated[0].body, restricted);
  assert.match(generated[0].body, /I will leave this here for now\./);
  assert.match(generated[0].body, /happy to help\./);
});
