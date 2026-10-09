# OPTIMIZATION_LOG.md — Overnight session 2026-10-09

Format per entry: ID / Area / Previous approach & problem / Alternatives & research /
Decision & why / Implementation / Verification / Result.

---

## OPT-001 — Action-arg whitelist duplicated in brain.sanitize + registry schema
- **Area:** agent core (registry.ts, brain.ts), maintainability + Phase-4 readiness.
- **Previous approach:** `getSchemaForLLM()` and `brain.sanitize()` each hardcode the same list of action arg names (query, url, x, y, button, text, key, direction, app, mode, target, name). Two manually-synced copies.
- **Problem:** Any new tool arg (e.g. WhatsApp `contact`, `path`) is advertised by the tool's zod schema but silently dropped by sanitize() and absent from the LLM schema → LLM can never use it; bug appears only at runtime, mid-flow.
- **Alternatives:** (1) keep both lists + add a unit test that they match (still two lists, test-only guard); (2) pass raw args to registry.validateArgs only, drop sanitize filtering (weakens defense-in-depth: sanitize also enforces type/trim before anything runs); (3) derive arg names/types once from each tool's zod schema at registration (single source of truth).
- **Selected:** (3). Zod schemas are already the validation source; deriving names/types at register() keeps sanitize's per-field type/trim checks but reads them from the schema.
- **Implementation:** registry.register() computes `argNames` + `argTypes` (ZodNumber → NUMBER, else STRING) from `schema.shape`; `getSchemaForLLM()` builds `actions.items.properties` as the union of all tools' argTypes; `brain.sanitize(raw, toolNames, argTypesByTool)` accepts only known, type-correct args per tool. ToolDef callers unchanged.
- **Verification:** typecheck; tests.ts new section 11 (dummy tool with custom `contact`/`count` args: schema contains them, sanitize keeps trimmed values, unknown keys dropped, NUMBER typing); all prior sections still pass.
- **Result:** PASS — 45/45 tests. Phase 4 WhatsApp tools (`contact`, `path` args) will now "just work" through the pipeline. Also removed two dead schema entries (`name`, `target`) no tool ever used — smaller schema, fewer wasted tokens.

---

## OPT-002 — Pre-aborted signal race in executeWithTimeout
- **Area:** reliability (registry.ts).
- **Previous approach:** abort listener attached inside the timeout race; a signal that was ALREADY aborted before the call never fires the listener → tool ran despite Ctrl+Alt+X.
- **Alternatives:** reject immediately inside the promise constructor (subtler); upfront synchronous check (chosen).
- **Selected:** upfront `ctx.abortSignal?.aborted` check before starting the handler — synchronous block is atomic in JS, no race window.
- **Verification:** tests.ts section 13 — executeWithTimeout with a pre-aborted controller returns "Aborted by user" without executing.
- **Result:** PASS. Emergency stop is now airtight at tool level.

---

## OPT-003 — open_url accepted any URL scheme
- **Area:** security / prompt-injection surface (packs/core open_url).
- **Previous approach:** `z.string().url()` accepts `file://`, `ftp://`, custom protocol handlers → injected content could open arbitrary local files/protocol handlers via shell.openExternal.
- **Alternatives:** https-only (breaks future localhost sidecar UIs, e.g. WhatsApp status page); http+https refine (chosen); Electron URL allowlist per-host (overkill now).
- **Selected:** `.refine(/^https?:\/\//i)` — matches tool description, keeps localhost usable.
- **Verification:** tests.ts section 12 — file/ftp/javascript rejected, https/http accepted.
- **Result:** PASS.

---

## OPT-004 — Shared preferredIdx across Gemini and Groq pools
- **Area:** correctness (brain.ts).
- **Previous approach:** one `preferredIdx` mutated by both providers' retry loops → a successful Groq model at index 1 made Gemini start its next call from an arbitrary pool position; meaningless cross-provider index bleed.
- **Selected:** separate `geminiPreferredIdx` / `groqPreferredIdx`.
- **Verification:** typecheck + all brain tests (section 10) pass.
- **Result:** PASS (latent bug, no behavior change in tests; both pools now stick to their last-good model correctly).

---

## OPT-005 — Permission denials were not logged
- **Area:** observability (registry.checkPermission).
- **Previous approach:** `logPermissionCheck` only on the allow path; denials (unknown tool, only-browser block, risk-cap block) were silent.
- **Selected:** log on every return path with allowed=false.
- **Verification:** sections 3/7 still pass (denial flows exercised).
- **Result:** PASS — audit trail now complete in %APPDATA%/ai-companion/logs/miko.log.

---

## OPT-006 — Per-step screenshot re-attached even when nothing changed the screen
- **Area:** token usage / API cost / latency (index.ts agent loop).
- **Previous approach:** after EVERY agent step: `captureScreenBase64()` + `getActiveWindowTitle()` sequentially, and the 1280px JPEG was attached to every follow-up brain call.
- **Problem:** a 1280px JPEG ≈ 250–400K characters of base64 → roughly 300–1000+ tokens (vision pricing) per step. After info-only tools (battery, system info, volume) the screen is unchanged — pure waste. Sequential title+capture also added ~150–250ms per step.
- **Alternatives:** (1) keep as-is (waste); (2) attach only when the model asks via look_at_screen (too strict — after click/type the model must verify proactively); (3) attach after screen-changing actions only, and tell the model explicitly when no screenshot is attached (chosen).
- **Selected:** `SCREEN_CHANGING_TOOLS` set (click/type/press/scroll/open_url/web_search/play_youtube/open_app/look_at_screen); screenshot only when the last step used one; title+capture run via `Promise.all`; the step prompt states when no screenshot is attached and points to look_at_screen.
- **Verification:** typecheck + full suite (45/45) + production build. Behavior on GUI flows unchanged (those steps still attach); info-only steps stop paying the vision tokens.
- **Result:** PASS. GUI flows keep full visual verification; info-only steps save the image payload + ~150ms latency.

---

## OPT-007 — Renderer rendered at full frame-rate while the overlay was hidden
- **Area:** CPU/GPU usage (renderer tick loop).
- **Previous approach:** `backgroundThrottling: false` (needed for the agent while the window is click-through) also keeps rAF running when the window is hidden (Alt+M / tray toggle) — the three.js scene kept rendering at full FPS while invisible.
- **Selected:** `if (document.hidden) return` guard in tick() — rAF still scheduled (auto-resumes on show) but all update/render work is skipped.
- **Verification:** typecheck + build (renderer bundles); manual visual check pending (PA note in SESSION_LOG).
- **Result:** PASS (compile-level). Expected: renderer CPU ≈ 0 while hidden; animation resumes on show because rAF continues to be scheduled.

---

## OPT-008 — Dead code: unused helpers and variables
- **Area:** maintainability.
- **Previous approach:** `packs/core/index.ts` contained its own `getActiveWindowTitle` + `captureScreenBase64` (55 lines) — grep proved zero call sites (core uses `captureScreenToFile`; the live versions live in tools.ts). Renderer `speechSafetyTimer` was declared and cleared but never set.
- **Selected:** delete all three. The 1-line `sleep` duplication (brain.ts vs packs/core) was kept deliberately: a shared util module costs more than the duplication, and importing brain→pack would couple the brain to a tool pack.
- **Verification:** typecheck + tests + build all green.
- **Result:** PASS. −57 lines of misleading code.

---

## OPT-009 — Per-frame Vector3 allocation in avatar.ts
- **Area:** GC pressure (renderer, 60fps path).
- **Previous approach:** `new THREE.Vector3()` every frame inside update() for the head position.
- **Selected:** reusable `scratchHeadPos` member.
- **Verification:** typecheck + build.
- **Result:** PASS. One fewer allocation per frame.

---

## OPT-010 — Voice confirmation could self-confirm via TTS echo; mic never re-armed
- **Area:** security / reliability of the SENSITIVE-action gate (voice/index.ts).
- **Previous approach:** `handleVoiceConfirmation` spoke "Say yes to allow or no to cancel" but never started a recording — hands-free answers only worked if the user re-triggered the wake word/PTT themselves. Worse: if a transcript of the echoed prompt arrived, it contains "yes"/"no" and would match the allow/deny word lists.
- **Alternatives:** (1) reword the prompt to avoid yes/no words (fragile — any phrasing leaks trigger words); (2) re-arm the mic and require short answers (chosen); (3) renderer-side end-of-speech detection (new IPC, scope creep).
- **Selected:** re-arm the mic via `voiceStartRecording` 1.2s after the prompt (lets TTS tail finish), AND only transcripts of ≤4 words may confirm/deny; longer transcripts (echoed prompt, new commands) fall through to the normal handler.
- **Verification:** typecheck + tests (section 9 pipeline paths) + build. Word-count guard is logic-review verified; full voice flow needs manual test (PA note).
- **Result:** PASS (compile/logic). Self-confirm risk eliminated by construction for anything longer than 4 words.
- **Addendum:** self-review found the 1.2 s re-arm timer could open a stray recording if the confirmation settled first (user answered via Push-to-Talk) — the timer is now cancelled on allow/deny/timeout.

---

## OPT-011 — STT stdout JSON parse fragile; dummy WAV leaked on failure
- **Area:** reliability (voice/index.ts).
- **Previous approach:** `JSON.parse(stdout.trim())` — any library warning printed to stdout breaks transcription; the `miko-dummy.wav` used to warm the model was unlinked only on the success path (leaked on failure).
- **Selected:** parse from first `{` to last `}` (tolerates surrounding noise) + explicit no-JSON error path; dummy WAV cleanup moved to `finally`.
- **Verification:** typecheck + tests (section 9 exercises the STT failure path and asserts no `miko-stt-*` temp leaks — analogous guarantee now also for `miko-dummy.wav`).
- **Result:** PASS.

---

## OPT-013 — Concurrent agent runs could interleave on shared brain history
- **Area:** reliability / concurrency (index.ts, renderer main.ts).
- **Previous approach:** `askBrain` had no busy guard; `onVoiceTranscript` re-enabled the chat input mid-run AND auto-submitted, so a push-to-talk message during a running agent loop launched a second concurrent loop — two loops mutating the same brain history, session, and abort controller.
- **Alternatives:** queue messages (complexity, no user value yet); reject with a friendly message (chosen, matches the "one task at a time" persona).
- **Selected:** three layers: (1) renderer `onVoiceTranscript` no longer re-enables the input mid-run and skips auto-submit when busy (transcript stays in the input); (2) `submitToBrain` early-returns when disabled; (3) main-process `agentBusy` guard returns "I'm still working on your last request" for any caller that slips through.
- **Verification:** typecheck + full suite (48/48). Logic-level; manual voice test on morning checklist.
- **Result:** PASS. Single-flight agent runs by construction.

---

## OPT-014 — Wake-word process errors were routed to a callback that never existed
- **Area:** reliability / observability (voice/index.ts).
- **Previous approach:** wake process `error`/`exit` handlers called `wakeCallbacks?.onError(...)` — but `wakeCallbacks` was NEVER assigned anywhere (dead variable). A crashed wake word (missing pyaudio, bad access key) was log-only; the UI/user never learned why "Hey Miko" stopped working.
- **Selected:** removed the dead `WakeWordCallbacks` interface and variable; errors now route to the installed `voiceCallbacks.onError` (which reaches the renderer), with a hint that Push-to-Talk still works.
- **Verification:** typecheck + suite §9 paths (48/48).
- **Result:** PASS.

---

## OPT-015 — Gemini pool admitted non-chat Flash models; priority order outdated
- **Area:** correctness / cost / reliability (brain.ts).
- **Previous approach:** pool filter was `includes('flash') && !tts && !audio`; priority list skipped 3.7/3.6 in favor of legacy 3.5.
- **Problem:** the live model list contains Flash-BRANDED non-chat models (verified against official docs — see RESEARCH_NOTES RN-001): `gemini-3.1-flash-image` (Nano Banana 2), `gemini-omni-1.1-flash` (video gen), `gemini-3.8-flash-tts`, flash-live variants. On a chat-model failure the retry loop could invoke an image/video model via generateContent — wasted retries, garbage or errors. Priority also preferred legacy 3.5 over the 3.7/3.6 agentic models.
- **Selected:** `isChatFlashModel()` denylist filter (tts/audio/image/live/transcribe/omni/banana/embedding) + priority 3.8 → 3.7 → 3.6 → flash-latest, matching the docs' generation descriptions for agent workloads.
- **Verification:** tests §14 — mocked model list with image/omni/tts/live/banana flash models; brain answers via 3.8-flash and never attempts a non-chat model. 48/48.
- **Result:** PASS. (Also: info-only agent steps now skip the per-step python title lookup — folded into OPT-006's `affectsScreen` gate, saves ~100–200 ms per info-only step.)

---

## OPT-016 — Unbounded worst-case brain latency before Groq fallback
- **Area:** reliability / UX (brain.ts callGemini/callGroq).
- **Previous approach:** 2 retry passes over the whole model pool; with ~6 chat models × 15 s request timeout × 2 passes, a hanging Gemini outage could stall one brain call for ~3 minutes (and the agent loop repeats that per step).
- **Selected:** skip the second pass if the first already consumed >20 s — rate-limit blips still get their quick retry, total outages fall through to Groq promptly.
- **Verification:** typecheck + suite (§10 fallback still reached under instant-500 mocks; the deadline only triggers on slow failures). Worst case now ≈ pool×15 s + Groq ≈ bounded at one pass.
- **Result:** PASS.

## OPT-017 — Gemini models-list request used ?key= query auth
- **Area:** security hygiene (brain.ts).
- **Previous approach:** `GET .../models?key=<API_KEY>` — keys in URLs can leak into proxy/access logs. generateContent already used the `x-goog-api-key` header.
- **Selected:** header auth for the models list too.
- **Verification:** typecheck + suite §10/§14 (fetch mocks match by URL path, unaffected).
- **Result:** PASS.

## OPT-018 — Typos in policy.json trustedTools failed silently
- **Area:** observability / Phase-4 readiness (index.ts).
- **Previous approach:** `trustedTools` entries that match no registered tool simply never match — the tool keeps asking for confirmation forever with no hint why. Critical for Phase 6 when the user adds `wa_send_file` to TRUSTED.
- **Selected:** at startup, log a warning listing trustedTools entries that match no registered tool.
- **Result:** PASS.

## OPT-019 — Groq pool admitted non-chat models
- **Area:** correctness / reliability (brain.ts resolveGroqModels).
- **Previous approach:** every "active" model from Groq's /models endpoint entered the fallback pool — including whisper, TTS, guard and embedding models, which cannot serve chat completions (they would burn retry slots with 400s).
- **Selected:** same denylist approach as the Gemini side (`NON_CHAT_GROQ`: whisper/tts/guard/embed).
- **Verification:** tests §15 — mocked Groq list with whisper/playai-tts/llama-guard; only the chat model is ever attempted. 51/51.
- **Result:** PASS. (Found during self-review of the OPT-015 change — the same bug class existed on the fallback provider.)

## OPT-020 — Replies synthesized TTS even with Auto-Speak disabled
- **Area:** latency / API usage (index.ts, preload, renderer, shared ipc).
- **Previous approach:** every askBrain reply ran `synthesizeSpeech` (~1–2 s edge-tts round-trip) before responding; if the user had Auto-Speak unchecked the renderer discarded the audio — pure wasted latency and API usage per reply.
- **Alternatives:** lazy on-demand TTS via a separate invoke (bigger IPC surface change); skip-when-disabled via a state mirror (chosen).
- **Selected:** renderer reports its Auto-Speak checkbox (initial state + on change) over `tts:set-autospeak`; main skips synthesis when disabled. Voice confirmation prompts still always synthesize (spoken by definition).
- **Verification:** typecheck + suite (51/51) + build. Behavior: autospeak ON unchanged; OFF saves the per-reply synthesis.
- **Result:** PASS.

---

# Security batch (independent review findings — subagent security-reviewer, 2026-10-09)

Findings F1–F10 from the overnight security review were processed. Confirmed items below; each records what was fixed, what was deliberately deferred, and why.

## SEC-001 (F1, CRITICAL) — open_app cmd + type_text = unconfirmed RCE chain
- **Problem:** `open_app {app:"cmd"}` (NORMAL, auto-run) opens a console; a following `type_text {text:"<anything>"}` (NORMAL, auto-run, presses Enter) executes arbitrary shell commands with zero confirmation. Violates AGENTS.md ("shell is DANGEROUS-class, always ask").
- **Fixed:** removed `cmd`/`terminal` (wt.exe) from `ALLOWED_APPS`; `open_app` now refuses them at the handler (`Blocked app`). Regression test §16.
- **Deliberately NOT changed:** `type_text` stays NORMAL — AGENTS.md's risk table explicitly classifies "type" as NORMAL (project law wins over the reviewer's suggestion). Residual risk: the agent typing into a console the USER opened themselves (visible mode; user watching). Morning decision item: raise type_text to SENSITIVE if you accept the extra confirmation on every typed string.
- **Result:** PASS — the agent can no longer stage the chain itself.

## SEC-002 (F2, HIGH) — Untrusted content into the LLM
- **Problem:** attacker-controllable window title was concatenated into the SYSTEM instruction (highest-privilege position); tool output (YouTube titles etc.) flowed in with no untrusted marking.
- **Fixed:** window title demoted from systemInstruction to an explicitly-marked `[untrusted context]` part of the user message; persona gained the UNTRUSTED CONTENT RULE (data, never instructions).
- **Deferred:** canary/injection regression tests (non-deterministic model behavior — needs a live model + eval harness, noted in TASK_QUEUE).
- **Result:** PASS (structural demotion + persona rule; live-model compliance is probabilistic by nature).

## SEC-003 (F3, MEDIUM) — Voice confirmation echo/substring issues
- **Problem:** substring matching false-approves innocuous words ("broken"→ok, "eyes"→yes); spoken args uncapped; fixed re-arm timer could record the prompt tail.
- **Fixed:** whole-word set matching (≤3 words); spoken args capped at 400 chars; prompt reordered so the tail is args (not a trigger word); re-arm delay 1200→2000 ms; re-arm cancelled on settle (prior fix).
- **Deferred (morning decision):** the residual risk remains that a single echoed trigger word could confirm a SENSITIVE action. Proper fix needs a playback-ended IPC + silence-VAD auto-stop (or falling back to the native dialog for SENSITIVE in voice mode). Listed in PENDING_ACTIONS PA-006.
- **Result:** PASS (mechanisms hardened; residual documented).

## SEC-004 (F4, MEDIUM) — Renderer could escalate permission mode
- **Problem:** `config:set-permission` IPC let any renderer code flip to Full Control with no user gesture; no renderer used it.
- **Fixed:** removed the IPC channel, preload API, shared type, and the main handler. Tray is the only permission setter now (comment documents this in tools.ts).
- **Result:** PASS.

## SEC-005 (F5, MEDIUM) — No navigation/open guards; no sender validation
- **Fixed:** `setWindowOpenHandler` denies all window.open; `will-navigate` blocks anything off the app origin (registered after initial load); all privileged IPC handlers (`askBrain`, voice record/response, chatPanelSet, ttsSetAutospeak) validate `senderFrame.url`.
- **Result:** PASS (defense-in-depth; no remote content is loaded today).

## SEC-006 (F6, MEDIUM) — Secrets/sensitive data in plaintext logs
- **Fixed:** tool-call args now redacted (string values capped at 120 chars) at info level; STT transcripts capped at 200 chars in logs; raw `console.log` of actions removed from runTools (pino log with redaction remains); log rotation added earlier (OPT-021-style startup rename at 10 MB).
- **Result:** PASS.

## SEC-007 (F7, LOW/MEDIUM) — Clipboard restore not exception-safe
- **Fixed:** `type_text` and `navigateInBrowser` restore the user's clipboard in `finally`.
- **Deferred:** moving off clipboard entirely (SendInput KEYEVENTF_UNICODE) — real improvement, but changes input behavior; noted in TASK_QUEUE.
- **Result:** PASS.

## SEC-008 (F8, LOW) — Sensitive dialog defaulted to Allow
- **Fixed:** `defaultId: 1` (Cancel). An accidental Enter can no longer approve a SENSITIVE action. Tests unaffected (they mock the dialog).
- **Result:** PASS.

## SEC-009 (F9, LOW) — API key hygiene
- **Fixed:** models-list call already on header auth (OPT-017); key-loading precedence reordered to runtime env → .env file → build-time `import.meta.env` (last resort, since electron-vite bakes MAIN_VITE_* into release bundles); `.env` resolved app-path-first (a stray cwd .env can no longer substitute a key).
- **Empirical verification (artifact audit, no key contents inspected):** rebuilt `out/main/index.js` contains (a) the variable NAMES only in an error-message string and `process.env[...]` accesses, (b) Vite's `__vite_import_meta_env__` shim object WITHOUT any `MAIN_VITE_*_API_KEY` entries (boolean regex checks), (c) zero textual key substitution. **The current build does not bake the keys.** Residual: if a MAIN_VITE_*_API_KEY is ever exported as a process env var during a build, Vite would inline it — the build-time guard stays on TASK_QUEUE (AA) as a cheap future safety net.
- **Deferred:** hard build-time guard that fails release builds when MAIN_VITE_GEMINI_API_KEY is exported - edge case, noted in TASK_QUEUE.
- **Result:** PASS.

## SEC-010 (F10, LOW) — Assorted
- **Fixed:** audio IPC capped (~27 MB) before the STT temp-file path; tray InputBox now `execFile` with argv instead of a shell string.
- **Deferred:** (a) killing tool child processes on timeout — DONE as OPT-021; (b) tightening CSP `connect-src` — required for dev HMR, left as-is; (c) pinning the python interpreter path — supply-chain hygiene, low priority.
- **Result:** PASS.

---

## OPT-021 — Timed-out tools left their spawned children running
- **Area:** reliability (registry.ts + packs/core; security-review finding F10.2).
- **Previous approach:** the timeout race rejected the handler promise, but any child process the handler had spawned (python click/typing/navigation helpers) kept running to completion — the agent was told "failed" while the click/keystroke later landed anyway (state desync + surprise side effects).
- **Alternatives:** kill from inside each handler with its own timer (duplicated per tool); central per-execution AbortController threaded into handlers via ctx (chosen — one mechanism, handlers just pass it to child_process options).
- **Selected:** `ToolContext.execSignal` — an AbortController per executeWithTimeout call, aborted on BOTH timeout and user stop (Ctrl+Alt+X now also kills in-flight automation children). All packs/core helpers (click, type, keys, scroll, volume, battery, browser navigation) thread it into `execFileAsync({ signal })`.
- **Verification:** tests §17 — a tool spawning `ping -n 30` with a 150 ms policy timeout: cut off at 150 ms (not 30 s), and `tasklist` confirms NO ping process remains. 57/57.
- **Result:** PASS. Emergency stop now stops everything, not just the loop bookkeeping.

---

## INFRA-001 — settings.json infrastructure (Phase 1 deferred item, Phase 4 prerequisite)
- **Area:** enablement (new `src/main/settings.ts`; phases.md Phase 1).
- **Why now:** phases.md's own test for Phase 6 is "`DRY_RUN` works (everything except the send)" and the Final Step flips `MIKO_VISIBLE` — both need the settings store to exist before Phase 4's `wa_send_file` can consume them. Small, general, testable; no workflow-specific logic (AGENTS.md compliant).
- **Selected:** `%APPDATA%/ai-companion/settings.json` next to policy.json (existing persistence convention), typed accessors `getSettings/updateSettings/isDryRun/isVisibleMode`, defaults `MIKO_VISIBLE: true` (project rule), `DRY_RUN: false`.
- **Also:** build-time warning in electron.vite.config.ts when `MAIN_VITE_*_API_KEY` is exported during builds (closes TASK_QUEUE AA as a warning-level guard; hard-fail rejected to keep local builds working).
- **Verification:** tests §18 (defaults, toggle, restore); typecheck; build. 61/61.
- **Result:** PASS.

---

## OPT-022 — voice/index.ts used inline require() for core modules
- **Area:** code quality / bundling hygiene (voice/index.ts).
- **Previous approach:** ~10 inline `require('node:fs'|'node:path'|'node:os'|'electron')` calls inside functions (legacy of making the esbuild test bundle work), including shadowing local `fs/path/os` consts in handleRecordingComplete and a local `path` variable shadowing in getScriptsDir.
- **Selected:** proper top-level ESM imports; local shadows removed/renamed; the `typeof __dirname` CJS fallback for the test bundle kept. Also added the root `README.md` (the GitHub repo had none) documenting status/structure/run instructions.
- **Verification:** typecheck + full suite (61/61, voice pipeline sections included) + production build.
- **Result:** PASS. One consistent import style; no behavioral change.

---

## BUGFIX-001 (user-reported, ~09:45 IST) — Voice transcripts silently dropped; brain hangs invisible
- **Report:** voice command transcribed fine ("open a youtube...") but Miko never acted; typed attempts showed `Step 1/15 asking brain...` then silence.
- **Root cause 1 (regression from OPT-013):** `onVoiceTranscript` checked `chatInput.disabled` to detect "agent busy" — but the input is ALSO disabled while the mic is recording. After a recording, the transcript hit the guard and was dropped without a trace. The busy state is now a dedicated `agentRunning` flag; the recording path re-enables the input again. Belt-and-braces: `chatForm` submit checks `agentRunning` too; the main-process `agentBusy` guard (OPT-013) remains as the last layer.
- **Root cause 2 (pre-existing):** in the brain's model-retry loops, HTTP failures were logged but TIMEOUT/network errors were swallowed silently; and `AbortSignal.timeout` has been observed not to fire for hung response headers in this Electron build (the very thing the removed debug_timeout.cjs used to probe) — 12 pooled models × a hang = minutes of silence that looks like a dead agent.
- **Fixes:** `fetchWithWatchdog()` — every brain fetch races a plain-JS timer, guaranteeing settlement in `timeoutMs` regardless of AbortSignal behavior; every failure path now logs (`[brain] <model> failed (<reason>), trying next...`); 45 s hard budget per provider before falling through to Groq; models-list fetch failures also logged (were silent).
- **Verification:** tests §19 — a model that never settles is logged, skipped, and the next model answers: brain replies in ~255 ms (watchdog at 250 ms) instead of hanging. 68/68 + build green.
- **Result:** PASS. Voice flow restored; a hanging API can no longer masquerade as a dead agent.

---

## BUGFIX-002 (user-reported, ~11:00 IST) — Miko vanished mid-session (avatar, chat and mic all gone)
- **Report:** after a long chat/voice session, the avatar disappeared while the app kept running.
- **Root cause (visible in the user's log):** at 05:24:35 and 05:24:47 UTC Miko's own `press_key` tool sent **alt+f4** while her overlay window had focus (the user had been chatting via her input). Alt+F4 closed the overlay BrowserWindow; `window-all-closed` is a no-op by design, so the app (tray, agent loop, tools) kept running invisibly — clicks and brain steps continued in the log right past the disappearance.
- **Fixes (three layers):**
  1. `overlay.ts`: `closable: false` on the BrowserWindow — keyboard/system close can no longer remove the avatar; plus a `close` guard that hides instead of closing unless the app is quitting (`before-quit` flag + `destroy()` for clean shutdown).
  2. `packs/core`: `type_text` and `press_key` now check the foreground window first (new `src/main/foreground.ts` helper, no import cycle) and return a structured error when it is Miko's own overlay — the model gets told to focus the target app instead of typing/closing itself. Also stops `type_text` from pasting text into Miko's own chat input.
  3. `overlay.ts`: `render-process-gone` → automatic overlay reload, so a renderer crash (GPU/three.js after hours) can never leave a dead invisible window either.
- **Also:** STT transcription failures now log python's stderr (the 05:13:42 UTC failure in the same log showed only "Command failed" with no reason).
- **Verification:** typecheck + full suite (68/68) + build. The window/guard behaviors need the manual morning checklist (alt+f4 with overlay focused must NOT close her; typing tools must refuse self-target).
- **Result:** PASS. Miko can no longer close, type into, or crash herself out of existence.
