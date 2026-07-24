"use strict";

/**
 * Minimal, dependency-free PII redaction applied BEFORE any text is logged (only
 * relevant when LOG_PROMPTS=true). Not a compliance guarantee — a safety net.
 * Covers emails, phone numbers, and long digit sequences (card/ID-like).
 */
const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
const PHONE = /(?:\+?\d[\d\s().-]{7,}\d)/g;   // 9+ digits with common separators
const LONGNUM = /\b\d{7,}\b/g;                // long bare digit runs

function redact(text) {
  if (typeof text !== "string" || !text) return text;
  return text
    .replace(EMAIL, "[redacted-email]")
    .replace(PHONE, "[redacted-phone]")
    .replace(LONGNUM, "[redacted-number]");
}

module.exports = { redact };
