# Contributing

Thanks for helping. Please read this page and the [Code of Conduct](CODE_OF_CONDUCT.md) first.

## Before you start

- For a bug or a small fix, open a pull request or an issue.
- For a new feature or a change to the public API, open an issue first so we can agree on the shape before you write
  code.
- Report security problems privately, see [SECURITY.md](SECURITY.md).
- Server behaviour and the HTTP API belong to [koldera-core](https://github.com/koldera/koldera-core). This repository
  only wraps them. Changes must not make the SDK claim more than a machine check: no claim that a document is "accessible"
  or conformant, no generated alternative text, no guessed structure.

## Licence of contributions

The project is licensed under Apache-2.0. By submitting a contribution you agree that it is licensed under the same
terms (section 5 of the licence). There is no CLA and no DCO sign-off.

## Setup

You need Node.js 20 or later (22 is what CI uses for the main checks) and pnpm 10 (`corepack enable` picks the pinned
version from `package.json`).

```bash
pnpm install --frozen-lockfile
pnpm -r build
pnpm -r lint          # type checks sources and tests
pnpm -r test          # unit tests of both packages
pnpm test:docs        # README examples are compiled against the built packages
pnpm test:scripts     # tests of the repository scripts
pnpm docs:api             # TypeDoc into docs/api (not committed)
```

`pnpm test` runs the package tests, the docs test and the script tests together.

### Against a real koldera-core

`tests/live-core.test.ts` runs the SDK against a running koldera-core (synthetic inputs only): a PDF analyze and fix
with the fixed copy downloaded and its SHA-256 checked, one HTML-to-PDF job and one structured document job. It is
skipped unless both variables are set, so CI without a server skips it:

```bash
KOLDERA_URL=http://localhost:8080 KOLDERA_TOKEN=... pnpm test:live
```

How to start koldera-core locally is in [examples/node-pdf-demo](examples/node-pdf-demo/README.md).

### React 18

The tests run against React 19. CI also runs them against React 18. To do it locally:

```bash
cd packages/react
pnpm add -D react@18 react-dom@18 @types/react@18 @types/react-dom@18 --no-lockfile
pnpm test
git checkout package.json    # do not commit the downgrade
```

### Contracts

`contracts/` is a mirror of [sdk-contract-kit](https://github.com/koldera/sdk-contract-kit): `openapi.yaml` and the
schemas next to it come from koldera-core at the commit named in `contracts/CORE_VERSION`, the golden fixtures drive
the SDK tests, and `contracts/KIT_VERSION` names the kit commit. Do not edit `contracts/` here: change the kit and run
its `scripts/sync-to-sdk.mjs` against this repository. CI fetches the kit at `contracts/KIT_VERSION` and fails on any
difference in `contracts/` (it is skipped with a notice while sdk-contract-kit is private and not readable with the
workflow token).

### Source hygiene and licences

```bash
node scripts/check-source-hygiene.mjs   # must exit 0
node scripts/check-licences.mjs         # dependency licences must be on the allow-list
```

The hygiene check scans for internal planning references, hosted-service hostnames, long comment blocks and wording that
claims more than a machine check can. Say what was checked and that human review is still required.

## Making a change

- **Test first.** Write a failing test for the behaviour, then the smallest change that passes it.
- **Keep the public surface honest.** If you add or change an export, update the README example that shows it; the docs
  test fails when an example no longer compiles.
- **Browser safety.** The browser entry points must not import Node built-ins, read the environment or mint sessions;
  a bundle-scan test enforces it.
- **No real documents or credentials.** Fixtures are synthetic. Never commit tokens, keys or personal data.
- Pin dependencies exactly and keep `pnpm-lock.yaml` in the same commit.

## Commit style

Small focused commits, imperative mood, plain messages that say what changed and why when it is not obvious:

```text
Refuse a session token with surrounding whitespace in the browser client
Repeat a creation call after a connection reset with the same idempotency key
Document the compatibility table
```

Avoid messages like "update" or "fix".

## Pull requests

Describe what changed and why, list the commands you ran with their results, and note anything you could not run. Keep
a pull request to one concern. The Koldera team reviews it; expect questions about tests and about what a change could
make the SDK claim. The repository is squash-merged.

## Releasing

Releases are made by the maintainers. A release publishes both packages with the same version.

### One-time setup by the owner

npm only lets you configure a trusted publisher for a package that already exists (its documentation and `npm trust`
both say so), so the very first publish of each package cannot use trusted publishing. Reserve the names with a
placeholder, then switch to trusted publishing:

1. Create the npm organisation `koldera` (https://www.npmjs.com/org/create). Use an account with two-factor
   authentication enabled; it must be an owner of the organisation.
2. For each package name (`sdk` and `react`) publish a placeholder by hand, once, from your own machine (this is the
   only manual publish; it uses your interactive login and 2FA, no token is stored anywhere):

   ```bash
   mkdir placeholder && cd placeholder
   echo '{"name":"@koldera/sdk","version":"0.0.0","description":"Placeholder; the real package is published from github.com/koldera/koldera-js","license":"Apache-2.0"}' > package.json
   npm login
   npm publish --access public --tag placeholder
   # repeat with "@koldera/react"
   ```

3. Configure trusted publishing for each package (npm 11.10 or later, 2FA required), either on npmjs.com (package
   Settings, Trusted Publisher, GitHub Actions) or with the CLI:

   ```bash
   npm trust github @koldera/sdk --repo koldera/koldera-js --file release.yml --env npm --allow-publish
   npm trust github @koldera/react --repo koldera/koldera-js --file release.yml --env npm --allow-publish
   ```

   The values are: organisation `koldera`, repository `koldera-js`, workflow filename `release.yml`, environment
   `npm`. They must match exactly or publishing fails with an authentication error.
4. GitHub repository settings:
   - Environments: `npm` (used by the publish job) and `github-pages` (used by the Pages job). Both already allow
     deployments from tags matching `v*.*.*` only; if you recreate them, add that tag rule. On `npm` you can add
     required reviewers so that every release needs your approval before it publishes.
   - Pages: set the source to "GitHub Actions".
   - Provenance and Pages from a private repository are not supported by npm and GitHub's free plan, so make the
     repository public before the first release.
5. Optional, after the first real release: on each package set "Require two-factor authentication and disallow
   tokens", so trusted publishing is the only route.

No `NPM_TOKEN` secret is used. The workflow authenticates with GitHub's OIDC token; it installs npm 11.21.0 (trusted
publishing needs npm 11.5.1 or later and Node 22.14 or later) and fails if the version is too old.

### Releasing a version

1. Make sure `main` is green. Until sdk-contract-kit is public the CI contract check is skipped, so run it by hand:
   from a clean sdk-contract-kit checkout at the commit in `contracts/KIT_VERSION`, run
   `node scripts/sync-to-sdk.mjs <this repository>` and check that `git status` shows no change in `contracts/`.
2. Set the same `version` in `packages/sdk/package.json` and `packages/react/package.json` (the SDK user agent is
   generated from it at build time), and move the changelog entry from "Unreleased" to the version and date. The
   `@koldera/react` dependency on `@koldera/sdk` is `workspace:^`; the workflow checks that the packed package
   depends on exactly `^<version>`.
3. Commit and merge that change through a pull request.
4. Tag the merged commit and push the tag:

   ```bash
   git tag v0.1.0 <commit-on-main>
   git push origin v0.1.0
   ```

5. `release.yml` verifies that the tag matches both package versions and sits on `main`, runs the whole CI workflow
   and the compatibility matrix for that commit, then publishes both packages with provenance (after your approval if
   you added reviewers). After that the GitHub Release (generated notes) and the TypeDoc site on GitHub Pages are made
   in parallel; a Pages failure does not block the release. Publishing is the last step that can fail the release
   before it reaches npm; the checks come before it.

If a publish fails halfway (for example only one package went out), fix the cause and re-run the failed jobs: the publish
step skips a version that is already on npm and publishes the rest. Never reuse a version number for different content;
bump to the next patch version instead.
