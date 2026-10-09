# Miko — AI Desktop Companion

Windows voice-controlled assistant with a 3D VRM avatar overlay, an agent loop with a permission engine, and a toggleable ChatGPT-style chat panel beside the avatar.

Current state: Phases 1–3 complete (agent core, permission engine, voice pipeline). See `../docs/phases.md` for the roadmap.

## Run (Windows PowerShell, not WSL)
```powershell
npm install
npm run dev
```
Requires Node 20.19+ or 22.12+, plus Python on PATH (voice, TTS, and input automation helpers).

## Add your avatar
- Tray icon → right-click → **Load VRM model…** (path is remembered), or
- put a file at `assets/models/avatar.vrm`.

With no model loaded, a purple orb is shown so you can test dragging and click-through.

## Controls
| Action | How |
|---|---|
| Move | Left-drag the character |
| Menu | Right-click the character, or right-click the tray icon |
| Show/Hide | Left-click the tray icon (or Alt+M) |
| Chat input focus | Ctrl+Space |
| Emergency stop | Ctrl+Alt+X (from policy.json) |
| Push-to-talk | Ctrl+Alt+V (when Voice Mode is on) |
| Chat panel | 💬 button, gear settings, or tray → Chat Panel |
| Size | Menu → Size |

## Debug
```powershell
$env:COMPANION_DEVTOOLS=1; npm run dev
```

## Scripts
`npm run dev` · `npm run build` · `npm run start` (run built app) · `npm run typecheck` · `npm test` (acceptance tests)

Logs live in `%APPDATA%/ai-companion/logs/miko.log`; policy (trusted tools, timeouts) in `%APPDATA%/ai-companion/policy.json`.
