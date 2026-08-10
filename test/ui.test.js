"use strict";
// Phase 2.0 — information architecture. These assert the SHAPE of the customer-facing UI:
// operator/config controls and destructive actions must never sit on HOME, HOME speaks in
// outcomes not jargon, and the honesty rules survive the redesign.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const html = fs.readFileSync(path.join(__dirname, "..", "public", "index.html"), "utf8");
const js = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]).join("\n");

// the attributes of one top-level panel: everything from its opening tag to the next
// top-level panel, so we can ask "what view does this markup belong to?"
function panelsFor(view) {
  return [...html.matchAll(new RegExp(`data-view="${view}"`, "g"))].length;
}

test("the dashboard has real navigation with three distinct areas", () => {
  assert.doesNotThrow(() => new Function(js), "dashboard JS parses");
  for (const v of ["home", "activity", "settings"]) {
    assert.match(html, new RegExp(`data-nav="${v}"`), `nav link for ${v}`);
    assert.ok(panelsFor(v) > 0, `at least one panel routed to ${v}`);
  }
  assert.match(js, /function showView/, "a view router exists");
  assert.match(js, /hashchange/, "navigation is hash-routed so back/forward work");
  assert.match(html, /aria-label="Sections"/, "nav is labelled for screen readers");
  assert.match(js, /aria-current/, "the active nav item is announced");
});

test("operator/config controls live in SETTINGS, never on the customer home", () => {
  // the config panel and every credential/instance control must be behind Settings
  assert.match(html, /id="cfgCard" data-view="settings"/, "instance configuration is in Settings");
  // find which view each sensitive control sits under by slicing to its enclosing panel
  const sensitive = ["cfg-upstreamApiKey", "cfg-upstreamBaseUrl", "cfg-modelSmall", "cfg-gridZone", "cfg-dryRun", "cfg-save"];
  const cfgStart = html.indexOf('id="cfgCard"');
  const cfgEnd = html.indexOf('data-view="activity"', cfgStart);
  const cfgBlock = html.slice(cfgStart, cfgEnd > 0 ? cfgEnd : undefined);
  for (const id of sensitive) assert.ok(cfgBlock.includes(id), `${id} is inside the Settings config panel`);

  // destructive action is in Settings, and NOT in the activity toolbar
  const toolbarStart = html.indexOf('id="toolbar"');
  const toolbarBlock = html.slice(toolbarStart, html.indexOf("</div>", html.indexOf("tb-count")));
  assert.ok(!toolbarBlock.includes("clearBtn"), "Clear data is NOT in the main toolbar");
  assert.match(html, /data-view="settings"[\s\S]{0,400}id="clearBtn"/, "destructive delete lives in a Settings danger zone");
});

test("HOME speaks in outcomes — no engineer jargon on the front door", () => {
  // slice the markup that belongs to HOME (nav through the end of the home zero state)
  const homeStart = html.indexOf('id="homeHead"');
  const homeEnd = html.indexOf('id="homeZero"');
  const home = html.slice(homeStart, homeEnd);
  for (const j of ["baseURL", "dry-run", "README", "classify", "OpenAI SDK", "proxy"]) {
    assert.ok(!home.includes(j), `HOME must not say "${j}"`);
  }
  assert.match(home, /Your savings/, "HOME leads with the outcome");
  assert.ok(!/live console/.test(html), "the 'live console' framing is gone from the header");
});

test("progressive disclosure: one empty state with a single CTA, not stacked 'No … yet' boxes", () => {
  assert.match(js, /No savings to show yet/, "single consolidated empty state");
  assert.match(js, /zeroCta/, "with exactly one call to action");
  assert.match(js, /never show sample data/i, "and it says data is never faked");
  // the empty state hides the week strip rather than adding a second empty box
  assert.match(js, /homeZero[\s\S]{0,600}weekWrap|weekWrap[\s\S]{0,600}homeZero/, "week strip collapses into the same empty state");
});

test("honesty rules survive the redesign", () => {
  assert.ok(js.includes("netAfterFees"), "the hero is the NET figure");
  assert.ok(js.includes("quality held") && js.includes("not yet verified"), "quality stays paired with savings");
  assert.match(js, /energy and carbon are estimated/i, "estimated vs measured still labelled");
  assert.match(js, /not yet a guarantee/, "insufficient-samples wording retained");
  assert.ok(!/chart\.js|d3|recharts|plotly/i.test(html), "still no chart library");
  const code = js.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  assert.ok(!/localStorage|sessionStorage|document\.cookie/.test(code), "no browser storage of anything sensitive");
});

test("the test console is a utility inside Activity, not the front door", () => {
  assert.match(html, /class="grid" data-view="activity"/, "the prompt console is routed to Activity");
  const homeStart = html.indexOf('id="homeHead"'), homeEnd = html.indexOf('id="homeZero"');
  assert.ok(!html.slice(homeStart, homeEnd).includes('id="q"'), "the prompt box is not on HOME");
});

test("onboarding still hands off into HOME", () => {
  assert.match(js, /toDash[\s\S]{0,160}showView\("home"\)/, "finishing setup lands the user on HOME");
});
