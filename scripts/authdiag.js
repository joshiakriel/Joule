"use strict";
/**
 * Auth diagnosis harness. Builds realistically-shaped tokens and reports exactly why
 * each is accepted or rejected. Never prints tokens, signatures or secrets.
 *   node scripts/authdiag.js
 */
process.env.SUPABASE_JWT_SECRET = process.env.SUPABASE_JWT_SECRET || "legacy-shared-secret-example";
const crypto = require("crypto");
const config = require("../src/config");
const tenancy = require("../src/tenancy");

const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
function sign(header, payload, secret, alg) {
  const h = b64(header), p = b64(payload);
  if (alg === "none") return `${h}.${p}.`;
  const sig = crypto.createHmac("sha256", secret).update(h + "." + p).digest("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  return `${h}.${p}.${sig}`;
}

const SECRET = config.auth.jwtSecret;
const PROJECT = "https://abcdefgh.supabase.co/auth/v1";
const now = Math.floor(Date.now() / 1000);

// exactly what a real Supabase email/password session token looks like
const supabaseClaims = {
  iss: PROJECT, aud: "authenticated", sub: "8f2b1c44-0000-4444-9999-1a2b3c4d5e6f",
  email: "you@company.com", role: "authenticated", exp: now + 3600, iat: now,
  app_metadata: { provider: "email", providers: ["email"] },   // NOTE: no tenant_id
  user_metadata: {}, session_id: "sess-123"
};

const cases = [
  ["No Authorization header at all", null],
  ["Real Supabase token, correct legacy HS256 secret", "Bearer " + sign({ alg: "HS256", typ: "JWT" }, supabaseClaims, SECRET)],
  ["Asymmetric-signed token (new Supabase default, has kid)", "Bearer " + sign({ alg: "ES256", typ: "JWT", kid: "a1b2c3d4-e5f6-7890-abcd-ef1234567890" }, supabaseClaims, SECRET)],
  ["Correct secret BUT tenant_id present in app_metadata", "Bearer " + sign({ alg: "HS256", typ: "JWT" }, { ...supabaseClaims, app_metadata: { ...supabaseClaims.app_metadata, tenant_id: "11111111-1111-1111-1111-111111111111" } }, SECRET)],
  ["Wrong secret", "Bearer " + sign({ alg: "HS256", typ: "JWT" }, supabaseClaims, "some-other-secret")],
  ["Expired token", "Bearer " + sign({ alg: "HS256", typ: "JWT" }, { ...supabaseClaims, exp: now - 60 }, SECRET)],
  ["Anon key sent by mistake (role=anon)", "Bearer " + sign({ alg: "HS256", typ: "JWT" }, { iss: PROJECT, role: "anon", aud: "authenticated", exp: now + 3600 }, SECRET)]
];

const F = (v) => (v === null || v === undefined ? "—" : String(v));
console.log("\nSECRET loaded: %s (length %d)\n", SECRET ? "yes" : "NO", SECRET ? SECRET.length : 0);
console.log(["case", "tok?", "alg", "kid?", "aud", "role", "tenant?", "reason"].join(" | "));
console.log("-".repeat(150));
for (const [name, hdr] of cases) {
  const d = tenancy.diagnoseJwt(hdr);
  console.log([
    name.padEnd(52), d.present ? "yes" : "no", F(d.alg).padEnd(5),
    d.kid ? "yes" : "no", F(d.aud).padEnd(13), F(d.role).padEnd(13),
    d.tenantResolvable ? "yes" : "no", F(d.reason)
  ].join(" | "));
}
console.log("\nVerifier checks issuer/audience? %s", /payload\.iss|payload\.aud/.test(require("fs").readFileSync(require("path").join(__dirname, "..", "src", "tenancy.js"), "utf8").split("function verifyJwt")[1].split("function resolveFromJwt")[0]) ? "YES" : "NO — neither is enforced");
console.log("Secret used as: raw UTF-8 string (not base64-decoded)\n");
