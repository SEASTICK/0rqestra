# 0rqestra

0rqestra is a planned public, open-source desktop application for coordinating a team of AI
coding agents against a local software project, through an editable visual tree.

- A single **Manager** agent is the user's only conversation partner.
- The Manager delegates planning, building, review, debugging, testing, and security work to
  specialist agents that the user configures.
- Each agent runs through an official provider tool that the user installs and signs in to
  themselves. Initially these are OpenAI Codex and Anthropic's Claude Code.

**Targets:** Windows PC and macOS as full desktop apps. An iOS companion is planned later, for
monitoring and controlling a Windows or Mac runner. Windows is the current development target;
macOS verification is deferred (not passed, not dropped).

**Execution:** provider tools and project operations run on the user's own machine. AI inference
runs with the providers. Cloud execution is out of scope for the initial release.

## Project status

**Stage 1 (product and foundation) is in progress, not complete.**

- The desktop stack is chosen: **Electron + TypeScript + React**.
- A development foundation exists: workspace, tooling, a secure Electron shell with a
  placeholder page, a fake provider, and tests. The user accepted it for the Windows-only scope
  on 2026-11-17. macOS CI currently fails intermittently in one smoke failure case; macOS
  verification is deferred.
- A release pipeline and in-app updates exist (see `docs/release.md`).
- No product features exist yet. The agreed Stage 2 is the interface. Orchestration and real
  provider adapters come in later stages.
- Provider CLIs have been run only in limited Stage 1 probes on Windows (Claude Code and Codex,
  3 model requests each). Results and limits: `docs/provider-runtime-results.md`. Other
  statements about providers in `docs/` are documentation research and proposals.

See [`0rqestra stages.txt`](0rqestra%20stages.txt) for the checklist, the status of each
item, and the decisions needed to close Stage 1.

Claude implements; ChatGPT/Codex reviews independently. Work proceeds one stage at a time, and
Stage 2 does not start until Stage 1 is reviewed.

## Download and updates

- **Latest release:** [Download 0rqestra](https://github.com/SEASTICK/0rqestra/releases/latest)
  (Windows `.exe`, macOS `.dmg`). The same files are on the
  [download page](https://seastick.github.io/0rqestra-realeases/downloads.html).
- An installed app updates itself: it downloads and verifies a new version in the background and
  asks before restarting.
- Releases are started by hand under **Actions → Publish 0rqestra release**: `test` first, then
  `stable`, which waits for an `approve` or `deny` comment. See [`docs/release.md`](docs/release.md).

Release `v0.1.0` was published on 2026-11-16.

## Documentation

| Document | Covers |
|---|---|
| [`docs/product-brief.md`](docs/product-brief.md) | Agreed product decisions: users, workflow, roles, node settings, routing rules, distribution |
| [`docs/provider-integrations.md`](docs/provider-integrations.md) | Claude Code and Codex integration facts verified against official sources, with dates, plus open legal and runtime gates |
| [`docs/architecture.md`](docs/architecture.md) | Agreed components; chosen stack (Electron + TypeScript + React); Electron security requirements; credential ownership; the development foundation and its verified checks |
| [`docs/tree-routing-and-permissions.md`](docs/tree-routing-and-permissions.md) | Agreed tree, routing, permission, and process rules: the "+" child agent, highest-priority idle selection, decisions A1–A8 (2026-11-16) and D1–D12 (2026-11-17) |
| [`docs/release.md`](docs/release.md) | Release channels (`test`, `stable`), the approval step, one-time setup, and how the app updates itself |
| [`docs/acceptance-criteria.md`](docs/acceptance-criteria.md) | Given/When/Then specifications AC-01–AC-22, reconciled with the user's decisions (revision 6, accepted by independent review as a specification; not yet implemented), with deterministic fixtures (future tests, not passing tests) |

## Using provider tools

0rqestra will not bundle, modify, or redistribute any provider CLI. It will never collect,
store, or forward your Claude.ai or ChatGPT sign-in credentials. You install each CLI and sign
in through the provider's own flow.

0rqestra "runs Claude Code" and "runs Codex" in the plain-text sense only. It is not built,
endorsed by, or affiliated with Anthropic or OpenAI. Plan usage limits apply; see
`docs/provider-integrations.md`.

## Contributing and license

The project is not yet accepting outside contributions. The decision to release 0rqestra as
open source is agreed. **Which license to use has not been chosen yet.** Until a LICENSE file is
added, no license is granted.

## Development

**Prerequisites:**

- Node.js 24 LTS, version 24.11.0 or later within 24.x (`engines`: `^24.11.0`; `.nvmrc`: `24`),
  with npm. `.npmrc` sets `engine-strict=true`, so npm refuses other Node versions. pnpm is not
  required.
- Git.
- Windows 10/11 or macOS. The Electron binary downloads automatically on first install.

The provider CLIs are **not** development prerequisites; automated tests use a deterministic
fake provider. (Separately, neither provider CLI needs Node.js at runtime when installed with
its native installer.)

**Commands (run from the repository root):**

```bash
npm ci
```

```bash
npm run check
```

```bash
npm run smoke
```

```bash
npm start
```

| Command | What it does |
|---|---|
| `npm ci` | Install the exact dependency versions from `package-lock.json` |
| `npm run check` | Lint, typecheck all workspaces, and run unit tests |
| `npm run smoke` | Build the desktop app and run the Electron security self-check in a real window. Prints `SMOKE PASSED` (exit 0) or `SMOKE FAILED` (exit 1); times out after 20 s |
| `npm run smoke:failures -w @0rqestra/desktop` | Run the smoke check against deliberately broken temporary copies of the build, to prove each failure is caught; the real build is never modified |
| `npm start` | Build and open the desktop app (placeholder page) |
| `npm run package -w @0rqestra/desktop` | Unsigned unpacked build in `apps/desktop/release/` |

**Layout:** `packages/contracts`, `packages/provider-fake`, `packages/engine`, `apps/desktop`.
See `docs/architecture.md` §8 for details, check results, and known limitations.

## Rename compatibility

The product name, window/page titles, Electron packaging name, npm root/workspace names and
this README now use **0rqestra** (`@0rqestra/*` for npm workspaces). The development
app ID is `dev.orqestra.desktop`; it remains a placeholder before a signed public release.

The secure preload API `window.orqestra`, the smoke-only `--orqestra-smoke` diagnostic flag,
and the provider probe tools' `ORQESTRA_*` variables, `.orqestra-probe` configuration path
and recorded client IDs remain stable for compatibility and reproducibility. Provider runtime
evidence files and their hashes are unchanged. No model probe was rerun by this rename.

The recorded package/smoke results in the architecture document refer to the earlier 0rqestra
build. The rename itself does not upgrade their verification status or complete Stage 1. This
checkout contains the foundation and provider probes; it does not contain the separately built
desktop subscription/UI preview from the former repository's review branch.

Historical Stage 1 documents, the existing `0rqestra stages.txt` filename and provider-review
materials retain their original names and contents. They describe this same project before its
rename; none of their evidence, decisions or review statuses is changed by the rebranding.
