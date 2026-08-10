"use strict";
/**
 * REGRESSION GUARD — the dashboard must actually RUN, not merely parse.
 *
 * A `new Function(js)` syntax check passes on code that throws the instant it executes.
 * That is exactly what shipped in the 2.0/2.1 release: boot code called showView() above
 * the `const VIEWS` declaration it depends on. Function declarations hoist, `const` does
 * not, so it threw a temporal-dead-zone ReferenceError at load, killing the whole script.
 * Every [data-view] panel stayed hidden and the deployed page rendered blank.
 *
 * These tests execute the dashboard's real script against a stub DOM and assert it boots
 * cleanly — including when the API returns error/partial payloads instead of good data.
 */
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const html = fs.readFileSync(path.join(__dirname, "..", "public", "index.html"), "utf8");
const blocks = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
const ids = new Set([...html.matchAll(/id="([^"]+)"/g)].map((m) => m[1]));

// Minimal DOM stub: getElementById resolves only IDs that genuinely exist in the markup,
// so a typo'd or removed element surfaces here as a real TypeError instead of in production.
function makeEnv(fetchImpl) {
  const cache = new Map();
  const el = (id) => ({
    id, style: {}, dataset: {}, value: "", checked: false,
    classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
    set innerHTML(_v) {}, get innerHTML() { return ""; },
    set textContent(_v) {}, get textContent() { return ""; },
    appendChild() {}, setAttribute() {}, removeAttribute() {}, addEventListener() {},
    querySelectorAll: () => [], querySelector: () => null, focus() {}, click() {}, remove() {}
  });
  const get = (id) => (ids.has(id) ? (cache.get(id) || (cache.set(id, el(id)), cache.get(id))) : null);
  const doc = {
    getElementById: get, querySelectorAll: () => [], querySelector: () => null,
    addEventListener() {}, createElement: () => el("new"), body: el("body")
  };
  const win = {
    addEventListener() {}, scrollTo() {}, location: { hash: "", origin: "http://test.local" },
    document: doc, fetch: fetchImpl
  };
  return {
    window: win, document: doc, location: win.location, navigator: { clipboard: { writeText: async () => {} } },
    fetch: fetchImpl, setInterval: () => 0, setTimeout: () => 0, clearInterval: () => {},
    alert: () => {}, confirm: () => true, performance: { now: () => 0 }, console
  };
}

// Run every inline <script> in order with the given fetch behaviour; returns any throw.
function boot(fetchImpl) {
  const env = makeEnv(fetchImpl);
  const names = Object.keys(env), vals = names.map((n) => env[n]);
  for (const b of blocks) {
    try { new Function(...names, b)(...vals); }
    catch (e) { return e; }
  }
  return null;
}

const okJson = (body) => async () => ({ ok: true, status: 200, json: async () => body, text: async () => "", headers: { get: () => null } });

test("the dashboard script BOOTS without throwing (guards against the blank-page regression)", () => {
  const err = boot(okJson({}));
  assert.equal(err, null, err ? `dashboard threw at load: ${err.constructor.name}: ${err.message}` : "");
});

test("no top-level invocation runs before the const/let declarations it depends on", () => {
  // Locate the boot calls and every top-level const/let they read. Any boot call that
  // appears BEFORE its declaration is a temporal-dead-zone crash waiting to happen.
  const js = blocks.join("\n");
  const bootCall = js.indexOf("showView((location.hash");
  assert.ok(bootCall > 0, "the boot call exists");
  for (const decl of ["const VIEWS", "let CURRENT_VIEW", "let AUTH_CFG", "let ACCESS_TOKEN"]) {
    const at = js.indexOf(decl);
    assert.ok(at > 0, `${decl} exists`);
    assert.ok(at < bootCall, `${decl} must be declared BEFORE the boot call (TDZ crash otherwise)`);
  }
});

test("boots cleanly when the API returns 401/error bodies (a parsed error is not a payload)", () => {
  // An auth error still parses as valid JSON — the UI must not assume success.
  const err = boot(okJson({ error: { message: "unauthenticated", code: "unauthenticated" } }));
  assert.equal(err, null, err ? `threw on an error payload: ${err.message}` : "");
});

test("boots cleanly on partial/garbage payloads without blanking the page", () => {
  for (const body of [null, {}, { totals: null }, { empty: false }, { lifetime: {} }, []]) {
    const err = boot(okJson(body));
    assert.equal(err, null, err ? `threw on payload ${JSON.stringify(body)}: ${err.message}` : "");
  }
});

test("boots cleanly when the API is unreachable entirely", () => {
  const err = boot(async () => { throw new Error("network down"); });
  assert.equal(err, null, err ? `threw when offline: ${err.message}` : "");
});
