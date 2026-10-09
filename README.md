# Miko — Voice-Controlled Desktop AI Assistant

Miko is a Windows desktop assistant with a 3D anime avatar (VRM) overlay: an LLM-driven agent that can see the screen, control apps and the browser, play media, and answer by voice or text — with a permission engine guarding every action.

> **Example command (target capability):**
> "Hey Miko, see my WhatsApp class group, download assignment1, complete it, send it to my friend on WhatsApp, then play the Miko song at full volume."

## Status

| Phase | Scope | State |
|---|---|---|
| 1 | Agent core + simple tools | ✅ done |
| 2 | Permission engine + logging | ✅ done |
| 3 | Voice (wake word, STT, TTS, push-to-talk) | ✅ done |
| 4 | WhatsApp sidecar (read/download/send) | ⏳ next (needs `whatsapp-web.js` install + QR scan) |
| 5–8 | Documents, full flow, browser/PC-control, memory | planned |

Roadmap: [`docs/phases.md`](docs/phases.md) · Full design: [`docs/blueprint.md`](docs/blueprint.md)

## Highlights

- **Agent loop** — Gemini Flash (with Groq fallback), single action per step, visual verification of every GUI step, emergency stop (`Ctrl+Alt+X`).
- **Permission engine** — every tool declares a risk level (READ / NORMAL / SENSITIVE / DANGEROUS); SENSITIVE actions always ask; the shell can never be opened by the agent itself.
- **Chat panel** — toggleable ChatGPT-style transcript beside the avatar (💬 button, gear settings, or tray menu).
- **Voice** — Porcupine wake word (custom keyword pending), faster-whisper STT, Piper/edge-tts, voice yes/no confirmations.
- **Persistence** — `policy.json` (trusted tools, timeouts, stop hotkey), `settings.json` (`MIKO_VISIBLE`, `DRY_RUN`), `config.json` (window/model) in `%APPDATA%/ai-companion/`, plus structured logs via pino.

## Run

See [`companion/README.md`](companion/README.md) (Windows, PowerShell):

```powershell
cd companion
npm install
npm run dev
```

Requires Node 20.19+/22.12+ and Python on PATH. API keys live in `companion/.env` (never committed).

## Project memory

Overnight/autonomous sessions maintain state in `PROJECT_STATE.md`, `TASK_QUEUE.md`, `OPTIMIZATION_LOG.md`, `PENDING_ACTIONS.md`, `RESEARCH_NOTES.md`, `SESSION_LOG.md` — start there to see what changed, why, and what needs attention.
