# AhaStudio (ahastation-local-cli)

Electron 45 + React 18 + Vite 6 + TypeScript desktop workbench that runs local coding-agent CLIs
(Codex, Claude Code, Antigravity, Grok, ...) and orchestrates them as Workers. Plain CSS, no
Tailwind. UI text is Chinese; code comments are English.

## Commands

| Command | Purpose |
| --- | --- |
| `npm run dev:electron` | Electron + Vite dev app |
| `npm run typecheck` | Renderer (`tsconfig.json`) and main process (`tsconfig.electron.json`) |
| `npm run build:electron` | Compile main process to `dist-electron/` (tests import from here) |
| `npx vite build` | Renderer production build only |
| `npm run test:fast` | `build:electron` + all `tests/*.test.mjs` except the long adversarial-review E2E |
| `npm run test:e2e` | `build:electron` + `tests/orchestration-adversarial-review.test.mjs` (12–15 min) |
| `npm test` | `build:electron` + every `tests/*.test.mjs` (includes the long E2E below) |

Run a subset after `npm run build:electron`:

```bash
node --import ./tests/register-electron-stub.mjs --test --test-concurrency=2 tests/<file>.test.mjs
```

- Use `--test-concurrency=2` for batches: more parallel files fight over ConPTY handles on Windows.
- `tests/orchestration-adversarial-review.test.mjs` is a real-Git E2E taking 12–15 minutes. Run it
  separately, and always after touching review, integration, or worktree code.
- Tests that cover `src/` (renderer) code transpile the TypeScript source directly; tests for
  `electron/` code import `dist-electron/`, so rebuild before running them.

## Environment gotchas (Windows)

- Electron 45 downloads its binary lazily instead of via a `postinstall` script, so a clean
  `npm ci` or `npm install` leaves `node_modules/electron/dist/electron.exe` missing until you run
  `node node_modules/electron/install.js` (or copy `node_modules/electron/dist/` and `path.txt`
  from another checkout with the same Electron version).
- If the shell has `ELECTRON_RUN_AS_NODE=1`, unset it before launching `electron.exe` directly.
- GitHub Actions CI/CD lives in `.github/workflows/` (`ci.yml` for PR/push typecheck, build, and
  3-OS fast tests; `e2e-adversarial-review.yml` for `main`/daily/manual real-Git E2E; `release.yml`
  for `v*` tag packaging across Windows NSIS, macOS arm64 DMG, and Linux AppImage). Run typecheck
  and relevant tests locally before pushing.

## Git workflow

- Do feature work in a worktree under `../ahastation-local-cli.aha-worktrees/`, branched from
  `main`. The main checkout may be in use by another task; do not switch its branch or touch its
  uncommitted changes without asking.
- Commit messages: `type(scope): summary` (e.g. `fix(orchestration): ...`, `feat(agent-session): ...`).
- `screenshot/` is gitignored and holds a local visual harness for `AgentSessionView`
  (`asv-preview.html` served by Vite, captured with `capture.cjs` in Electron).

## Reference code and attribution

- `t3code/` is a local shallow clone of pingdotgg/t3code (MIT), excluded via `.git/info/exclude`.
  Its `AGENTS.md` describes T3 Code's own toolchain and does not apply to this repo.
- Code ported from Orca or T3 Code keeps an attribution header and is listed in
  `THIRD_PARTY_NOTICES.md`. Port logic and visuals; do not adopt Effect-TS, Tailwind, React 19,
  Base UI, or TipTap.

## Orchestration invariants

- Headless Workers authenticate with their own `AHA_WORKER_ID` / `AHA_WORKER_TOKEN`; they have
  `assigneePaneId = null`, `ownsPane = false`, and `providerSessionId` = the provider thread id.
- Session-coordinated Codex Workers run headless: read-only tasks use `read-only` and writable
  tasks use `workspace-write`, with the sandbox rooted at the Worker's working directory (its
  worktree when isolated).
- A finished turn never settles a dispatch. Only `report_done` does; otherwise the turn ends as
  "pending confirmation" with the final text and a redacted diff.
- Delivery failures: only `not_accepted` (failed before the turn started) may fall back to PTY.
  `unknown_acceptance` (timeout or disconnect after sending) must never be re-sent to a PTY.
- In-page human takeover is single-writer: confirm the previous controller has stopped sending
  before unlocking input or resuming in place.

## Code map

- `electron/orchestration/` — orchestration core (`orchestration-service.ts`, store, coordinator,
  MCP server `aha-mcp-server.cjs`, Codex app-server pilot, worker timeline).
- `src/components/AgentSessionView.tsx` + `src/components/agent-session/` — headless Worker
  session UI; pure logic lives in `src/lib/worker-timeline-model.ts` and
  `src/lib/timeline-scroll-anchoring.ts`.
