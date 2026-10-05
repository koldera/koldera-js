// Licence gate over the pnpm dependency list. The packages are Apache-2.0, so everything installed must carry a
// permissive or weak-copyleft licence on this list; anything else (or unknown) fails until a person reviews it
// into EXCEPTIONS.
import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const ALLOWED = new Set([
  "MIT", "Apache-2.0", "BSD-2-Clause", "BSD-3-Clause", "ISC", "MPL-2.0", "0BSD", "CC0-1.0", "Unlicense",
  "BlueOak-1.0.0", "Python-2.0", "MIT-0", "Zlib",
]);

// Reviewed by hand: "ecosystem:name" -> why it is acceptable. Keep short.
export const EXCEPTIONS = {};

const ALIASES = [
  [/apache/i, "Apache-2.0"],
  [/^(the )?mit license$|opensource\.org\/licen[sc]es\/mit/i, "MIT"],
  [/new bsd|bsd[- ]3|3-clause/i, "BSD-3-Clause"],
  [/simplified bsd|bsd[- ]2|2-clause/i, "BSD-2-Clause"],
  [/mozilla public license.*2/i, "MPL-2.0"],
];

export function normalizeLicence(raw) {
  const text = String(raw ?? "").trim();
  if (!text) return "";
  if (/^[A-Za-z0-9.+-]+$/.test(text)) return text;
  for (const [re, id] of ALIASES) {
    if (re.test(text)) return id;
  }
  return text;
}

const EXPRESSION = /^\(?[A-Za-z0-9.+-]+\)?(\s+(AND|OR)\s+\(?[A-Za-z0-9.+-]+\)?)*$/;

// "(A OR B) AND C": OR binds looser than AND, parentheses nest. Returns the first disallowed id, or null if it passes.
function failing(expression) {
  const tokens = expression.replace(/\(/g, " ( ").replace(/\)/g, " ) ").split(/\s+/).filter(Boolean);
  let i = 0;
  const orExpr = () => {
    let bad = andExpr();
    while (tokens[i] === "OR") { i++; const next = andExpr(); bad = bad === null || next === null ? null : bad; }
    return bad;
  };
  const andExpr = () => {
    let bad = atom();
    while (tokens[i] === "AND") { i++; const next = atom(); bad = bad ?? next; }
    return bad;
  };
  const atom = () => {
    const t = tokens[i++];
    if (t === "(") { const r = orExpr(); i++; return r; }
    const id = normalizeLicence(t);
    return ALLOWED.has(id) ? null : id;
  };
  const result = orExpr();
  return i < tokens.length ? expression : result;
}

export function evaluate(entries, { exceptions = EXCEPTIONS } = {}) {
  const out = [];
  for (const e of entries) {
    if (exceptions[`${e.ecosystem}:${e.name}`]) continue;
    const expr = (e.license ?? "").trim();
    if (!expr) { out.push({ ...e, reason: "licence unknown" }); continue; }
    const bad = EXPRESSION.test(expr) ? failing(expr) : (ALLOWED.has(normalizeLicence(expr)) ? null : expr);
    if (bad !== null) out.push({ ...e, reason: `licence not allowed: ${bad}` });
  }
  return out;
}

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function npmEntries() {
  const out = execFileSync("pnpm", ["licenses", "list", "--json"], { cwd: root, encoding: "utf8", maxBuffer: 1 << 28, shell: process.platform === "win32" });
  return Object.entries(JSON.parse(out)).flatMap(([license, pkgs]) => pkgs.map((p) => ({ ecosystem: "npm", name: p.name, version: (p.versions ?? [p.version]).join(","), license })));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const entries = npmEntries();
  const bad = evaluate(entries);
  console.log(`${entries.length} dependencies checked`);
  for (const v of bad) console.error(`${v.ecosystem}:${v.name}@${v.version}: ${v.reason}`);
  process.exit(bad.length ? 1 : 0);
}
