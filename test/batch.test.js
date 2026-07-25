"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const batch = require("../src/batch");

test("submit creates a queued job with a unique id and count", () => {
  batch.reset();
  const j1 = batch.submit(3), j2 = batch.submit(1);
  assert.equal(j1.status, "queued");
  assert.equal(j1.count, 3);
  assert.notEqual(j1.id, j2.id);
  assert.equal(batch.get(j1.id).count, 3);
  assert.equal(batch.get("nope"), null);
  assert.equal(batch.list().length, 2);
});
