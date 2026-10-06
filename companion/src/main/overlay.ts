import { BrowserWindow, screen } from 'electron'
import { join } from 'node:path'
import { IPC } from '../shared/ipc'
import { SIZES, getConfig, updateConfig, type SizePreset } from './config'

let win: BrowserWindow | null = null
let dragTimer: ReturnType<typeof setInterval> | null = null
let cursorTimer: ReturnType<typeof setInterval> | null = null
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

function startCursorTracking(): void {
  if (cursorTimer) clearInterval(cursorTimer)
  cursorTimer = setInterval(() => {
    if (!win || win.isDestroyed() || !win.isVisible()) return
    const cursor = screen.getCursorScreenPoint()
    const b = win.getBounds()

    // Anchor at the avatar's head position (center X, 28% down from top of overlay window)
    const headX = b.x + b.width * 0.5
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
  let pos = cfg.position ?? defaultPosition(width, height)
  if (!isOnScreen(pos.x, pos.y, width, height)) pos = defaultPosition(width, height)

  win = new BrowserWindow({
    x: pos.x,
    y: pos.y,
    width,
    height,
    show: false,
    transparent: true,
    backgroundColor: '#00000000',
    frame: false,
    hasShadow: false,
    resizable: false,
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
    updateConfig({ position: { x, y } })
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
  const x = Math.round(old.x + old.width / 2 - width / 2)
  const y = old.y + old.height - height
  win.setBounds({ x, y, width, height })
  updateConfig({ size: preset, position: { x, y } })
}

export function resetPosition(): void {
  if (!win) return
  const { width, height } = win.getBounds()
  const { x, y } = defaultPosition(width, height)
  win.setBounds({ x, y, width, height })
  updateConfig({ position: { x, y } })
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

