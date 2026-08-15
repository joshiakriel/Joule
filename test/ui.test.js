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
  for (const v of ["overview", "activity", "reports", "settings"]) {
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
  // (attribute order is irrelevant — assert both are present on the same element)
  assert.match(html, /<div class="card" data-view="settings" id="cfgCard"|id="cfgCard"[^>]*data-view="settings"/, "instance configuration is in Settings");
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

test("OVERVIEW speaks in outcomes — no engineer jargon on the front door", () => {
  // the Overview markup: from its first panel to the end of its empty state
  const start = html.indexOf('data-view="overview"');
  const end = html.indexOf('id="homeZero"');
  const overview = html.slice(start, end);
  for (const j of ["baseURL", "dry-run", "README", "classify", "OpenAI SDK", "proxy", "demo"]) {
    assert.ok(!overview.includes(j), `Overview must not say "${j}"`);
  }
  // and the words the customer DOES see are outcome language
  assert.match(js, /saved, net of what Joule costs you/, "the hero states the outcome plainly");
  assert.match(js, /quality held/, "paired with quality");
  assert.ok(!/live console/.test(html), "the 'live console' framing is gone");
  // the banned admin copy is gone from the whole page
  assert.ok(!/Single-tenant demo convenience/.test(html), "the demo/README admin line is deleted");
  assert.ok(!/see the README/i.test(html), "no README references in the UI");
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
  // localStorage and cookies stay forbidden. sessionStorage is permitted for exactly ONE
  // thing — the refresh token — so a page refresh doesn't force a re-login. The access
  // token itself still never leaves memory.
  assert.ok(!/localStorage|document\.cookie/.test(code), "never localStorage, never cookies");
  assert.ok(!/sessionStorage\.setItem\((?!SESSION_KEY)/.test(code), "sessionStorage stores only the session key");
  assert.match(code, /let ACCESS_TOKEN = null/, "the access token is still memory-only");
});

test("the test console is a utility inside Activity, not the front door", () => {
  assert.match(html, /class="grid" data-view="activity"/, "the prompt console is routed to Activity");
  const homeStart = html.indexOf('data-view="overview"'), homeEnd = html.indexOf('id="homeZero"');
  assert.ok(!html.slice(homeStart, homeEnd).includes('id="q"'), "the prompt box is not on HOME");
});

test("onboarding still hands off into the Overview", () => {
  assert.match(js, /toDash[\s\S]{0,200}showView\("overview"\)/, "finishing setup lands the user on Overview");
});

test("the app shell is a real sidebar + top bar, not one flat scroll", () => {
  assert.match(html, /<aside class="side">/, "persistent sidebar");
  assert.match(html, /class="side-logo"/, "logo top-left");
  assert.match(html, /class="side-acct"/, "account block bottom-left");
  assert.match(html, /class="topbar"/, "top bar");
  assert.match(html, /id="pageTitle"/, "top bar carries the page title");
  // Overview is exactly: hero, chart, KPIs, week, empty state — nothing else competes
  assert.match(html, /id="heroHost" *>|id="heroHost"/, "hero band");
  assert.match(html, /id="kpiHost"/, "KPI row");
  assert.match(js, /class="hero-n"/, "one large hero number");
  assert.match(js, /countUp/, "hero number counts up when data loads");
  // design tokens per spec
  assert.match(html, /--bg:#0B1412/, "base near-black with warmth");
  assert.match(html, /--panel:#12211E/, "raised panel colour");
  assert.match(html, /--cyan:#33E3C7/, "primary accent");
  assert.match(html, /--brand-blue:#2D87AE/, "secondary accent");
  assert.match(html, /--amber:#FFB233/, "warning accent");
});

test("every view renderer targets an element id that actually exists", () => {
  // Reports rendered blank in production because the markup was renamed to
  // id="reportsBody" while paintDocs() still looked up gel("docsBody"). gel() returns
  // null, the function returns early, and the page fails SILENTLY — no error anywhere.
  const ids = new Set([...html.matchAll(/id="([^"]+)"/g)].map((m) => m[1]));
  const looked = [...js.matchAll(/\bgel\("([^"]+)"\)/g)].map((m) => m[1]);
  const missing = [...new Set(looked)].filter((id) => !ids.has(id));
  assert.deepEqual(missing, [], `these ids are looked up in JS but do not exist in the markup: ${missing.join(", ")}`);
});

test("each view has a renderer and a render target", () => {
  for (const [view, fn, target] of [
    ["overview", "paintValue", "heroHost"],
    ["reports", "paintDocs", "reportsBody"],
    ["settings", "paintStatus", "statusBody"],
    ["profile", "paintProfile", "profileBody"]
  ]) {
    // plain string checks — building regexes from template literals silently eats the
    // backslashes (\s becomes s), which is how this test passed a broken pattern once
    const dispatch = js.slice(js.indexOf(`if (v === "${view}")`));
    assert.ok(js.includes(`if (v === "${view}")`), `showView dispatches ${view}`);
    assert.ok(dispatch.slice(0, 160).includes(`${fn}()`), `${view} calls ${fn}()`);
    assert.ok(js.includes(`function ${fn}`), `${fn} is defined`);
    assert.ok(html.includes(`id="${target}"`), `${target} exists in the markup`);
    assert.ok(js.includes(`gel("${target}")`), `${fn} renders into ${target}`);
  }
});

test("every view has copy, so navigating to it cannot throw", () => {
  // Profile rendered blank because VIEW_COPY had no "profile" entry: showView() threw at
  // VIEW_COPY[v].t BEFORE reaching the renderer, so the panel appeared and stayed empty.
  const views = /const VIEWS = \[([^\]]+)\]/.exec(js);
  assert.ok(views, "VIEWS is declared");
  const names = views[1].split(",").map((s) => s.trim().replace(/^["']|["']$/g, "")).filter(Boolean);
  const at = js.indexOf("const VIEW_COPY");
  const copy = js.slice(at, js.indexOf("};", at) + 2);   // just the object literal
  for (const v of names) {
    // plain string check — a regex built from a template literal silently loses its
    // backslashes (\b becomes a backspace character), so it would match nothing
    assert.ok(copy.includes(v + ":"), `VIEW_COPY is missing an entry for "${v}"`);
  }
  // and even if one is ever missing, navigation must not throw
  assert.match(js, /VIEW_COPY\[v\] \|\|/, "showView falls back when a view has no copy");
});

test("a customer logo never replaces Joule's own mark", () => {
  // Uploading a company logo overwrote the product's own sidebar mark. A customer's
  // branding must not replace ours; it gets its own slot.
  const pb = js.slice(js.indexOf("function paintBranding"), js.indexOf("function paintBranding") + 900);
  assert.ok(pb.includes("logo-mark.png"), "the top slot always renders the Joule mark");
  assert.ok(!/slot\.innerHTML = logo/.test(pb), "the top slot is never swapped for the customer logo");
  assert.ok(pb.includes("coLogo"), "the customer logo has its own dedicated slot");
  assert.match(html, /id="coLogo"/, "that slot exists in the markup");

  // and it is sized for a real wordmark, not a 30px chip
  const co = /\.co-logo\{[^}]*\}/.exec(html);
  assert.ok(co, ".co-logo is styled");
  assert.match(co[0], /width:100%/, "full sidebar width");
  const h = /height:(\d+)px/.exec(co[0]);
  assert.ok(h && Number(h[1]) >= 48, `the logo slot is at least 48px tall (found ${h && h[1]}px)`);
  const img = /\.co-logo img\{[^}]*\}/.exec(html);
  assert.match(img[0], /object-fit:contain/, "logos are contained, never cropped or stretched");
});

test("operator env-var names are never shown to a normal customer", () => {
  // Two customer-facing messages named JOULE_ENC_KEY and SUPABASE_JWT_SECRET. A customer
  // has no access to either, can do nothing about them, and should not learn our internals.
  // Operator diagnostics are allowed, but ONLY behind an isOperator check.
  const SECRET_NAMES = ["JOULE_ENC_KEY", "JOULE_ENC_KEY_PREVIOUS", "SUPABASE_JWT_SECRET", "SUPABASE_ANON_KEY", "DATABASE_URL", "OPERATOR_EMAILS"];
  const code = js.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

  for (const name of SECRET_NAMES) {
    let from = 0, at;
    while ((at = code.indexOf(name, from)) !== -1) {
      from = at + name.length;
      // the mention must sit inside a branch gated on isOperator
      const context = code.slice(Math.max(0, at - 160), at);
      const line = code.slice(code.lastIndexOf("\n", at) + 1, at);
      if (/console\.(warn|error|log)/.test(line)) continue;   // developer console, never rendered
      assert.ok(/isOperator/.test(context),
        `"${name}" appears in customer-facing UI without an isOperator gate. Customers cannot act on deployment secrets and should not see their names.\n  context: ...${code.slice(Math.max(0, at - 120), at + 60).replace(/\s+/g, " ")}`);
    }
  }

  // and the customer-facing wording still says what to DO
  // avoid the apostrophe entirely — it is backslash-escaped in the HTML source
  assert.match(js, /read your saved provider key on this deployment/, "customer gets a plain-English cause");
  assert.match(js, /Please re-enter it below/, "and the one action they can take");
  assert.match(js, /Your session has expired\. Please sign in again\./, "session message is customer-appropriate");
});
