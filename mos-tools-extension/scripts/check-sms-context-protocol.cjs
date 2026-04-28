#!/usr/bin/env node
/**
 * Lint check: every SMS adapter MUST push side-panel context updates as
 *
 *     chrome.runtime.sendMessage({ action: "SET_SMS_CONTEXT", context })
 *
 * background.js's SMS context handler ONLY listens for that exact shape,
 * so a drift like { type: "SMS_CONTEXT_UPDATE", context } (the Autoflow
 * regression caught in task #159) is silently dropped — the side panel
 * just sits on "Loading VHI…" forever and nothing logs.
 *
 * Rules enforced
 * --------------
 * For every file matching mos-tools-extension/adapters/*-content.js:
 *
 *   R1. No identifier or string literal may contain "SMS_CONTEXT" except
 *       the documented protocol names:
 *         - SET_SMS_CONTEXT       (adapter -> background, context push)
 *         - GET_SMS_CONTEXT       (sidepanel -> background, context query)
 *         - SMS_CONTEXT_CHANGED   (background -> sidepanel, broadcast)
 *       This catches drift like SMS_CONTEXT_UPDATE / UPDATE_SMS_CONTEXT.
 *
 *   R2. Every call-position object literal that has a top-level `context`
 *       property MUST use `action:` (not `type:`) as its discriminator
 *       and MUST set `action:` to a string literal. This is the same
 *       message shape every other handler in background.js uses.
 *       Adapters often wrap chrome.runtime.sendMessage in helpers like
 *       safeSendMessage(...), so the check is callee-agnostic.
 *
 *   R3. The file must contain at least one call-position object literal
 *       with `{ action: "SET_SMS_CONTEXT", ... context ... }`. An adapter
 *       that never pushes SET_SMS_CONTEXT can never feed the side panel,
 *       so it's almost certainly broken.
 *
 * For mos-tools-extension/background.js:
 *
 *   R4. The file must still handle  message.action === "SET_SMS_CONTEXT".
 *       If anyone renames the handler, every adapter breaks at once and
 *       this check trips before the build ships.
 *
 * Adapters can opt out of R3 (e.g. a future read-only adapter) by adding
 * a top-of-file marker comment within the first 5 lines:
 *
 *     // sms-context-exempt: <reason>
 *
 * Usage:
 *   node mos-tools-extension/scripts/check-sms-context-protocol.cjs
 *
 * Exit codes:
 *   0 — contract holds
 *   1 — one or more violations
 *   2 — script error (missing dirs, etc.)
 */

const fs = require("fs");
const path = require("path");

const REPO_ROOT = path.resolve(__dirname, "..", "..");
const EXT_ROOT = path.resolve(__dirname, "..");
const ADAPTERS_DIR = path.join(EXT_ROOT, "adapters");
const BACKGROUND_FILE = path.join(EXT_ROOT, "background.js");

const REQUIRED_ACTION = "SET_SMS_CONTEXT";
const ALLOWED_SMS_CONTEXT_TOKENS = new Set([
  "SET_SMS_CONTEXT",
  "GET_SMS_CONTEXT",
  "SMS_CONTEXT_CHANGED",
]);
const EXEMPT_HEADER_LINES = 5;
const EXEMPT_MARKER = /^\s*\/\/\s*sms-context-exempt:\s*\S/;

// ------------------------------------------------------------------
// Source preprocessing
// ------------------------------------------------------------------

/**
 * Strip JS line and block comments so checks like "no stray SMS_CONTEXT
 * references" don't trip on intentional warning comments that mention
 * the forbidden names. String literals are preserved verbatim — the
 * whole point of the check is what gets sent on the wire.
 */
function stripComments(src) {
  let out = "";
  let i = 0;
  const n = src.length;
  while (i < n) {
    const c = src[i];
    const next = src[i + 1];
    if (c === "/" && next === "/") {
      while (i < n && src[i] !== "\n") i++;
      continue;
    }
    if (c === "/" && next === "*") {
      i += 2;
      while (i < n && !(src[i] === "*" && src[i + 1] === "/")) i++;
      i += 2;
      continue;
    }
    if (c === "'" || c === '"' || c === "`") {
      const quote = c;
      out += c;
      i++;
      while (i < n) {
        out += src[i];
        if (src[i] === "\\" && i + 1 < n) {
          out += src[i + 1];
          i += 2;
          continue;
        }
        if (src[i] === quote) { i++; break; }
        i++;
      }
      continue;
    }
    out += c;
    i++;
  }
  return out;
}

function lineNumberOf(src, index) {
  let line = 1;
  for (let i = 0; i < index && i < src.length; i++) {
    if (src[i] === "\n") line++;
  }
  return line;
}

// ------------------------------------------------------------------
// Find call-position object literals: <callee>( { ... }
// ------------------------------------------------------------------

/**
 * Tokenize the source into (kind, start, end) regions where kind is
 * "code" or "string". Properly handles single/double quotes, template
 * literals, AND nested ${ ... } interpolations (which return to "code"
 * mode and can themselves contain more strings/templates).
 *
 * This matters because adapter content scripts (e.g. autoflow) embed
 * page-sniffer code in big template literals with ${function() { ... }}
 * interpolations that contain quoted strings — a naive brace counter
 * loses track and starts seeing apparent calls inside string content.
 */
function tokenize(src) {
  const regions = [];
  const n = src.length;
  let i = 0;
  let regionStart = 0;
  let regionKind = "code";

  // mode stack: each entry is "code" or a string delimiter ("'" / '"' / "`")
  const stack = ["code"];
  // last non-whitespace code char we saw — used to disambiguate regex vs /
  let lastCodeChar = "";

  function flush(end) {
    if (end > regionStart) {
      regions.push({ kind: regionKind, start: regionStart, end });
    }
    regionStart = end;
  }
  function setMode(kind) {
    regionKind = kind;
  }

  // tokens after which `/` begins a regex literal (everything else is division)
  const REGEX_PRECEDERS = new Set([
    "", "(", ",", "=", "!", "&", "|", "?", ":", ";", "[", "{", "+", "-",
    "*", "%", "<", ">", "^", "~", "}",
  ]);
  const REGEX_PRECEDING_KEYWORDS = new Set([
    "return", "typeof", "instanceof", "in", "of", "delete", "void", "new",
    "throw", "yield", "await", "do", "else",
  ]);

  function precedingKeyword() {
    // walk back through code chars only (within current region) for a word
    let j = i - 1;
    while (j >= regionStart && /\s/.test(src[j])) j--;
    if (j < regionStart || !/[A-Za-z_$]/.test(src[j])) return "";
    const end = j + 1;
    while (j >= regionStart && /[A-Za-z0-9_$]/.test(src[j])) j--;
    return src.slice(j + 1, end);
  }

  while (i < n) {
    const top = stack[stack.length - 1];
    const c = src[i];

    if (top === "code") {
      // entering a string?
      if (c === "'" || c === '"' || c === "`") {
        flush(i);
        stack.push(c);
        setMode("string");
        i++;
        lastCodeChar = "";
        continue;
      }
      // closing a ${ ... } interpolation?
      if (c === "}" && stack.length > 1 && stack[stack.length - 2] !== "code") {
        // include this `}` in the code region so brace counting balances
        // with the `{` from the matching `${` (which is also in code).
        i++;
        flush(i);
        stack.pop(); // pop "code"
        // we stay inside the template (top is now "`")
        setMode("string");
        lastCodeChar = "";
        continue;
      }
      // regex literal? `/` after certain operators / keywords / nothing.
      if (c === "/" && src[i + 1] !== "/" && src[i + 1] !== "*") {
        const startsRegex =
          REGEX_PRECEDERS.has(lastCodeChar) ||
          REGEX_PRECEDING_KEYWORDS.has(precedingKeyword());
        if (startsRegex) {
          // skip /.../[flags] — handle [...] char classes (which may contain
          // unescaped /) and \ escapes. Stays in code region (regex bodies
          // are not strings for our purposes).
          i++;
          let inClass = false;
          while (i < n) {
            const ch = src[i];
            if (ch === "\\" && i + 1 < n) { i += 2; continue; }
            if (ch === "[" && !inClass) { inClass = true; i++; continue; }
            if (ch === "]" && inClass) { inClass = false; i++; continue; }
            if (ch === "/" && !inClass) { i++; break; }
            if (ch === "\n") break; // unterminated regex, give up
            i++;
          }
          // skip flags
          while (i < n && /[a-zA-Z]/.test(src[i])) i++;
          lastCodeChar = "/";
          continue;
        }
      }
      if (!/\s/.test(c)) lastCodeChar = c;
      i++;
      continue;
    }

    // inside a string
    if (c === "\\") { i += 2; continue; }
    if (c === top) {
      // closing this string
      i++;
      flush(i);
      stack.pop();
      setMode(stack[stack.length - 1] === "code" ? "code" : "string");
      lastCodeChar = top; // closing quote is "operand-like" — / would be div
      continue;
    }
    if (top === "`" && c === "$" && src[i + 1] === "{") {
      // entering interpolation — flush template region, push "code"
      flush(i);
      stack.push("code");
      setMode("code");
      i += 2;
      lastCodeChar = "{";
      continue;
    }
    i++;
  }
  flush(n);
  return regions;
}

/**
 * Walk the source and yield every object literal that appears as the
 * FIRST argument to a function call. Returns
 *   [{ callee, startIndex, payload }]
 * where `payload` is the raw text of the {...} literal (braces included)
 * and `callee` is the dotted callee text (best-effort) for nicer errors.
 *
 * Uses tokenize() so we ignore parens/braces that live inside string
 * literals or template-literal text (template ${...} interpolations are
 * still scanned since they ARE code).
 */
function findCallObjectLiterals(src) {
  const regions = tokenize(src);
  const n = src.length;

  // build a per-position mask: true = code, false = inside string/template
  const isCode = new Uint8Array(n);
  for (const reg of regions) {
    if (reg.kind === "code") {
      for (let p = reg.start; p < reg.end; p++) isCode[p] = 1;
    }
  }

  const calls = [];
  let i = 0;
  while (i < n) {
    if (!isCode[i] || src[i] !== "(") { i++; continue; }

    // walk back from '(' through code-only chars to find a callee
    let j = i - 1;
    while (j >= 0 && isCode[j] && /\s/.test(src[j])) j--;
    if (j < 0 || !isCode[j] || !/[A-Za-z0-9_$\]]/.test(src[j])) { i++; continue; }
    const calleeEnd = j + 1;
    while (j >= 0 && isCode[j] && /[A-Za-z0-9_$.\]\[]/.test(src[j])) j--;
    const callee = src.slice(j + 1, calleeEnd);

    // first arg must be `{`
    let k = i + 1;
    while (k < n && isCode[k] && /\s/.test(src[k])) k++;
    if (k >= n || !isCode[k] || src[k] !== "{") { i++; continue; }

    // walk balanced braces — only counting braces that live in code
    const objStart = k;
    let depth = 0;
    let endIdx = -1;
    for (let p = k; p < n; p++) {
      if (!isCode[p]) continue;
      const ch = src[p];
      if (ch === "{") depth++;
      else if (ch === "}") {
        depth--;
        if (depth === 0) { endIdx = p; break; }
      }
    }
    if (endIdx === -1) { i++; continue; }

    calls.push({
      callee,
      startIndex: i,
      payload: src.slice(objStart, endIdx + 1),
    });
    i = endIdx + 1;
  }
  return calls;
}

/** Does the object literal `payload` have a top-level property `key`? */
function hasTopLevelKey(payload, key) {
  let depth = 0;
  let inStr = null;
  for (let i = 0; i < payload.length; i++) {
    const c = payload[i];
    if (inStr) {
      if (c === "\\") { i++; continue; }
      if (c === inStr) inStr = null;
      continue;
    }
    if (c === "'" || c === '"' || c === "`") { inStr = c; continue; }
    if (c === "{") { depth++; continue; }
    if (c === "}") { depth--; continue; }
    if (depth !== 1) continue;
    if (i > 0 && /[A-Za-z0-9_$]/.test(payload[i - 1])) continue;
    if (payload.slice(i, i + key.length) !== key) continue;
    const after = payload[i + key.length];
    if (after && /[A-Za-z0-9_$]/.test(after)) continue;
    let j = i + key.length;
    while (j < payload.length && /\s/.test(payload[j])) j++;
    if (payload[j] === ":") return true;
    if (payload[j] === "," || payload[j] === "}") return true; // shorthand
  }
  return false;
}

/** Get the string-literal value of top-level `key:` on the payload, if any. */
function getTopLevelStringProp(payload, key) {
  let depth = 0;
  let inStr = null;
  for (let i = 0; i < payload.length; i++) {
    const c = payload[i];
    if (inStr) {
      if (c === "\\") { i++; continue; }
      if (c === inStr) inStr = null;
      continue;
    }
    if (c === "'" || c === '"' || c === "`") { inStr = c; continue; }
    if (c === "{") { depth++; continue; }
    if (c === "}") { depth--; continue; }
    if (depth !== 1) continue;
    if (i > 0 && /[A-Za-z0-9_$]/.test(payload[i - 1])) continue;
    if (payload.slice(i, i + key.length) !== key) continue;
    const after = payload[i + key.length];
    if (after && /[A-Za-z0-9_$]/.test(after)) continue;
    let j = i + key.length;
    while (j < payload.length && /\s/.test(payload[j])) j++;
    if (payload[j] !== ":") continue;
    j++;
    while (j < payload.length && /\s/.test(payload[j])) j++;
    const quote = payload[j];
    if (quote !== "'" && quote !== '"' && quote !== "`") return null;
    let val = "";
    j++;
    while (j < payload.length && payload[j] !== quote) {
      if (payload[j] === "\\" && j + 1 < payload.length) { val += payload[j + 1]; j += 2; continue; }
      val += payload[j];
      j++;
    }
    return val;
  }
  return null;
}

// ------------------------------------------------------------------
// Per-file checks
// ------------------------------------------------------------------

function checkAdapter(filePath) {
  const violations = [];
  const rawSrc = fs.readFileSync(filePath, "utf8");
  const rel = path.relative(REPO_ROOT, filePath);

  const headerLines = rawSrc.split("\n").slice(0, EXEMPT_HEADER_LINES);
  const exempt = headerLines.some((l) => EXEMPT_MARKER.test(l));

  const src = stripComments(rawSrc);

  // R1. forbidden SMS_CONTEXT references — allow only the documented
  //     protocol token names.
  const tokenRe = /[A-Za-z_][A-Za-z0-9_]*/g;
  let tm;
  while ((tm = tokenRe.exec(src)) !== null) {
    const tok = tm[0];
    if (!tok.includes("SMS_CONTEXT")) continue;
    if (ALLOWED_SMS_CONTEXT_TOKENS.has(tok)) continue;
    violations.push({
      file: rel,
      line: lineNumberOf(src, tm.index),
      rule: "R1",
      msg:
        `forbidden token "${tok}" — the only allowed SMS_CONTEXT names ` +
        `are ${[...ALLOWED_SMS_CONTEXT_TOKENS].join(", ")}. background.js ` +
        `only listens for those exact strings; any other spelling is ` +
        `silently dropped.`,
    });
  }

  // R2 + R3. scan every call-position object literal in the file.
  const calls = findCallObjectLiterals(src);
  let sawSetSmsContext = false;
  for (const call of calls) {
    if (!hasTopLevelKey(call.payload, "context")) continue;
    const usesType = hasTopLevelKey(call.payload, "type");
    const action = getTopLevelStringProp(call.payload, "action");
    const line = lineNumberOf(src, call.startIndex);
    const calleeLabel = call.callee || "<call>";

    if (usesType) {
      violations.push({
        file: rel,
        line,
        rule: "R2",
        msg:
          `${calleeLabel}({...}) payload uses "type:" as its discriminator ` +
          `but background.js only listens for "action:". Use ` +
          `{ action: "${REQUIRED_ACTION}", context } instead.`,
      });
      continue;
    }
    if (action === null) {
      violations.push({
        file: rel,
        line,
        rule: "R2",
        msg:
          `${calleeLabel}({...}) payload has a "context" property but no ` +
          `string-literal "action:" key. Use ` +
          `{ action: "${REQUIRED_ACTION}", context } so background.js can ` +
          `route it.`,
      });
      continue;
    }
    if (action === REQUIRED_ACTION) sawSetSmsContext = true;
  }

  if (!exempt && !sawSetSmsContext) {
    violations.push({
      file: rel,
      line: 1,
      rule: "R3",
      msg:
        `adapter never sends { action: "${REQUIRED_ACTION}", context } via ` +
        `chrome.runtime.sendMessage (or any wrapper of it). The side panel ` +
        `can never receive shop / RO / VIN context from this adapter. ` +
        `Add the call, or opt out with a top-of-file ` +
        `"// sms-context-exempt: <reason>" marker.`,
    });
  }

  return violations;
}

function checkBackground() {
  const violations = [];
  if (!fs.existsSync(BACKGROUND_FILE)) {
    return [{
      file: path.relative(REPO_ROOT, BACKGROUND_FILE),
      line: 0,
      rule: "R4",
      msg: `background.js not found at expected path.`,
    }];
  }
  const src = stripComments(fs.readFileSync(BACKGROUND_FILE, "utf8"));
  const rel = path.relative(REPO_ROOT, BACKGROUND_FILE);
  const re = /message\s*\.\s*action\s*===\s*(['"])SET_SMS_CONTEXT\1/;
  if (!re.test(src)) {
    violations.push({
      file: rel,
      line: 0,
      rule: "R4",
      msg:
        `background.js no longer handles message.action === ` +
        `"${REQUIRED_ACTION}". Every SMS adapter posts to that exact ` +
        `action; if the handler is removed or renamed, every side panel ` +
        `goes dark. Restore the handler or update this check (and every ` +
        `adapter) in lockstep.`,
    });
  }
  return violations;
}

// ------------------------------------------------------------------
// Main
// ------------------------------------------------------------------

function listAdapterFiles() {
  if (!fs.existsSync(ADAPTERS_DIR)) {
    console.error(`[check-sms-context-protocol] no adapters dir at ${ADAPTERS_DIR}`);
    process.exit(2);
  }
  return fs
    .readdirSync(ADAPTERS_DIR)
    .filter((f) => /-content\.js$/.test(f))
    .map((f) => path.join(ADAPTERS_DIR, f))
    .sort();
}

function main() {
  const adapters = listAdapterFiles();
  if (adapters.length === 0) {
    console.error(
      `[check-sms-context-protocol] no *-content.js adapters found in ${ADAPTERS_DIR}`,
    );
    process.exit(2);
  }

  const violations = [];
  for (const file of adapters) {
    violations.push(...checkAdapter(file));
  }
  violations.push(...checkBackground());

  if (violations.length === 0) {
    console.log(
      `[check-sms-context-protocol] OK — ${adapters.length} adapter(s) ` +
        `+ background.js conform to the SET_SMS_CONTEXT contract.`,
    );
    process.exit(0);
  }

  console.error(
    `[check-sms-context-protocol] FAIL — ${violations.length} violation(s):\n`,
  );
  for (const v of violations) {
    console.error(`  • ${v.file}:${v.line}  [${v.rule}]  ${v.msg}\n`);
  }
  process.exit(1);
}

main();
