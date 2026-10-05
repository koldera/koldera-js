import test from "node:test";
import assert from "node:assert/strict";
import { evaluate, normalizeLicence } from "./check-licences.mjs";

const entry = (name, license) => ({ ecosystem: "npm", name, version: "1.0.0", license });

test("MIT and Apache-2.0 pass, GPL-2.0-only is reported", () => {
  const bad = evaluate([entry("a", "MIT"), entry("b", "Apache-2.0"), entry("c", "GPL-2.0-only")]);
  assert.deepEqual(bad.map((v) => v.name), ["c"]);
  assert.equal(bad[0].reason, "licence not allowed: GPL-2.0-only");
});

test("an OR expression passes when one alternative is allowed, AND needs all", () => {
  assert.deepEqual(evaluate([entry("a", "(MIT OR GPL-3.0-only)")]), []);
  assert.deepEqual(evaluate([entry("a", "MIT AND GPL-3.0-only")]).map((v) => v.name), ["a"]);
  assert.deepEqual(evaluate([entry("a", "(MIT AND Zlib) OR Apache-2.0")]), []);
});

test("missing or unknown licences fail, a reviewed exception passes", () => {
  assert.equal(evaluate([entry("a", "")])[0].reason, "licence unknown");
  assert.equal(evaluate([entry("a", "SEE LICENSE IN LICENSE.txt")])[0].reason, "licence not allowed: SEE LICENSE IN LICENSE.txt");
  assert.deepEqual(evaluate([entry("a", "")], { exceptions: { "npm:a": "reviewed: MIT text" } }), []);
});

test("the AGPL and LGPL families are not allowed for an Apache-2.0 package", () => {
  assert.equal(evaluate([entry("a", "AGPL-3.0-only")]).length, 1);
  assert.equal(evaluate([entry("a", "LGPL-3.0")]).length, 1);
});

test("free-form names are normalised", () => {
  assert.equal(normalizeLicence("The Apache Software License, Version 2.0"), "Apache-2.0");
  assert.equal(normalizeLicence("MIT-0"), "MIT-0");
});
