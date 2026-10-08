# Miko: Build Phases

Work one phase at a time. Do not start a phase until the previous one passes its test.
Update the checkboxes and the "Current phase" line in AGENTS.md after each phase.

> Note: these phases were first written for a Python backend. The real implementation is
> TypeScript/Electron in `companion/` (AGENTS.md wins on conflicts). Boxes are ticked when the
> concept is implemented and verified; the bracket shows where it lives now.

---

## Phase 1: Core + Simple Tools (text input only)

**Goal:** Prove the brain works before adding voice or apps.

- [ ] `config/settings.json` (`MIKO_VISIBLE`, `DRY_RUN`) - deferred until tools that send/upload exist
- [x] Tool registry: decorator, schemas, `schemas()` [`companion/src/main/registry.ts`, zod]
- [x] LLM provider: Gemini Flash, fallback Groq [`companion/src/main/brain.ts`]
- [x] Agent loop with step limit and error-to-LLM handling [`companion/src/main/index.ts`, default 15 steps, tray-configurable]
- [x] Media tools: `set_volume` (up/down/mute; absolute level not yet) and `play_youtube` [`companion/src/main/packs/core/index.ts`]
- [x] Simple text prompt [chat input in `companion/src/renderer/overlay/main.ts`]
- [x] Basic logging of every tool call [`companion/src/main/logger.ts`, pino -> `logs/miko.log`]

**Test:** Type "play Miko song loudly". Volume goes to 100% and the song plays. (Manual; not automated. `set_volume` steps 5x up, no absolute level yet.)

---

## Phase 2: Permission Engine + Logging

**Goal:** Safety before power.

- [x] `Risk` levels on every tool (READ, NORMAL, SENSITIVE, DANGEROUS) [`registry.ts`, every tool in `packs/core`]
- [x] Permission gate and `TRUSTED` list [`registry.ts` `checkPermission` + `policy.ts` `trustedTools`]
- [x] `policy.json` for risk rules [`policy.ts` -> `%APPDATA%/ai-companion/policy.json`: trustedTools, toolTimeouts, stop hotkey, log level]
- [x] Text-based yes/no confirmation (voice comes in Phase 3) [`confirm.ts`, Allow/Cancel dialog]
- [x] Per-tool timeout [enforced in `registry.ts` `executeWithTimeout`; default 30 s, per-tool override in `policy.json`]
- [x] Global stop hotkey ("Miko, stop") [`Ctrl+Alt+X` from `policy.json`; checked per step and raced per tool call]
- [x] Structured log output to a log file [pino -> `%APPDATA%/ai-companion/logs/miko.log`]

**Test:** Register a dummy SENSITIVE tool. Miko asks before running it, and "no" blocks it. (Automated: `companion/tests.ts` sections 2/3/5; timeout in section 8.)

---

## Phase 3: Voice

**Goal:** Talk to Miko instead of typing.

- [x] `voice/wake.py`: Porcupine with a custom "Hey Miko" keyword (using "jarvis" built-in as placeholder)
- [x] `voice/stt.py`: faster-whisper, loaded after the wake word, unloaded after about 60 s idle
- [x] `voice/tts.py`: Piper (with edge-tts fallback)
- [x] Voice yes/no confirmation replaces the text prompt
- [x] Push-to-talk hotkey as a backup (Ctrl+Alt+V)

**Test:** Say "Hey Miko, play the song loudly" and she replies and plays it. Try once in a noisy room.

---

## Phase 4: WhatsApp

**Goal:** Read, download and send through WhatsApp.

- [ ] `whatsapp_node/index.js`: whatsapp-web.js with `LocalAuth`, `headless: false`
- [ ] Local HTTP API on the sidecar (read chat, download, send)
- [ ] `packs/whatsapp`: `wa_read_chat`, `wa_download`, `wa_send_file` (SENSITIVE)
- [ ] `config/contacts.json` alias map ("tufu panda" to the exact contact)
- [ ] Error on ambiguous contact matches
- [ ] Lazy start and stop of the sidecar

**Test:** Send a test file to yourself, then download a file from a test group.

---

## Phase 5: Documents + Screenshots

**Goal:** Turn an assignment into a formatted Word file.

- [ ] `packs/documents`: `read_document` (PDF via PyMuPDF, DOCX via python-docx)
- [ ] `solve_assignment`: LLM returns JSON blocks (heading, paragraph, bullets, code, image, table)
- [ ] `build_docx`: renderer builds the formatted file from the JSON
- [ ] `run_code` (SENSITIVE): temp folder, timeout, captured output
- [ ] `make_screenshot` with mss + Pillow (real terminal or terminal-styled image)
- [ ] `verify`: file exists, every question answered, images inserted

**Test:** Give Miko a sample assignment PDF and get a complete .docx with text and a screenshot.

---

## Phase 6: Full Assignment Flow

**Goal:** Chain everything with the confirmation gate.

- [ ] End-to-end run: read group, download, solve, screenshot, build, verify
- [ ] Confirmation: "Assignment ready. Send to Tufu Panda?" before `wa_send_file`
- [ ] After sending: unmute, 100% volume, play the song, say "Done!"
- [ ] `DRY_RUN` works (everything except the send)
- [ ] Failure handling: Miko reports what failed and where

**Test:** Say the full command in `DRY_RUN`, then once for real with a test contact.

---

## Phase 7: Beyond WhatsApp

**Goal:** Make Miko general, not tied to one workflow.

- [ ] `packs/browser`: Playwright, persistent profile, `headless=False, slow_mo=300`
- [ ] `packs/windows`: `launch_app`, `list_windows`, `focus_window`, `uia_click`, `uia_read`
- [ ] `packs/computer`: `click`, `type`, `hotkey`, `scroll`, `drag` (pyautogui)
- [ ] `find_element`: Gemini vision on downscaled screenshots (about 1280 px wide)
- [ ] Verify with a new screenshot after each computer-use action
- [ ] `plugins/mcp_adapter.py` and a local plugin folder
- [ ] `tools/discovery.py`: load only the relevant tool packs per request

**Test:** Ask Miko to open an app she has no dedicated tool for and complete a small task in it.

---

## Phase 8: Lightweight, Memory, Auto-start

**Goal:** Make Miko run daily without slowing the laptop.

- [ ] `start()` and `stop()` lifecycle on every heavy pack
- [ ] SQLite memory (contacts, preferences, task history)
- [ ] Avatar bridge over WebSocket, low FPS when idle
- [ ] Auto-start (Electron launches the backend, or Task Scheduler at logon)
- [ ] Measure RAM in Task Manager (target about 500-900 MB idle)

**Test:** Reboot the laptop. Miko starts by herself and answers a voice command.

---

## Final Step: Switch to Headless

Do this only when all phases pass.

- [ ] Set `MIKO_VISIBLE=false` in `config/settings.json`
- [ ] whatsapp-web.js to `headless: true`
- [ ] Playwright to `headless=True` and remove `slow_mo`
- [ ] Re-test the full assignment flow once in headless mode
- [ ] Decide whether to add `wa_send_file` to `TRUSTED`
