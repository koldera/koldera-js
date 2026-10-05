import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";

// The TypeScript examples in the READMEs are compiled against the built packages, so documentation cannot drift
// from the real exported API. Run `pnpm -r build` first (the `test:docs` script does).
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const reactDir = path.join(root, "packages", "react");
// Inside the react package so that `react`, its types and `@koldera/sdk` resolve exactly as for a user.
const workDir = path.join(reactDir, ".docs-check");

const readmes = ["README.md", "packages/sdk/README.md", "packages/react/README.md"];

export function extractSnippets(markdown: string): Array<{ lang: "ts" | "tsx"; code: string; line: number }> {
  const out: Array<{ lang: "ts" | "tsx"; code: string; line: number }> = [];
  const lines = markdown.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const open = /^```(ts|tsx)\s*$/.exec(lines[i] ?? "");
    if (!open) continue;
    const start = i + 1;
    const body: string[] = [];
    for (i = start; i < lines.length && !/^```\s*$/.test(lines[i] ?? ""); i++) body.push(lines[i] ?? "");
    out.push({ lang: open[1] as "ts" | "tsx", code: body.join("\n"), line: start + 1 });
  }
  return out;
}

describe("README snippets", () => {
  afterAll(() => rmSync(workDir, { recursive: true, force: true }));

  it("extracts fenced ts and tsx blocks", () => {
    const found = extractSnippets("a\n```ts\nconst x = 1;\n```\n```bash\nls\n```\n```tsx\n<A />\n```\n");
    expect(found.map((s) => s.lang)).toEqual(["ts", "tsx"]);
    expect(found[0]?.code).toBe("const x = 1;");
  });

  it("type-checks against the built packages", () => {
    for (const dist of ["packages/sdk/dist/node/index.d.ts", "packages/sdk/dist/browser/index.d.ts", "packages/react/dist/index.d.ts"]) {
      expect(existsSync(path.join(root, dist)), `${dist} is missing: run pnpm -r build first`).toBe(true);
    }
    rmSync(workDir, { recursive: true, force: true });
    mkdirSync(workDir, { recursive: true });

    const files: string[] = [];
    for (const readme of readmes) {
      const snippets = extractSnippets(readFileSync(path.join(root, readme), "utf8"));
      expect(snippets.length, `${readme} has no ts examples`).toBeGreaterThan(0);
      snippets.forEach((snippet, index) => {
        const name = `${readme.replace(/[^a-z0-9]+/gi, "_")}_${index}_line${snippet.line}.${snippet.lang}`;
        // `export {}` makes every snippet a module, so top-level await and repeated names do not collide.
        writeFileSync(path.join(workDir, name), `${snippet.code}\nexport {};\n`);
        files.push(name);
      });
    }

    writeFileSync(
      path.join(workDir, "tsconfig.json"),
      JSON.stringify({
        compilerOptions: {
          target: "ES2022",
          module: "ESNext",
          moduleResolution: "Bundler",
          lib: ["ES2022", "DOM", "DOM.Iterable"],
          types: ["node"],
          jsx: "react-jsx",
          strict: true,
          noEmit: true,
          skipLibCheck: true,
          // The react package itself is not linked into its own node_modules.
          baseUrl: ".",
          paths: { "@koldera/react": ["../dist/index.d.ts"] },
        },
        files,
      }),
    );

    const tsc = createRequire(import.meta.url).resolve("typescript/bin/tsc");
    try {
      execFileSync(process.execPath, [tsc, "-p", path.join(workDir, "tsconfig.json")], { cwd: workDir, encoding: "utf8", stdio: "pipe" });
    } catch (error) {
      const failure = error as { stdout?: string; stderr?: string };
      throw new Error(`README examples do not compile:\n${failure.stdout ?? ""}${failure.stderr ?? ""}`);
    }
  });
});
