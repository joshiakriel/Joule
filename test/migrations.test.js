"use strict";
/**
 * Migration safety — offline, no database required.
 *
 * These exist because a real deploy silently broke: migration 004 used
 * CREATE OR REPLACE FUNCTION to widen the return type of a function defined in 003.
 * Postgres refuses that ("cannot change return type of existing function"), and because
 * each migration file is executed as ONE multi-statement query, the failure rolled back
 * the entire file — so the ALTER TABLEs in it never applied either. The service still
 * reported a successful build and booted "live", but identity hydration failed, every
 * stored key looked missing, and users were sent back through setup on every login.
 */
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const DIR = path.join(__dirname, "..", "migrations");
const files = fs.readdirSync(DIR).filter((f) => f.endsWith(".sql")).sort();
const sqlOf = (f) => fs.readFileSync(path.join(DIR, f), "utf8");
const stripComments = (s) => s.replace(/--[^\n]*/g, "");

// name -> the return clause of each definition, in migration order
function definitions() {
  const defs = new Map();
  for (const f of files) {
    const sql = stripComments(sqlOf(f));
    const re = /CREATE\s+(?:OR\s+REPLACE\s+)?FUNCTION\s+([a-z0-9_]+)\s*\(([^)]*)\)\s*RETURNS\s+([^]*?)\s+LANGUAGE/gi;
    let m;
    while ((m = re.exec(sql))) {
      const [, name, args, ret] = m;
      if (!defs.has(name)) defs.set(name, []);
      defs.get(name).push({ file: f, args: args.trim(), ret: ret.replace(/\s+/g, " ").trim(), sql });
    }
  }
  return defs;
}

test("migration files exist and are applied in a stable, sorted order", () => {
  assert.ok(files.length >= 1, "there are migrations");
  assert.deepEqual(files, [...files].sort(), "filenames sort into their intended apply order");
  for (const f of files) assert.match(f, /^\d{3}_/, `${f} is numbered so ordering is unambiguous`);
});

test("a function whose RETURN TYPE changes is DROPped before being recreated", () => {
  for (const [name, list] of definitions()) {
    for (let i = 1; i < list.length; i++) {
      const prev = list[i - 1], cur = list[i];
      if (prev.ret === cur.ret) continue;                 // unchanged signature: replace is fine
      // Postgres cannot change a return type in place — the redefinition MUST drop first,
      // in the same file, before the CREATE.
      const before = cur.sql.slice(0, cur.sql.indexOf("CREATE FUNCTION " + name) >= 0
        ? cur.sql.indexOf("CREATE FUNCTION " + name)
        : cur.sql.search(new RegExp("CREATE\\s+(OR\\s+REPLACE\\s+)?FUNCTION\\s+" + name)));
      assert.match(before, new RegExp("DROP\\s+FUNCTION\\s+IF\\s+EXISTS\\s+" + name, "i"),
        `${cur.file}: ${name}() changes its return type (${prev.ret} -> ${cur.ret}) so it must be ` +
        `DROPped first — CREATE OR REPLACE cannot change a return type and would abort the whole file`);
    }
  }
});

test("every statement is idempotent — migrations run on every boot", () => {
  for (const f of files) {
    const sql = stripComments(sqlOf(f));
    for (const m of sql.matchAll(/CREATE\s+TABLE\s+(?!IF\s+NOT\s+EXISTS)/gi)) {
      assert.fail(`${f}: CREATE TABLE must be IF NOT EXISTS (migrations re-run on every boot)`);
    }
    for (const m of sql.matchAll(/ALTER\s+TABLE\s+\w+\s+ADD\s+COLUMN\s+(?!IF\s+NOT\s+EXISTS)/gi)) {
      assert.fail(`${f}: ADD COLUMN must be IF NOT EXISTS`);
    }
    for (const m of sql.matchAll(/CREATE\s+INDEX\s+(?!IF\s+NOT\s+EXISTS)/gi)) {
      assert.fail(`${f}: CREATE INDEX must be IF NOT EXISTS`);
    }
  }
});

test("the loader functions the app queries actually return the columns it selects", () => {
  // pgstore selects specific columns from the SECURITY DEFINER loaders. If a migration
  // widens the query but not the function, boot fails with 'column ... does not exist'.
  const pg = fs.readFileSync(path.join(__dirname, "..", "src", "pgstore.js"), "utf8");
  const defs = definitions();
  const latestRet = (name) => { const l = defs.get(name); return l ? l[l.length - 1].ret : null; };

  for (const m of pg.matchAll(/SELECT\s+([a-z0-9_,\s]+?)\s+FROM\s+(app_load_[a-z_]+)\(\)/gi)) {
    const cols = m[1].split(",").map((c) => c.trim()).filter(Boolean);
    const ret = latestRet(m[2]);
    assert.ok(ret, `${m[2]}() is defined in a migration`);
    for (const c of cols) {
      assert.ok(new RegExp("\\b" + c + "\\b").test(ret),
        `pgstore selects "${c}" from ${m[2]}() but the function's final definition returns: ${ret}`);
    }
  }
});
