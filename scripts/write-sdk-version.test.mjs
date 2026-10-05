import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { manifest, target, versionSource } from "./write-sdk-version.mjs";

test("the generated version file holds the version of packages/sdk/package.json", () => {
  const { version } = JSON.parse(readFileSync(manifest, "utf8"));
  assert.equal(readFileSync(target, "utf8"), versionSource(version));
});

test("the source quotes the version", () => {
  assert.match(versionSource("1.2.3-rc.1"), /SDK_VERSION = "1\.2\.3-rc\.1";/);
});

test("http.ts imports the generated version instead of hard-coding one", () => {
  const http = readFileSync(new URL("../packages/sdk/src/core/http.ts", import.meta.url), "utf8");
  assert.match(http, /from "\.\/version\.js"/);
  assert.doesNotMatch(http, /SDK_VERSION = "/);
});
