# AI Companion: Phase 1 (transparent VRM overlay)

## Run (Windows PowerShell, not WSL)
```powershell
npm install
npm run dev
```
Requires Node 20.19+ or 22.12+.

## Add your avatar
- Tray icon → right-click → **Load VRM model…** (path is remembered), or
- put a file at `assets/models/avatar.vrm`.

With no model loaded, a purple orb is shown so you can test dragging and click-through.

## Controls
| Action | How |
|---|---|
| Move | Left-drag the character |
| Menu | Right-click the character, or right-click the tray icon |
| Show/Hide | Left-click the tray icon |
| Size | Menu → Size |
| Click-through | Automatic: transparent areas pass clicks to apps below |

## Debug
```powershell
$env:COMPANION_DEVTOOLS=1; npm run dev
```

## Scripts
`npm run dev` · `npm run build` · `npm run start` (run built app) · `npm run typecheck`
