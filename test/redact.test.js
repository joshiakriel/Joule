"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { redact } = require("../src/redact");

test("redacts emails, phone numbers and long digit runs", () => {
  const out = redact("email alice@example.com call +971 50 123 4567 card 4111111111111111");
  assert.ok(!out.includes("alice@example.com"));
  assert.match(out, /\[redacted-email\]/);
  assert.match(out, /\[redacted-phone\]/);
  assert.ok(!/\d{7,}/.test(out), "no long digit runs remain");
});

test("leaves ordinary text untouched and handles non-strings", () => {
  assert.equal(redact("just a normal sentence with 3 items"), "just a normal sentence with 3 items");
  assert.equal(redact(""), "");
  assert.equal(redact(undefined), undefined);
});
