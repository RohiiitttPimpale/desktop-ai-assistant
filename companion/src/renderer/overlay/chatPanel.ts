// ChatGPT-style transcript panel shown to the left of the avatar.
// DOM skeleton lives in index.html (#chat-panel); this module owns the
// transcript state, message rendering and the open/close wiring that is
// shared with the main process over IPC.
import { CHAT_PANEL_WIDTH } from '../../shared/ipc'

const MAX_MESSAGES = 100

interface PanelMessage {
  role: 'user' | 'miko'
  text: string
  sub?: string
}

let messages: PanelMessage[] = []
let panelOpen = false

export function isPanelOpen(): boolean {
  return panelOpen
}

function applyPanelOpen(open: boolean): void {
  panelOpen = open
  document.body.classList.toggle('panel-open', open)
  document.getElementById('chat-btn')?.classList.toggle('active', open)
  const checkbox = document.getElementById('vs-chatpanel') as HTMLInputElement | null
  if (checkbox) checkbox.checked = open
  if (open) {
    // Any floating bubble still on the avatar is replaced by the panel
    document.getElementById('bubble')?.setAttribute('hidden', '')
  }
}

export function addMessage(role: 'user' | 'miko', text: string, sub?: string): void {
  if (!text && !sub) return
  messages.push({ role, text, sub })
  if (messages.length > MAX_MESSAGES) messages = messages.slice(-MAX_MESSAGES)
  renderMessage(messages[messages.length - 1])
}

function renderMessage(msg: PanelMessage): void {
  const list = document.getElementById('chat-messages')
  if (!list) return

  const row = document.createElement('div')
  row.className = 'cp-msg ' + msg.role

  const bubble = document.createElement('div')
  bubble.className = 'cp-bubble'
  bubble.textContent = msg.text
  row.appendChild(bubble)

  if (msg.sub) {
    const subEl = document.createElement('div')
    subEl.className = 'cp-sub'
    subEl.textContent = msg.sub
    row.appendChild(subEl)
  }

  // Keep the DOM in sync with the transcript cap
  while (list.children.length > MAX_MESSAGES) list.removeChild(list.firstChild as ChildNode)
  list.appendChild(row)
  list.scrollTop = list.scrollHeight
}

export async function initChatPanel(): Promise<void> {
  // Single source of truth for the window expansion width (matches main process)
  document.documentElement.style.setProperty('--panel-expand', CHAT_PANEL_WIDTH + 'px')

  document.getElementById('chat-panel-close')?.addEventListener('click', (e) => {
    e.stopPropagation()
    window.companion.setChatPanel(false)
  })

  window.companion.onChatPanelChanged((open) => applyPanelOpen(open))

  const initial = await window.companion.getChatPanel()
  applyPanelOpen(initial)
}
