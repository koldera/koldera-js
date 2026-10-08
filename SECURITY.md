# Security policy

## Supported versions

koldera-js is an early release. Only the latest 0.x release of `@koldera/sdk` and `@koldera/react` receives security
fixes. Once 1.0 is out, this page will name the supported lines.

## Reporting a vulnerability

Please do not open a public issue.

- Write to security@koldera-accessibility.dev.
- GitHub's private vulnerability reporting (Security tab, "Report a vulnerability") can be used as well once it is
  enabled for the repository.

Include the package and version, what you did, what you expected and what happened. A small proof of concept helps. Do
not send real customer documents or tokens.

The Koldera team aims to confirm receipt within a few working days and will tell you what we decide. The Koldera team
credits reporters who want credit once a fix is released.

## Scope

In scope:

- a path by which a server token or a session token reaches a browser bundle, a log line or an error message;
- the browser client or the React provider accepting or minting a credential they should not;
- verification of downloaded artifacts (size and SHA-256), retry and idempotency behaviour that could repeat a
  non-idempotent request, and handling of redirects and signed URLs;
- the release pipeline (workflows, provenance, trusted publishing).

Out of scope:

- vulnerabilities in third-party dependencies themselves (report them upstream); we want to hear about a vulnerable
  version we ship, though;
- vulnerabilities in the koldera-core server: report those to
  security@koldera-accessibility.dev and say that the report concerns koldera-core;
- findings that need an application to pass a server token to the browser on purpose.
