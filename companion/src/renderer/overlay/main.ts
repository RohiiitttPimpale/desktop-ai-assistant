import * as THREE from 'three'
import { Avatar } from './avatar'
import { initChatPanel, addMessage, isPanelOpen } from './chatPanel'

const canvas = document.getElementById('scene') as HTMLCanvasElement
const hint = document.getElementById('hint') as HTMLDivElement
const bubble = document.getElementById('bubble') as HTMLDivElement
const chatForm = document.getElementById('chat-form') as HTMLFormElement
const chatInput = document.getElementById('chat-input') as HTMLInputElement

// --- Voice UI Injection ---
const style = document.createElement('style')
style.textContent = `
  #voice-controls { position: absolute; right: 0; bottom: 100%; margin-bottom: 8px; display: flex; gap: 8px; align-items: center; z-index: 100; }
  .miko-icon-btn { background: rgba(15,23,42,0.85); border: 1px solid #334155; border-radius: 50%; width: 36px; height: 36px; display: flex; align-items: center; justify-content: center; color: white; cursor: pointer; backdrop-filter: blur(4px); font-size: 16px; transition: all 0.2s; outline: none; box-shadow: 0 2px 6px rgba(0,0,0,0.4); }
  .miko-icon-btn:hover { background: rgba(30,41,59,0.95); transform: scale(1.05); }
  .miko-icon-btn.listening { background: rgba(239,68,68,0.2); border-color: #ef4444; color: #ef4444; animation: pulse-red 1.5s infinite; }
  .miko-icon-btn.active { background: rgba(139,92,246,0.45); border-color: #a78bfa; }
  #voice-settings-panel { position: absolute; right: 0; bottom: 100%; margin-bottom: 52px; background: rgba(15,23,42,0.95); border: 1px solid #334155; border-radius: 8px; padding: 12px; backdrop-filter: blur(8px); width: 240px; color: white; font-size: 12px; display: none; flex-direction: column; gap: 10px; z-index: 101; font-family: sans-serif; box-shadow: 0 4px 16px rgba(0,0,0,0.6); }
  #voice-settings-panel.open { display: flex; }
  .vs-row { display: flex; justify-content: space-between; align-items: center; }
  .vs-row input[type="range"] { width: 110px; cursor: pointer; }
  .vs-row select { width: 130px; background: #1e293b; color: white; border: 1px solid #475569; border-radius: 4px; padding: 4px; outline: none; }
  @keyframes pulse-red { 0% { box-shadow: 0 0 0 0 rgba(239, 68, 68, 0.7); } 70% { box-shadow: 0 0 0 12px rgba(239, 68, 68, 0); } 100% { box-shadow: 0 0 0 0 rgba(239, 68, 68, 0); } }
`
document.head.appendChild(style)

const controlsContainer = document.createElement('div')
controlsContainer.id = 'voice-controls'

const gearBtn = document.createElement('button')
gearBtn.id = 'gear-btn'
gearBtn.className = 'miko-icon-btn'
gearBtn.innerHTML = '⚙️'
gearBtn.type = 'button'

const micBtn = document.createElement('button')
micBtn.id = 'mic-btn'
micBtn.className = 'miko-icon-btn'
micBtn.innerHTML = '🎤'
micBtn.type = 'button'

const chatBtn = document.createElement('button')
chatBtn.id = 'chat-btn'
chatBtn.className = 'miko-icon-btn'
chatBtn.innerHTML = '💬'
chatBtn.title = 'Chat panel'
chatBtn.type = 'button'

controlsContainer.appendChild(gearBtn)
controlsContainer.appendChild(micBtn)
controlsContainer.appendChild(chatBtn)

chatForm.style.position = 'relative'
chatForm.appendChild(controlsContainer)

controlsContainer.addEventListener('mousedown', (e) => {
  e.stopPropagation()
  window.companion.setFocusable(true)
})

const settingsPanel = document.createElement('div')
settingsPanel.id = 'voice-settings-panel'
settingsPanel.innerHTML = `
  <div style="font-weight:bold; margin-bottom:4px; border-bottom:1px solid #334155; padding-bottom:6px; display:flex; justify-content:space-between;">
    Voice Settings <span id="close-vs" style="cursor:pointer; color:#ef4444; font-size:14px;">✖</span>
  </div>
  <div class="vs-row"><label>Auto-Speak Reply</label><input type="checkbox" id="vs-autospeak" checked></div>
  <div class="vs-row"><label>Chat Panel</label><input type="checkbox" id="vs-chatpanel"></div>
  <div class="vs-row"><label>Master Volume</label><input type="range" id="vs-volume" min="0" max="1" step="0.1" value="1"></div>
`
chatForm.appendChild(settingsPanel)

settingsPanel.addEventListener('mousedown', (e) => {
  e.stopPropagation()
  window.companion.setFocusable(true)
})

gearBtn.onclick = (e) => {
  e.preventDefault()
  settingsPanel.classList.toggle('open')
}
document.getElementById('close-vs')!.onclick = () => settingsPanel.classList.remove('open')

chatBtn.onclick = (e) => {
  e.preventDefault()
  window.companion.setChatPanel(!isPanelOpen())
}
document.getElementById('vs-chatpanel')!.addEventListener('change', (e) => {
  window.companion.setChatPanel((e.target as HTMLInputElement).checked)
})

const autospeakInput = document.getElementById('vs-autospeak') as HTMLInputElement | null
if (autospeakInput) {
  autospeakInput.addEventListener('change', () => window.companion.setAutospeak(autospeakInput.checked))
  // Report the initial state so the main process knows from the first reply
  window.companion.setAutospeak(autospeakInput.checked)
}

// --- Audio Playback ---
let audioCtx: AudioContext | null = null
let analyser: AnalyserNode | null = null
let gainNode: GainNode | null = null
let timeData: Uint8Array<ArrayBuffer> | null = null
let activeSource: AudioBufferSourceNode | null = null

function stopAudio(): void {
  if (activeSource) {
    try {
      activeSource.stop()
      activeSource.disconnect()
    } catch { }
    activeSource = null
  }
  avatar.setMouthVolume(0)
  avatar.setSpeaking(false)
}

async function playVoice(text: string, audioBytes?: Uint8Array | null): Promise<void> {
  stopAudio()
  const autoSpeak = (document.getElementById('vs-autospeak') as HTMLInputElement)?.checked ?? true
  if (!autoSpeak || !audioBytes || audioBytes.byteLength === 0) return

  const volInput = document.getElementById('vs-volume') as HTMLInputElement
  const targetVolume = volInput ? parseFloat(volInput.value) : 1.0

  try {
    if (!audioCtx) {
      audioCtx = new AudioContext()
      gainNode = audioCtx.createGain()
      analyser = audioCtx.createAnalyser()
      analyser.fftSize = 256
      timeData = new Uint8Array(new ArrayBuffer(analyser.fftSize))
      gainNode.connect(analyser)
      analyser.connect(audioCtx.destination)
    }
    if (audioCtx.state === 'suspended') await audioCtx.resume()

    if (gainNode) gainNode.gain.value = targetVolume

    const copy = audioBytes.buffer.slice(audioBytes.byteOffset, audioBytes.byteOffset + audioBytes.byteLength) as ArrayBuffer
    const decoded = await audioCtx.decodeAudioData(copy)

    const source = audioCtx.createBufferSource()
    source.buffer = decoded
    source.connect(gainNode!)
    activeSource = source
    avatar.setSpeaking(true)

    source.onended = () => {
      if (activeSource === source) {
        activeSource = null
        avatar.setMouthVolume(0)
        avatar.setSpeaking(false)
      }
    }
    source.start(0)
  } catch (err) {
    console.warn('[audio] Web Audio decode failed:', err)
  }
}

function updateLipSync(): void {
  if (!activeSource || !analyser || !timeData) return
  analyser.getByteTimeDomainData(timeData)
  let sumSq = 0
  for (let i = 0; i < timeData.length; i++) {
    const norm = (timeData[i] - 128) / 128
    sumSq += norm * norm
  }
  avatar.setMouthVolume(Math.min(1, Math.sqrt(sumSq / timeData.length) * 4.2))
}

// --- Native MediaRecorder (Audio Input) ---
let mediaRecorder: MediaRecorder | null = null
let audioChunks: Blob[] = []
let isRecording = false

export function startVoiceRecording(): void {
  micBtn.click()
}

micBtn.onclick = async (e) => {
  e.preventDefault()
  stopAudio() 

  if (isRecording && mediaRecorder) {
    mediaRecorder.stop()
    return
  }

  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
    mediaRecorder = new MediaRecorder(stream, { mimeType: 'audio/webm' })
    audioChunks = []

    mediaRecorder.ondataavailable = (ev) => {
      if (ev.data.size > 0) audioChunks.push(ev.data)
    }

    mediaRecorder.onstop = () => {
      isRecording = false
      micBtn.classList.remove('listening')
      chatInput.placeholder = 'Type a message...'
      
      const blob = new Blob(audioChunks, { type: 'audio/webm' })
      const reader = new FileReader()
      reader.readAsDataURL(blob)
      reader.onloadend = () => {
        const base64 = (reader.result as string).split(',')[1]
        window.companion.sendVoiceRecordingComplete(base64)
      }
      
      stream.getTracks().forEach(t => t.stop())
    }

    mediaRecorder.start()
    isRecording = true
    micBtn.classList.add('listening')
    chatInput.value = ''
    chatInput.placeholder = '🎙️ Recording... (Click Mic to stop)'
    chatInput.disabled = true
  } catch (err) {
    showBubble('Microphone access denied! Check Windows Privacy settings.', 5000)
  }
}

// --- Submission Logic ---
// One agent run at a time. Tracked separately from chatInput.disabled,
// which is ALSO set during voice recording — conflating the two broke the
// voice flow (transcripts were dropped because the input looked "busy").
let agentRunning = false

async function submitToBrain(text: string, audioBase64?: string) {
  if (!text && !audioBase64) return
  if (agentRunning) return // one agent run at a time
  agentRunning = true
  if (text) addMessage('user', text)
  chatInput.value = ''
  chatInput.disabled = true
  showBubble('Thinking...', 20000)
  avatar.setReaction('neutral', 'think')

  try {
    const reply = await window.companion.askBrain({ text, audioBase64 })
    const extra = reply.toolResults?.length ? reply.toolResults.join(' -> ') : undefined
    showBubble(reply.speech, 12000, extra)
    avatar.setReaction(reply.emotion, reply.gesture)
    void playVoice(reply.speech, reply.audio)
  } catch (err) {
    showBubble('Error: ' + (err instanceof Error ? err.message : String(err)))
    avatar.setReaction('sad', 'shrug')
  } finally {
    agentRunning = false
    chatInput.disabled = false
    pointer.dirty = true
    chatInput.focus()
  }
}

chatForm.addEventListener('submit', (e) => {
  e.preventDefault()
  if (!chatInput.disabled && !agentRunning) submitToBrain(chatInput.value.trim())
})

chatInput.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    chatInput.blur()
    window.companion.setFocusable(false)
    pointer.dirty = true
  }
  if (e.key !== 'Enter') {
     stopAudio()
     if (isRecording && mediaRecorder) mediaRecorder.stop()
  }
})

// --- Renderer Setup & Three.js ---
const renderer = new THREE.WebGLRenderer({ canvas, alpha: true, antialias: true, premultipliedAlpha: true })
renderer.setClearColor(0x000000, 0)
const avatar = new Avatar()

function resize(): void {
  // Size to the canvas region: full window when the panel is closed,
  // the right-hand area when the panel is open (canvas is CSS-anchored there)
  const w = canvas.clientWidth || window.innerWidth
  const h = canvas.clientHeight || window.innerHeight
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
  renderer.setSize(w, h, false)
  avatar.resize(w, h)
}
window.addEventListener('resize', resize)
new ResizeObserver(() => resize()).observe(canvas)
resize()

function setHint(text: string | null): void {
  hint.hidden = text === null
  hint.textContent = text ?? ''
}

let bubbleTimer: ReturnType<typeof setTimeout> | null = null
function showBubble(text: string, durationMs = 9000, sub?: string): void {
  // Always record into the chat transcript
  addMessage('miko', text, sub)
  // With the panel open the transcript shows it; never put text on the avatar
  if (isPanelOpen()) return
  const full = sub ? text + '\n(' + sub + ')' : text
  if (bubbleTimer) clearTimeout(bubbleTimer)
  bubble.textContent = full
  bubble.hidden = false
  bubbleTimer = setTimeout(() => { bubble.hidden = true }, durationMs)
}

async function loadModel(): Promise<void> {
  try {
    const model = await window.companion.getModel()
    if (!model) {
      avatar.showPlaceholder()
      setHint('Right-click tray to load a VRM model.')
      return
    }
    const buffer = model.data.buffer.slice(model.data.byteOffset, model.data.byteOffset + model.data.byteLength) as ArrayBuffer
    await avatar.load(buffer)
    setHint(null)
  } catch (err) {
    avatar.showPlaceholder()
    setHint('Failed to load model.')
  }
}

window.companion.onModelChanged(() => void loadModel())
window.companion.onCursorMove((nx, ny) => avatar.setLookTarget(nx, ny))
window.companion.onFocusChat(() => { chatInput.focus(); pointer.dirty = true })
window.companion.onAgentStep((step) => {
  showBubble(step.speech, 15000, step.toolResults.join(', ') || undefined)
  avatar.setReaction(step.emotion, step.gesture)
})

// Voice IPC handlers
window.companion.onVoiceWake(() => {
  micBtn.classList.add('listening')
  chatInput.placeholder = '🎙️ Listening...'
  showBubble('Yes?', 3000)
})

window.companion.onVoiceStartRecording(() => {
  startVoiceRecording()
})

window.companion.onVoiceTranscript((text: string) => {
  chatInput.value = text
  micBtn.classList.remove('listening')
  // Recording is done — re-enable the input (it was disabled while
  // recording). If an agent run is still active, keep the transcript in
  // the input for the user to send when it finishes.
  if (agentRunning) return
  chatInput.disabled = false
  chatInput.placeholder = 'Type a message...'
  submitToBrain(text)
})

window.companion.onVoiceResponse((speech: string, audio: Uint8Array | null) => {
  showBubble(speech, 12000)
  avatar.setReaction('happy', 'nod')
  void playVoice(speech, audio)
})

window.companion.onVoiceError((error: string) => {
  showBubble(`Voice error: ${error}`, 5000)
  micBtn.classList.remove('listening')
  chatInput.disabled = false
  chatInput.placeholder = 'Type a message...'
})

void initChatPanel()
void loadModel()

const pointer = { x: 0, y: 0, inside: false, dirty: false }
const pixel = new Uint8Array(4)
let hovering = false
let dragging = false

function isOverChat(): boolean {
  if (!pointer.inside) return false
  const r = chatForm.getBoundingClientRect()
  return pointer.x >= r.left - 6 && pointer.x <= r.right + 6 && pointer.y >= r.top - 280 && pointer.y <= r.bottom + 6
}

function isOverChatPanel(): boolean {
  if (!pointer.inside || !isPanelOpen()) return false
  const panel = document.getElementById('chat-panel')
  if (!panel) return false
  const r = panel.getBoundingClientRect()
  return pointer.x >= r.left && pointer.x <= r.right && pointer.y >= r.top && pointer.y <= r.bottom
}

function isOverAvatar(): boolean {
  if (!pointer.inside) return false
  if (isOverChat() || isOverChatPanel()) return true
  const gl = renderer.getContext()
  const rect = canvas.getBoundingClientRect()
  const x = Math.floor((pointer.x - rect.left) * (canvas.width / rect.width))
  const y = canvas.height - 1 - Math.floor((pointer.y - rect.top) * (canvas.height / rect.height))
  if (x < 0 || y < 0 || x >= canvas.width || y >= canvas.height) return false
  gl.readPixels(x, y, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, pixel)
  return pixel[3] > 16
}

window.addEventListener('mousemove', (e) => { pointer.x = e.clientX; pointer.y = e.clientY; pointer.inside = true; pointer.dirty = true })
document.addEventListener('mouseleave', () => { pointer.inside = false; pointer.dirty = true })

window.addEventListener('mousedown', (e) => {
  if (e.button !== 0 || !hovering || isOverChat() || isOverChatPanel()) return
  dragging = true
  canvas.style.cursor = 'grabbing'
  window.companion.dragStart()
})
window.addEventListener('mouseup', () => {
  if (!dragging) return
  dragging = false
  canvas.style.cursor = 'grab'
  window.companion.dragEnd()
  pointer.dirty = true
})
window.addEventListener('contextmenu', (e) => {
  e.preventDefault()
  if (hovering && !isOverChatPanel()) window.companion.showContextMenu()
})

let last = performance.now()
function tick(now: number): void {
  requestAnimationFrame(tick)
  // backgroundThrottling is disabled, so rAF keeps firing even while the
  // overlay is hidden (Alt+M / tray) — skip all render work in that case.
  if (document.hidden) return
  const delta = Math.min((now - last) / 1000, 0.1)
  last = now

  updateLipSync()
  avatar.update(delta, now / 1000)
  renderer.render(avatar.scene, avatar.camera)

  if (pointer.dirty) {
    pointer.dirty = false
    const over = isOverAvatar() || document.activeElement === chatInput
    if (!dragging && over !== hovering) {
      hovering = over
      canvas.style.cursor = over && !isOverChat() && !isOverChatPanel() ? 'grab' : 'default'
      window.companion.setInteractive(over)
    }
  }
}
requestAnimationFrame(tick)
