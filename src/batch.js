"use strict";

/**
 * In-memory batch-job store (savings-hierarchy #2). `POST /v1/batch` submits a job
 * that is processed asynchronously; `GET /v1/batch/:id` polls status/results. The
 * actual per-item routing/metering (at the batch discount) happens in server.js —
 * this module just tracks job lifecycle. Ephemeral (single-node MVP).
 */

let jobs = new Map();
let seq = 0;

function reset() { jobs = new Map(); seq = 0; }

function submit(count) {
  const id = "batch-" + Date.now().toString(36) + "-" + (seq++).toString(36);
  const job = { id, status: "queued", count, completed: 0, results: [], totals: null, createdAt: Date.now(), error: null };
  jobs.set(id, job);
  return job;
}

const get = (id) => jobs.get(id) || null;
const list = () => [...jobs.values()].map((j) => ({ id: j.id, status: j.status, count: j.count, completed: j.completed }));

module.exports = { reset, submit, get, list, _jobs: () => jobs };
