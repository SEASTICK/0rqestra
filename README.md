# WorkTreeAI

WorkTreeAI is a planned public, open-source desktop application for coordinating a team of AI
coding agents against a local software project, through an editable visual tree.

- A single **Manager** agent is the user's only conversation partner.
- The Manager delegates planning, building, review, debugging, testing, and security work to
  specialist agents that the user configures.
- Each agent runs through an official provider tool that the user installs and signs in to
  themselves. Initially these are OpenAI Codex and Anthropic's Claude Code.

**Targets:** Windows PC and macOS as full desktop apps. An iOS companion is planned later, for
monitoring and controlling a Windows or Mac runner.

**Execution:** provider tools and project operations run on the user's own machine. AI inference
runs with the providers. Cloud execution is out of scope for the initial release.

## Project status

**Stage 1 (product and foundation), revised after independent review.**

- The desktop stack is chosen: **Electron + TypeScript + React**.
- A development foundation exists: workspace, tooling, a secure Electron shell with a
  placeholder page, a fake provider, and tests.
- No product features exist yet. The agreed Stage 2 is the interface. Orchestration and real
  provider adapters come in later stages.
- No provider CLI has been run as part of this project.
- Statements in `docs/` about providers are documentation research and proposals, not test
  results.

See [`WorkTreeAI stages.txt`](WorkTreeAI%20stages.txt) for the checklist, the status of each
item, and the decisions needed to close Stage 1.

Claude implements; ChatGPT/Codex reviews independently. Work proceeds one stage at a time, and
Stage 2 does not start until Stage 1 is reviewed.

## Documentation

| Document | Covers |
|---|---|
| [`docs/product-brief.md`](docs/product-brief.md) | Agreed product decisions: users, workflow, roles, node settings, routing rules, distribution |
| [`docs/provider-integrations.md`](docs/provider-integrations.md) | Claude Code and Codex integration facts verified against official sources, with dates, plus open legal and runtime gates |
| [`docs/architecture.md`](docs/architecture.md) | Agreed components; chosen stack (Electron + TypeScript + React); Electron security requirements; credential ownership; the development foundation and its verified checks |
| [`docs/tree-routing-and-permissions.md`](docs/tree-routing-and-permissions.md) | Two confirmed requirements ("+" adds a connected child agent; highest-priority idle selection), plus draft proposals pending your decision: edge and provenance rules, correction loops, bounds, snapshots and rebase, permission layers, process ownership and recovery |
| [`docs/acceptance-criteria.md`](docs/acceptance-criteria.md) | Draft Given/When/Then specifications AC-01–AC-22 with deterministic fixtures (future tests, not passing tests) |

## Using provider tools

WorkTreeAI will not bundle, modify, or redistribute any provider CLI. It will never collect,
store, or forward your Claude.ai or ChatGPT sign-in credentials. You install each CLI and sign
in through the provider's own flow.

WorkTreeAI "runs Claude Code" and "runs Codex" in the plain-text sense only. It is not built,
endorsed by, or affiliated with Anthropic or OpenAI. Plan usage limits apply; see
`docs/provider-integrations.md`.

## Contributing and license

The project is not yet accepting outside contributions. The decision to release WorkTreeAI as
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
| `npm run smoke:failures -w @worktreeai/desktop` | Run the smoke check against deliberately broken temporary copies of the build, to prove each failure is caught; the real build is never modified |
| `npm start` | Build and open the desktop app (placeholder page) |
| `npm run package -w @worktreeai/desktop` | Unsigned unpacked build in `apps/desktop/release/` |

**Layout:** `packages/contracts`, `packages/provider-fake`, `packages/engine`, `apps/desktop`.
See `docs/architecture.md` §8 for details, check results, and known limitations.
