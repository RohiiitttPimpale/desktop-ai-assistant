# PROJECT_STATE.md — Miko

Last updated: 2026-10-09 ~02:50 IST (overnight autonomous session)

## Current status
- Repo: github.com/RohiiottPPimpale/desktop-ai-assistant, branch `master`, remote at `01936c7` (chat panel feature). Tonight's autonomous changes are working-tree only (PA-001).
- Phases complete: 1 (core), 2 (permissions), 3 (voice). Chat panel UI feature added on top.
- Overnight session: 22 optimizations (OPT-001…022) + 10 security fixes (SEC-001…010) + settings infra (INFRA-001) done; tests 31→65, all green; typecheck+build green. All remaining items blocked on user action or daylight GUI verification (see SESSION_LOG "What remains and why").
- Current phase per AGENTS.md: **Phase 4 (WhatsApp)** — BLOCKED tonight: requires `npm install whatsapp-web.js` (SENSITIVE install) + user QR scan. See PENDING_ACTIONS.md PA-002.

## Architecture (quick map)
- `companion/` — Electron + TypeScript + electron-vite + zod + pino. Python helper scripts (voice, TTS, input automation) run via `python -c`.
- Main process: `index.ts` (agent loop, ~15 steps), `brain.ts` (Gemini Flash pool → Groq fallback, JSON-schema replies), `registry.ts` (tools + permission gate + timeout), `tools.ts` (runTools orchestration), `policy.ts` (trusted tools, timeouts, stop hotkey in %APPDATA%/ai-companion/policy.json), `overlay.ts` (window geometry incl. chat panel), `voice/index.ts` (wake/STT/TTS/PTT/voice confirm), `tray.ts`, `confirm.ts`, `logger.ts`, `config.ts`.
- Packs: `packs/core/index.ts` — 14 tools (screen, browser, app, volume, GUI via ctypes python one-liners).
- Renderer: VRM avatar (three.js), chat input, floating bubble, ChatGPT-style chat panel (toggleable, left side).
- Tests: `tests.ts` → esbuild bundle → Electron; sections 1–10 (31 asserts). `npm run typecheck` / `npm test` / `npm run build` all green at session start.

## Known constraints/rules (from AGENTS.md)
- Never touch `.env` / secrets. `MIKO_VISIBLE=true` stays. DANGEROUS ops never whitelisted.
- Ask-gated commands (commit/push/install) → log PENDING_ACTIONS.md, skip, continue.
- Validation after each change: typecheck + tests (+ build at milestones).

## Known issues at session start (input to TASK_QUEUE)
1. `brain.ts` sanitize() + `registry.getSchemaForLLM()` hardcode the same action-arg whitelist in two places → future tools (WhatsApp `contact`/`path`) would silently drop args.
2. `registry.executeWithTimeout`: pre-aborted signal race (listener added after abort never fires).
3. `open_url` accepts any scheme (`file://`, `ftp://`...) despite "https://" description — prompt-injection surface.
4. `brain.ts`: `preferredIdx` shared between Gemini and Groq pools (index bleed).
5. `tools.ts` + `packs/core/index.ts` duplicate `getActiveWindowTitle`/`captureScreenBase64`; `sleep` duplicated in brain.ts.
6. Agent loop screenshots the screen after EVERY step → token/cost waste on info-only steps; title+capture sequential (~240ms/step latency).
7. Renderer renders at full rAF even when overlay is hidden (backgroundThrottling:false) → wasted CPU/GPU.
8. `avatar.ts` allocates a `Vector3` every frame (GC pressure).
9. Permission denials are not logged (only allows).
10. Voice confirmation: mic is never re-armed after the spoken prompt; echoed prompt text containing "yes"/"no" could self-confirm a SENSITIVE action.
11. `voice/index.ts`: STT stdout JSON parse breaks on extra lines; dummy WAV leaks on failure path.
12. README still titled "Phase 1".

## Current task
Task A: single source of truth for action args (registry-driven schemas + sanitizer).

## Next recommended tasks
See TASK_QUEUE.md.
