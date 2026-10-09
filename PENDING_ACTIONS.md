# PENDING_ACTIONS.md — requires user (morning) attention

## PA-001 — Commit & push tonight's autonomous work
Status: DONE (pushed 2026-10-09: commits 02d6b87, d1d46ee, 35ce5bd — code, docs/project-memory, config)

### Required Action
Commit the overnight changes and push to GitHub.

### Why It Is Required
`git commit*` and `git push*` are **deny**-gated in opencode.json for the overnight session (user's own config change); overnight mode must not block on permission prompts. All overnight code changes are validated (typecheck/tests/build) but intentionally left uncommitted.

### Current Progress
All overnight tasks completed and validated in the working tree.

### Blocked Task
Nothing else — purely the Git history/push.

### Required Manual Action
Review `git status` / `git diff`, then run (from C:\Users\rohit\assistant):
```
git add -A
git commit -m "Overnight quality pass: registry-driven action args, abort race fix, URL scheme restriction, token/CPU trims, voice confirmation hardening"
git push origin master
```
(Or ask me to split it into logical commits like last time.)

### Risk
Low. Tests/typecheck/build all green before commit.

### Recommended Next Step
After push, start Phase 4 (see PA-002).

---

## PA-002 — Phase 4: WhatsApp sidecar (npm install + QR scan)
Status: PENDING

### Required Action
1. `npm install whatsapp-web.js` in `companion/` (SENSITIVE: dependency install).
2. Start the sidecar once and scan the WhatsApp Web QR with your phone (needs you present).
3. Choose a download folder for attachments.

### Why It Is Required
Phase 4 (`docs/phases.md`) is the current project phase. Cannot proceed without the dependency and an authenticated session (`LocalAuth` persists afterwards).

### Current Progress
Plan-level design exists in `docs/blueprint.md` (sidecar HTTP API: /chat, /download, /send, /status; tools `wa_read_chat`/`wa_download`/`wa_send_file`; contacts.json alias map; SENSITIVE send). OPT-001 (registry-driven args) specifically future-proofed the action pipeline for `contact`/`path` args.

### Blocked Task
`whatsapp_node/index.js` sidecar, `packs/whatsapp` tools, contacts resolution, lazy start/stop.

### Required Manual Action
Run the install and scan the QR when convenient; then tell the build agent to implement Phase 4.

### Risk
whatsapp-web.js is unofficial — keep usage low-volume (account-restriction risk per blueprint §13). LocalAuth stores session data on disk — keep folder private.

### Recommended Next Step
After install + QR: implement sidecar + pack, then Phase 4 test (send test file to yourself, download from a test group).

---

## PA-003 — Absolute volume control (pycaw)
Status: PENDING

### Required Action
`pip install pycaw comtypes` (Python SENSITIVE install) — then `set_volume` can support an absolute level ("100%") instead of 5× key presses.

### Why It Is Required
Blueprint example command needs "full volume"; Phase 6 flow wants unmute + 100%. Current key-press approach is relative and slow.

### Current Progress / Blocked Task / Risk / Next Step
Not started (blocked on install). Low risk; blueprint already pins pycaw as the chosen lib (§5). Do before Phase 6.

---

## PA-004 — Wake word "Hey Miko" (Porcupine access key + custom keyword)
Status: PENDING

### Required Action
1. Create a Picovoice account and get `PORCUPINE_ACCESS_KEY` (free tier available).
2. Train a custom "Hey Miko" keyword at console.picovoice.ai, download the .ppn file.
3. Put the access key in `companion/.env` as `PORCUPINE_ACCESS_KEY` (never in code) and set `PORCUPINE_KEYWORD_FILE` to the .ppn path.

### Why It Is Required
`wake.py` currently runs with no access key (placeholder keyword "jarvis" via built-ins) — the wake word silently does nothing; only Push-to-Talk (Ctrl+Alt+V) and the mic button work. Phase 3's "Hey Miko" is marked done using the placeholder; the real keyword needs this.

### Current Progress
Wake pipeline fully wired and hardened tonight (OPT-014: process errors now surface in the UI; MISSING_ACCESS_KEY path prints a clear hint).

### Blocked Task
True hands-free "Hey Miko" wake word.

### Risk
None — access key is a free-tier secret; keep it in .env only.

### Recommended Next Step
Do this when convenient; then voice mode works end-to-end hands-free.

---

## PA-005 (optional) — Lint tooling
Status: PENDING (low priority)

`npm install -D eslint typescript-eslint` + config would add `npm run lint` to the validation loop (opencode.json already allowlists it). Blocked on install tonight. Until then, `tsc --noEmit` is the quality gate.

---

## PA-006 — Morning decision: voice-confirmation residual echo risk
Status: PENDING (user decision)

### Required Action
Choose one:
1. **Accept** the residual risk (speaker echo of a single trigger word could confirm a SENSITIVE action — headphones unaffected), or
2. **Fall back to the native Allow/Cancel dialog** for SENSITIVE confirmations even in voice mode (loses hands-free voice confirm), or
3. **Fund the proper fix**: renderer emits a playback-ended event; mic re-arms only then, plus silence-detection auto-stop for the recording.

### Why
Tonight's hardening (whole-word matching, ≤3 words, args cap, instruction-first prompt, 2 s delay, re-arm cancellation) reduces but cannot eliminate the echo path — the mic opens on a fixed timer while TTS playback duration is unknown to the main process.

### Current Progress
All non-IPC hardening from option 3's list is already implemented; only the playback-ended IPC + VAD remain.

### Risk
Low probability, high impact (auto-approving a SENSITIVE action). Only in voice mode with speakers (not headphones).

### Recommended Next Step
Option 3 when you have 30–60 minutes; until then option 2 is the conservative choice.

---

## PA-007 — Morning decision: raise type_text to SENSITIVE?
Status: PENDING (user decision)

### Required Action
Decide whether `type_text` should require confirmation (SENSITIVE) or stay auto-run (NORMAL).

### Why
AGENTS.md's risk table explicitly classifies "type" as NORMAL, so tonight's fix only removed the agent's ability to OPEN shells (cmd/wt removed from ALLOWED_APPS — see OPTIMIZATION_LOG SEC-001). But if a console/terminal window that YOU opened happens to be focused, the agent's type_text would still execute a command in it without confirmation. Making type_text SENSITIVE closes that too, at the cost of a confirmation on every typed string (search boxes, chat inputs, everything).

### Risk
Low (requires you to have a terminal focused AND the model choosing to type a command into it, while you watch in visible mode).

### Recommended Next Step
Keep NORMAL for now if the browser workflows matter more; flip to SENSITIVE before Phase 6 (the assignment flow sends real messages).
