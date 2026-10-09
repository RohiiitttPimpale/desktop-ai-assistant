import { app, BrowserWindow, screen } from 'electron'
import { join } from 'node:path'
import { CHAT_PANEL_WIDTH, IPC } from '../shared/ipc'
import { SIZES, getConfig, updateConfig, type SizePreset } from './config'

let win: BrowserWindow | null = null
let chatPanelOpen = false
let dragTimer: ReturnType<typeof setInterval> | null = null
let cursorTimer: ReturnType<typeof setInterval> | null = null

// Quit intent: the overlay's close guard lets the app shut down cleanly.
let quitting = false
app.on('before-quit', () => {
  quitting = true
  if (win && !win.isDestroyed()) win.destroy()
})
let lastSentX = 999
let lastSentY = 999

export const getOverlay = (): BrowserWindow | null => win

function defaultPosition(width: number, height: number): { x: number; y: number } {
  const area = screen.getPrimaryDisplay().workArea
  return { x: area.x + area.width - width - 24, y: area.y + area.height - height }
}

function isOnScreen(x: number, y: number, width: number, height: number): boolean {
  return screen.getAllDisplays().some(({ workArea: a }) => {
    return x + width > a.x + 40 && x < a.x + a.width - 40 && y + height > a.y + 40 && y < a.y + a.height - 40
  })
}

/** Clamp a window x so it does not spill past the left edge of its display. */
function clampLeft(x: number, y: number, width: number, height: number): number {
  const area = screen.getDisplayMatching({ x, y, width, height }).workArea
  return Math.max(area.x, x)
}

function startCursorTracking(): void {
  if (cursorTimer) clearInterval(cursorTimer)
  cursorTimer = setInterval(() => {
    if (!win || win.isDestroyed() || !win.isVisible()) return
    const cursor = screen.getCursorScreenPoint()
    const b = win.getBounds()

    // Anchor at the avatar's head position (center X of the avatar region,
    // 28% down from top of overlay window). With the chat panel open the
    // avatar occupies only the right part of the window.
    const headX = b.x + (chatPanelOpen ? CHAT_PANEL_WIDTH + (b.width - CHAT_PANEL_WIDTH) / 2 : b.width * 0.5)
    const headY = b.y + b.height * 0.28

    const nx = Math.max(-1, Math.min(1, (cursor.x - headX) / 700))
    const ny = Math.max(-1, Math.min(1, (headY - cursor.y) / 500))

    if (Math.abs(nx - lastSentX) > 0.008 || Math.abs(ny - lastSentY) > 0.008) {
      lastSentX = nx
      lastSentY = ny
      win.webContents.send(IPC.cursorMove, nx, ny)
    }
  }, 33)
}

function stopCursorTracking(): void {
  if (cursorTimer) clearInterval(cursorTimer)
  cursorTimer = null
}

export function createOverlay(): BrowserWindow {
  const cfg = getConfig()
  const { width, height } = SIZES[cfg.size]
  chatPanelOpen = Boolean(cfg.chatPanel)
  const windowWidth = chatPanelOpen ? width + CHAT_PANEL_WIDTH : width
  let pos = cfg.position ?? defaultPosition(width, height)
  if (chatPanelOpen) pos = { x: pos.x - CHAT_PANEL_WIDTH, y: pos.y }
  if (!isOnScreen(pos.x, pos.y, windowWidth, height)) {
    pos = defaultPosition(width, height)
    if (chatPanelOpen) pos = { x: pos.x - CHAT_PANEL_WIDTH, y: pos.y }
  }
  if (chatPanelOpen) pos.x = clampLeft(pos.x, pos.y, windowWidth, height)

  win = new BrowserWindow({
    x: pos.x,
    y: pos.y,
    width: windowWidth,
    height,
    show: false,
    transparent: true,
    backgroundColor: '#00000000',
    frame: false,
    hasShadow: false,
    resizable: false,
    // Miko must never be closed by keyboard: alt+F4 (sent by her own
    // press_key tool while the overlay had focus) used to make the avatar
    // vanish while the app kept running in the tray.
    closable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      backgroundThrottling: false
    }
  })

  win.setSkipTaskbar(true)
  win.setAlwaysOnTop(true, 'screen-saver')
  win.setIgnoreMouseEvents(true, { forward: true })

  // Second line of defence: any programmatic close just hides the window
  // unless the whole app is quitting. Miko can lose focus, never herself.
  win.on('close', (e) => {
    if (!quitting) {
      e.preventDefault()
      win?.hide()
    }
  })

  // If the renderer ever crashes (GPU/three.js issues after hours of use),
  // reload the overlay instead of leaving an invisible dead window.
  win.webContents.on('render-process-gone', (_e, details) => {
    console.error('[overlay] Renderer gone:', details.reason, '- reloading overlay')
    if (!win || win.isDestroyed()) return
    const devUrl = process.env['ELECTRON_RENDERER_URL']
    if (devUrl) void win.loadURL(`${devUrl}/overlay/index.html`)
    else void win.loadFile(join(__dirname, '../renderer/overlay/index.html'))
  })

  // Security: the overlay must only ever show local app content. Deny all
  // window.open and block any navigation away from the app (registered after
  // the initial load so startup navigation is unaffected).
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  win.webContents.once('did-finish-load', () => {
    win?.webContents.on('will-navigate', (e, url) => {
      const devUrl = process.env['ELECTRON_RENDERER_URL']
      const allowed = devUrl ? url.startsWith(devUrl) : url.startsWith('file://')
      if (!allowed) e.preventDefault()
    })
  })

  win.once('ready-to-show', () => {
    win?.showInactive()
    startCursorTracking()
  })
  win.on('closed', () => {
    stopDragTimer()
    stopCursorTracking()
    win = null
  })

  const devUrl = process.env['ELECTRON_RENDERER_URL']
  if (devUrl) {
    void win.loadURL(`${devUrl}/overlay/index.html`)
  } else {
    void win.loadFile(join(__dirname, '../renderer/overlay/index.html'))
  }

  if (process.env['COMPANION_DEVTOOLS']) {
    win.webContents.openDevTools({ mode: 'detach' })
  }

  return win
}

export function setInteractive(interactive: boolean): void {
  if (!win || dragTimer) return
  if (interactive) win.setIgnoreMouseEvents(false)
  else win.setIgnoreMouseEvents(true, { forward: true })
}

export function setFocusable(focusable: boolean): void {
  if (!win) return
  if (focusable) {
    win.setIgnoreMouseEvents(false)
    win.focus()
    win.webContents.focus()
  } else {
    win.blur()
  }
}

export function isChatPanelOpen(): boolean {
  return chatPanelOpen
}

/**
 * Opens/closes the chat panel by expanding/shrinking the window on its left
 * side. The avatar stays at its on-screen position (the window grows left).
 * The saved config position always stores the avatar-only window anchor.
 */
export function setChatPanel(open: boolean): void {
  if (!win || win.isDestroyed()) return
  if (open === chatPanelOpen) return
  if (dragTimer) return // never fight an active drag

  const b = win.getBounds()
  const nextWidth = open ? b.width + CHAT_PANEL_WIDTH : b.width - CHAT_PANEL_WIDTH
  const rawX = open ? b.x - CHAT_PANEL_WIDTH : b.x + CHAT_PANEL_WIDTH
  const x = open ? clampLeft(rawX, b.y, nextWidth, b.height) : rawX

  win.setBounds({ x, y: b.y, width: nextWidth, height: b.height })
  chatPanelOpen = open
  updateConfig({ chatPanel: open, position: { x: open ? x + CHAT_PANEL_WIDTH : x, y: b.y } })
  win.webContents.send(IPC.chatPanelChanged, open)
}

export function startDrag(): void {
  if (!win || dragTimer) return
  const startCursor = screen.getCursorScreenPoint()
  const start = win.getBounds()
  dragTimer = setInterval(() => {
    if (!win || !win.isVisible()) return stopDragTimer()
    const cursor = screen.getCursorScreenPoint()
    win.setBounds({
      x: Math.round(start.x + cursor.x - startCursor.x),
      y: Math.round(start.y + cursor.y - startCursor.y),
      width: start.width,
      height: start.height
    })
  }, 8)
}

export function endDrag(): void {
  if (!dragTimer) return
  stopDragTimer()
  if (win) {
    const { x, y } = win.getBounds()
    // Persist the avatar-only anchor so panel state never shifts the restore position
    updateConfig({ position: { x: chatPanelOpen ? x + CHAT_PANEL_WIDTH : x, y } })
  }
}

function stopDragTimer(): void {
  if (dragTimer) clearInterval(dragTimer)
  dragTimer = null
}

export function toggleVisibility(): void {
  if (!win) return
  if (win.isVisible()) win.hide()
  else win.showInactive()
}

export function showOverlay(): void {
  if (win && !win.isVisible()) win.showInactive()
}

export function setSize(preset: SizePreset): void {
  if (!win) return
  const old = win.getBounds()
  const { width, height } = SIZES[preset]
  // Keep the avatar region centered horizontally, anchored at the bottom
  const oldAvatarWidth = chatPanelOpen ? old.width - CHAT_PANEL_WIDTH : old.width
  const avatarCenterX = old.x + (chatPanelOpen ? CHAT_PANEL_WIDTH : 0) + oldAvatarWidth / 2
  const x = Math.round(avatarCenterX - width / 2 - (chatPanelOpen ? CHAT_PANEL_WIDTH : 0))
  const y = old.y + old.height - height
  const windowWidth = chatPanelOpen ? width + CHAT_PANEL_WIDTH : width
  win.setBounds({ x, y, width: windowWidth, height })
  updateConfig({ size: preset, position: { x: chatPanelOpen ? x + CHAT_PANEL_WIDTH : x, y } })
}

export function resetPosition(): void {
  if (!win) return
  const { width, height } = win.getBounds()
  const { x, y } = defaultPosition(width, height)
  win.setBounds({ x, y, width, height })
  updateConfig({ position: { x: chatPanelOpen ? x + CHAT_PANEL_WIDTH : x, y } })
}

export function setOnTop(onTop: boolean): void {
  if (!win) return
  if (onTop) win.setAlwaysOnTop(true, 'screen-saver')
  else win.setAlwaysOnTop(false)
}

export function focusChatInput(): void {
  if (!win) return
  if (!win.isVisible()) win.show()
  win.setIgnoreMouseEvents(false)
  win.focus()
  win.webContents.focus()
  win.webContents.send(IPC.focusChat)
}

export function notifyModelChanged(): void {
  win?.webContents.send(IPC.modelChanged)
}

