# Preview runtime provenance

React, React DOM, and Scheduler production runtimes were read from the public
`vercel/next.js` repository at tag `v16.0.0`, under `packages/next/src/compiled/`.
React version: `19.3.0-canary-2bcbf254-20251020`. Matching runtime files are used together.
Their original copyright headers and shared Meta MIT license are retained.
These are dependencies of the isolated preview, not an application license decision.

The offline builder aliases Next's compiled module paths to the matching vendored modules.
Integration into the real app should use stable pinned npm React dependencies and the project's
selected bundler instead of this temporary offline bundling mechanism.
