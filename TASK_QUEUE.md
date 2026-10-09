# TASK_QUEUE.md — Overnight session 2026-10-09

Priority order: 1 = optimization/stability/quality, 2 = UI/UX, 3 = features.
Statuses: TODO / DOING / DONE / BLOCKED / SKIPPED (with reason).

## Critical
- (none known — no open crashes; tests green)

## Optimization / Quality (Priority 1)
- [DONE] A–L, R–U: see OPTIMIZATION_LOG OPT-001…OPT-020 (all verified).
- [DONE] V. Independent security review (subagent) — returned F1–F10; findings processed.
- [DONE] W. Security fixes SEC-001…SEC-010 (F1–F10) implemented + tested (54/54); residuals documented in PENDING_ACTIONS PA-006/PA-007.
- [DONE] X. Kill tool child processes on timeout (OPT-021; verified by test §17 — real child killed at timeout, no orphan remains).
- [TODO] Y. Replace clipboard-based typing with SendInput KEYEVENTF_UNICODE (never touches the clipboard). BLOCKED-DAYLIGHT: behavior change requiring human verification with a focused app.
- [TODO] Z. Injection canary regression test (needs live-model eval harness).
- [TODO] AA. Build-time guard: fail release builds when MAIN_VITE_GEMINI_API_KEY is exported. (Empirically verified NOT an issue today: the built artifact contains no key entries — see OPTIMIZATION_LOG SEC-009. Guard is a cheap future safety net only.)

## UI/UX (Priority 2)
- [TODO] N. Chat panel + hidden-overlay resume: manual-verify checklist for the user (no renderer test infra).
- [SKIPPED] O. Tray "Custom Type-In" stale checkbox — menu is rebuilt on every open; no stale state persists. Not a bug.

## Features (Priority 3 — deferred; Phase 4 blocked on install)
- [BLOCKED] P. Phase 4 WhatsApp sidecar — needs npm install + QR scan (PA-002).

## Research
- [DONE] Q. Gemini model naming validated against official docs (RESEARCH_NOTES RN-001) → OPT-015 applied.

## Blocked
- Git commit/push of tonight's work → PA-001 (morning).
- Any new dependency installs → PA-002/PA-003.
