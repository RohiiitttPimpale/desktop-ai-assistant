# Miko: Full Blueprint

Rules and the current phase live in `AGENTS.md`. Build order lives in `docs/phases.md`.
This file is the full design: what Miko is, how it is built, and why.

---

## 1. What Miko Is

A voice-controlled Windows agent. The LLM plans and our code acts.

Miko is **not** built around WhatsApp or assignments. Those are only tool packs.
New capabilities are added as new tools, without changing the brain.

**Example command that must work:**

> "Hey Miko, see my WhatsApp class group, download assignment1 (PDF or DOC), complete it
> (make a doc, put text in it with proper format, take a screenshot, insert the image),
> send it to my friend Tufu Panda on WhatsApp, then play the Miko song at full volume."

**Example of a different command Miko must also handle later:**

> "Hey Miko, open Photoshop, remove the background from this image, save it as PNG."

---

## 2. Final Decisions

| Topic | Decision |
|---|---|
| Agent | Custom loop with native function calling (no LangChain) |
| LLM | Gemini Flash via LiteLLM, fallback Groq (cloud only) |
| Wake word | Porcupine for v1 (openWakeWord as an open-source swap) |
| Speech-to-text | faster-whisper, loaded only after the wake word fires |
| Text-to-speech | Piper (edge-tts as an online option) |
| WhatsApp | whatsapp-web.js as a Node sidecar |
| Websites | Playwright |
| Other apps | pywinauto first, then screenshot + vision + pyautogui |
| Documents | LLM outputs JSON blocks, our renderer builds the .docx |
| Memory | SQLite only |
| UI | Existing Electron avatar, connected over WebSocket |
| Python | 3.11 or 3.12 (3.13 can lag on audio/ML wheels) |
| Visible mode | On for now (see section 11) |
| Removed for now | Ollama, FAISS/Chroma, PySide6, LangChain |

---

## 3. Architecture

```
Electron Avatar (face, lip-sync) <--WebSocket--> Python Backend
                                                      |
"Hey Miko" -> Wake word -> STT -----------------> Agent Loop <-- SQLite memory
                                                      |
                                          Permission Engine (risk check)
                                                      |
                                              Tool Registry (Pydantic)
     +----------+-----------+----------+----------+----------+------------+
     v          v           v          v          v          v            v
  WhatsApp   Documents    Files    Media/Volume  Browser   Computer-use  Future
  (Node)     PDF/DOCX     System   pycaw/pygame  Playwright pywinauto +   plugins/MCP
                                                            vision
                                                      |
                                         Result -> TTS -> "Done!"
```

**Agent loop:**

```
Understand -> Plan -> Pick tool -> Execute -> Observe -> Verify
                                                          |
                                      Done -> respond  /  Failed -> replan
```

---

## 4. Tool Preference Ladder

The planner tries these in order.

| Rung | Method | Used for | Speed |
|---|---|---|---|
| 1 | Dedicated tool | WhatsApp, docx, volume, files | Fast |
| 2 | Playwright | Websites | Fast |
| 3 | pywinauto (UI Automation) | Standard Windows apps | Medium |
| 4 | Screenshot + Gemini vision + pyautogui | Any visible app | Slow (3-10 s per action) |

**Fall back only when** a higher rung errors, lacks the needed feature, or has no tool for the target.

**Why dedicated tools come first:** they return exact data (filename, sender, text), run in the
background, and cost almost no tokens. Computer-use takes over your mouse and keyboard and sends
a screenshot to the LLM on every step.

---

## 5. Tech Stack

| Layer | Technology | Phase |
|---|---|---|
| Language | Python 3.11/3.12 and Node.js | 1 |
| LLM | Gemini Flash + LiteLLM (fallback Groq) | 1 |
| Tool schemas | Pydantic | 1 |
| Audio and volume | pycaw + pygame | 1 |
| Logging and tests | structlog, pytest, ruff | 1 |
| Wake word | Porcupine | 3 |
| Microphone | sounddevice | 3 |
| Speech-to-text | faster-whisper | 3 |
| Text-to-speech | Piper | 3 |
| WhatsApp | whatsapp-web.js with `LocalAuth` | 4 |
| PDF reading | PyMuPDF | 5 |
| Word creation | python-docx | 5 |
| Screenshots | mss + Pillow | 5 |
| Browser | Playwright (persistent profile) | 7 |
| Windows apps | pywinauto | 7 |
| Mouse and keyboard | pyautogui | 7 |
| Screen understanding | Gemini vision | 7 |
| Extensibility | MCP adapter + plugin folder | 7 |
| Memory | SQLite | 8 |
| Reminders | APScheduler | Later |
| Packaging | PyInstaller | Later |

---

## 6. Permission Levels

| Risk | Examples | Behaviour |
|---|---|---|
| **READ** | screenshot, read_file, wa_read_chat, web_search | Run automatically |
| **NORMAL** | click, type, open_app, create_file, set_volume, play_song | Run automatically and log |
| **SENSITIVE** | wa_send_file, send_email, upload, install, run_code | Ask by voice (whitelist later) |
| **DANGEROUS** | delete_file, shell, registry, format | Always ask, never whitelisted |

```
Brain -> tool request -> Permission engine
                            |- allowed  -> execute
                            |- ask user -> confirmation -> execute or deny
                            |- denied   -> reject (LLM is told "DENIED by user")
```

---

## 7. Tools

| Pack | Tools |
|---|---|
| **whatsapp** | `wa_read_chat`, `wa_download`, `wa_send_file` |
| **documents** | `read_document`, `solve_assignment` (returns JSON), `build_docx`, `verify` |
| **screen** | `make_screenshot`, `find_element` |
| **media** | `set_volume`, `play_song` |
| **files** | `search`, `read`, `copy`, `move`, `open` |
| **browser** | `open_url`, `search`, `click`, `type`, `download` |
| **windows** | `launch_app`, `list_windows`, `focus_window`, `uia_click`, `uia_read` |
| **computer** | `click`, `type`, `hotkey`, `scroll`, `drag` |
| **code** | `run_code` (temp folder, timeout) |

**Keep tools small and general.** Prefer `wa_send_file(contact, path)` over `send_to_panda()`.
Miko can then combine tools in ways we never explicitly programmed.

### Document JSON blocks

The LLM never writes docx code. It fills this structure and our renderer builds the file:

```json
{
  "title": "Assignment 1",
  "blocks": [
    {"type": "heading", "level": 1, "text": "Question 1"},
    {"type": "paragraph", "text": "Explanation..."},
    {"type": "bullets", "items": ["point one", "point two"]},
    {"type": "code", "language": "python", "text": "print('hello')"},
    {"type": "image", "path": "screenshots/q1.png", "caption": "Output"},
    {"type": "table", "header": ["A", "B"], "rows": [["1", "2"]]}
  ]
}
```

### WhatsApp sidecar API

`whatsapp_node/index.js` runs whatsapp-web.js and exposes a local HTTP API (localhost only).

| Endpoint | Does |
|---|---|
| `GET /chat?name=...&n=20` | Last n messages and attachments of a chat or group |
| `POST /download` | Saves an attachment to a local folder, returns the path |
| `POST /send` | Sends a file or text to a resolved contact |
| `GET /status` | Session state (ready, needs QR) |

---

## 8. Core Code (Registry + Permissions + Loop)

```python
import json
from enum import IntEnum
from pydantic import BaseModel
from litellm import completion

MODEL = "gemini/gemini-3.8-flash"   # current stable Flash (verified Oct 2026; see RESEARCH_NOTES.md)
FALLBACK = "groq/llama-3.3-70b-versatile"

class Risk(IntEnum):
    READ = 0
    NORMAL = 1
    SENSITIVE = 2
    DANGEROUS = 3

TOOLS, TRUSTED = {}, set()

def tool(name, desc, args: type[BaseModel], risk=Risk.NORMAL):
    def wrap(fn):
        TOOLS[name] = dict(fn=fn, args=args, risk=risk, desc=desc)
        return fn
    return wrap

def schemas():
    return [{"type": "function", "function": {
        "name": n, "description": t["desc"],
        "parameters": t["args"].model_json_schema()}} for n, t in TOOLS.items()]

def allowed(name, risk, args) -> bool:
    if risk <= Risk.NORMAL:
        return True
    if risk == Risk.SENSITIVE and name in TRUSTED:
        return True
    return ask_user_by_voice(f"Allow {name} with {args}?")

def llm(msgs):
    try:
        return completion(model=MODEL, messages=msgs, tools=schemas()).choices[0].message
    except Exception:
        return completion(model=FALLBACK, messages=msgs, tools=schemas()).choices[0].message

def run(goal: str, max_steps=25):
    msgs = [{"role": "system", "content": SYSTEM_PROMPT},
            {"role": "user", "content": goal}]
    for _ in range(max_steps):
        msg = llm(msgs)
        msgs.append(msg)
        if not msg.tool_calls:
            return msg.content
        for call in msg.tool_calls:
            t = TOOLS[call.function.name]
            args = t["args"](**json.loads(call.function.arguments))
            if not allowed(call.function.name, t["risk"], args):
                result = "DENIED by user"
            else:
                try:
                    result = str(t["fn"](args))
                except Exception as e:
                    result = f"ERROR: {e}"      # LLM can replan
            msgs.append({"role": "tool", "tool_call_id": call.id, "content": result})
    return "Stopped: step limit reached"
```

**How it works**
- `@tool` registers a function with its schema, description and risk level.
- `schemas()` tells the LLM which tools exist.
- `allowed()` is the gate between the brain and the PC.
- Errors go back to the LLM as text so it can try another approach.
- `max_steps` prevents infinite loops.

This sketch needs a per-tool timeout, logging, and the `SYSTEM_PROMPT` and `ask_user_by_voice`
definitions. These come in Phases 1 to 3.

---

## 9. Example Command, Step by Step

> "Hey Miko, see my WhatsApp class group, download assignment1, complete it,
> send to Tufu Panda, then play Miko song at full volume."

| # | Step | Tool | Risk |
|---|---|---|---|
| 1 | Wake word, then transcribe | wake + STT | - |
| 2 | Find the assignment message in the class group | `wa_read_chat` | READ |
| 3 | Save the PDF/DOC | `wa_download` | NORMAL |
| 4 | Extract the task text | `read_document` | READ |
| 5 | Solve it and return JSON blocks | `solve_assignment` | - |
| 6 | Run code if it is a programming task | `run_code` | SENSITIVE |
| 7 | Capture the output screenshot | `make_screenshot` | READ |
| 8 | Build the formatted Word file | `build_docx` | NORMAL |
| 9 | Verify: file exists, all questions answered, images inserted | `verify` | READ |
| 10 | Ask "Send to Tufu Panda?" and wait for yes | `wa_send_file` | SENSITIVE |
| 11 | Unmute, set 100% volume, play the song | `play_song` | NORMAL |
| 12 | Speak "Done!" | TTS | - |

---

## 10. Lightweight Design (Lazy Loading)

```
ALWAYS ON:        Porcupine + Python core + avatar (low FPS when idle)
LOADED ON WAKE:   STT, TTS (unload STT after about 60 s idle)
LOADED PER TASK:  WhatsApp sidecar, Playwright, vision
```

Each heavy pack has `start()` and `stop()` so the registry can load and unload it.

| Component | Approx. RAM | Note |
|---|---|---|
| Porcupine | 30-50 MB | Light, always on |
| Python core | 150-300 MB | Light |
| Piper TTS | 100-200 MB | Brief spike |
| faster-whisper `small` | 0.8-1.2 GB | Load on demand only |
| Electron avatar | 300-600 MB | Lower FPS when idle |
| whatsapp-web.js | 300-600 MB | Runs a hidden Chromium |
| Playwright | 200-500 MB | Only while a web task runs |

**Target:** about 500-900 MB idle, 1.5-2 GB during a task. These are estimates, so measure in
Task Manager (Details tab) after each phase.

**Lighter options if needed:** Groq Whisper API instead of local STT (saves about 1 GB),
edge-tts instead of Piper, push-to-talk instead of a continuous wake word on battery.

---

## 11. Visible Mode

Both automation tools run visibly for now so the work can be watched.

```json
{ "MIKO_VISIBLE": true, "DRY_RUN": false }
```

| Tool | Now | Final |
|---|---|---|
| whatsapp-web.js | `headless: false` | `true` |
| Playwright | `headless=False, slow_mo=300` | `True`, no `slow_mo` |

Visible mode costs the same RAM as headless. Do not click inside those windows while Miko works.
At the end of the project, follow the "Final Step" checklist in `docs/phases.md`.

---

## 12. Project Structure

```
miko/
├── AGENTS.md
├── docs/          blueprint.md, phases.md
├── core/          agent.py, verifier.py, state.py
├── llm/           provider.py          (LiteLLM + Gemini -> Groq)
├── tools/         registry.py, permissions.py, discovery.py
├── packs/         whatsapp/ documents/ files/ media/ browser/ windows/ computer/
├── voice/         wake.py, stt.py, tts.py
├── memory/        db.py                (SQLite)
├── bridge/        ws_server.py         (to Electron avatar)
├── plugins/       mcp_adapter.py, local plugins
├── whatsapp_node/ index.js             (whatsapp-web.js + local HTTP API)
├── config/        contacts.json, policy.json, settings.json
├── .env           API keys (never committed)
└── main.py
```

---

## 13. Design Rules and Known Limits

**WhatsApp**
- whatsapp-web.js is unofficial. Keep usage low-volume, since account restrictions are possible.
- Scan the QR once. `LocalAuth` saves the session.
- Contacts resolve through `config/contacts.json` (`"tufu panda"` to the exact contact).
  Error on ambiguous matches instead of guessing.

**Documents and screenshots**
- The LLM outputs JSON only. Our renderer owns all formatting.
- For code output, capture a real terminal window or render a terminal-styled image with Pillow.

**Computer-use**
- Verify with a new screenshot after every action.
- Downscale screenshots to about 1280 px wide to save tokens.
- Expect 3-10 s per action. Not suited to long, precise workflows.
- Prefer a CLI or API over clicking when the app has one (for example, `code file.py`).
- Promote frequently used apps (Spotify, VS Code) into dedicated tool packs.

**Tools in general**
- Keep tool results short and structured.
- Once there are dozens of tools, group them into packs and load only the relevant ones
  (`tools/discovery.py`).
- Pin library versions, since pycaw's API has changed between releases.

**Safety nets**
- Step limit, per-tool timeout, global "Miko, stop" hotkey.
- `DRY_RUN` does everything except send.
- Add `wa_send_file` to `TRUSTED` only after the flow is proven.
- Push-to-talk hotkey as a backup when the wake word misfires.

---

## 14. Extensibility

```
Miko Core
├── built-in tool packs
├── local plugins        (any new app, e.g. Spotify, VS Code)
├── MCP servers          (GitHub, databases, other services)
└── future tools         (calendar, email, smart home)
```

Adding a capability means adding a tool or plugin. The agent loop, permission engine and
registry do not change.
