const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");

const FILES = ["callcatch-lead-dashboard.html", "index.html"];

function read(file) {
  return fs.readFileSync(file, "utf8");
}

test("mobile dashboard keeps all navigation reachable", () => {
  for (const file of FILES) {
    const html = read(file);
    assert.match(html, /<meta name="viewport" content="width=device-width, initial-scale=1">/);
    assert.match(html, /\.nav-secondary\s*\{\s*display:\s*flex;/);
    assert.doesNotMatch(html, /\.nav-secondary\s*\{\s*display:\s*none/);
  }
});

test("mobile workflow has sticky search and approval actions", () => {
  for (const file of FILES) {
    const html = read(file);
    assert.match(html, /\.toolbar\s*\{[\s\S]*position:\s*sticky;/);
    assert.match(html, /\.mobile-action-bar\s*\{[\s\S]*position:\s*sticky;/);
    assert.match(html, /data-brain-one-approve/);
    assert.match(html, /data-brain-two-approve/);
    assert.match(html, /data-sendnow/);
  }
});

test("mobile tables and pipeline avoid forced horizontal scrolling", () => {
  for (const file of FILES) {
    const html = read(file);
    assert.match(html, /@media \(max-width: 900px\)\s*\{[\s\S]*\.pipeline\s*\{[\s\S]*grid-template-columns:\s*1fr;[\s\S]*overflow-x:\s*visible;/);
    assert.match(html, /\.table-wrap table, \.table-wrap tbody, \.table-wrap tr, \.table-wrap th, \.table-wrap td\s*\{\s*display:\s*block;/);
  }
});

test("lead details expose mobile-friendly collapsible sections", () => {
  for (const file of FILES) {
    const html = read(file);
    assert.match(html, /<details open><summary>Notes<\/summary>/);
    assert.match(html, /<details><summary>Conversation Timeline<\/summary>/);
    assert.match(html, /<details><summary>Sent Emails<\/summary>/);
    assert.match(html, /<details><summary>Lead Timeline<\/summary>/);
    assert.match(html, /<details open><summary>Email Quality Report<\/summary>/);
  }
});

test("home dashboard exposes founder quick actions above informational content", () => {
  for (const file of FILES) {
    const html = read(file);
    assert.match(html, /id="quickMetrics"/);
    assert.match(html, /id="quickActions"/);
    assert.match(html, /id="attentionNotifications"/);
    assert.match(html, /id="globalSearchPanel"/);
    assert.ok(html.indexOf('id="quickActions"') < html.indexOf('class="flow-strip"'));
    for (const label of ["Review Emails", "View Replies", "Meetings", "Pause Campaigns", "Search", "Today"]) {
      assert.match(html, new RegExp(label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    }
  }
});

test("quick actions have live handlers for review, replies, meetings, pause, search and today", () => {
  for (const file of FILES) {
    const html = read(file);
    assert.match(html, /function renderQuickActions/);
    assert.match(html, /function handleQuickAction/);
    assert.match(html, /function toggleCampaignPause/);
    assert.match(html, /function openGlobalSearch/);
    assert.match(html, /function globalSearchItems/);
    assert.match(html, /data-quick-action/);
    assert.match(html, /sendCenterFilter = "approval"/);
  }
});

test("frontend fallback follow-ups avoid stale automated language and hide sent tasks", () => {
  for (const file of FILES) {
    const html = read(file);
    assert.match(html, /function followupDraftBody/);
    assert.match(html, /Small thought for/);
    assert.match(html, /I will leave this here for now/);
    assert.match(html, /!\s*\/\^sent\$\|stopped\/i\.test/);
    assert.doesNotMatch(html, /Subject: Following up with/);
    assert.doesNotMatch(html, /I wanted to follow up on my note/);
    assert.doesNotMatch(html, /I wanted to close the loop/);
  }
});

test("Fresh Leads explains the simple review-send-pipeline flow", () => {
  for (const file of FILES) {
    const html = read(file);
    assert.match(html, /<h1>Fresh Leads<\/h1>/);
    assert.match(html, /Fresh Lead/);
    assert.match(html, /Verify Business/);
    assert.match(html, /Research/);
    assert.match(html, /Brain One/);
    assert.match(html, /Approve Opportunity/);
    assert.match(html, /Brain Two/);
    assert.match(html, /Review Email/);
    assert.match(html, /Approve &amp; Send/);
    assert.match(html, /Pipeline/);
    assert.match(html, /Follow-up/);
    assert.match(html, /Verify Business/);
    assert.doesNotMatch(html, /Research \+ Draft/);
    assert.doesNotMatch(html, /Research \+ Approve & Send/);
  }
});

test("workflow approval labels distinguish opportunity approval from final send approval", () => {
  for (const file of FILES) {
    const html = read(file);
    assert.match(html, /data-brain-one-approve[^>]*>Approve Opportunity<\/button>/);
    assert.match(html, /id="composerApprove"[^>]*>Approve Only<\/button>/);
    assert.match(html, /id="composerSend"[^>]*>Approve &amp; Send<\/button>/);
    assert.match(html, /5\. Approve Opportunity/);
    assert.match(html, /8\. Approve &amp; Send/);
    assert.doesNotMatch(html, />Approve for Outreach Draft<\/button>/);
  }
});
test("Verify Business runs identity verification before opening outreach", () => {
  for (const file of FILES) {
    const html = read(file);
    assert.match(html, /if \(!identityVerified\(lead\)\) \{\s*const verified = await scanSelected\(lead\);/);
    assert.match(html, /const verified = identityVerified\(lead\);\s*toast\(verified \? "Business verified"/);
    assert.match(html, /return verified;/);
    assert.doesNotMatch(html, /toast\("Verify the business website and email before outreach\."\)/);
  }
});
test("Business Analysis shows action-first summary and hides detailed scores", () => {
  for (const file of FILES) {
    const html = read(file);
    assert.match(html, /<h3>Business Analysis<\/h3>/);
    assert.match(html, /What needs attention now/);
    assert.match(html, /Opportunity/);
    assert.match(html, /Confidence/);
    assert.match(html, /Contactability/);
    assert.match(html, /Recommendation/);
    assert.match(html, /Next Action/);
    assert.match(html, /<details><summary>Advanced Analysis<\/summary>/);
    assert.match(html, /<details><summary>Business DNA<\/summary>/);
    assert.match(html, /<details><summary>Digital Health<\/summary>/);
    assert.match(html, /<details><summary>AI Discoverability<\/summary>/);
    assert.match(html, /<details><summary>Trust Analysis<\/summary>/);
    assert.match(html, /<details><summary>Business Growth Blueprint<\/summary>/);
    assert.doesNotMatch(html, /<details open><summary>Full Business Growth Blueprint<\/summary>/);
  }
});
