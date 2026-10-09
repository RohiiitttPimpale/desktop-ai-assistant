import { app, globalShortcut, ipcMain } from 'electron'
import fs from 'node:fs'
import path from 'node:path'
import { IPC, type AgentStepPayload } from '../shared/ipc'
import { createBrain, type Brain, type BrainReply } from './brain'
import { readModel } from './model'
import {
  createOverlay,
  endDrag,
  focusChatInput,
  getOverlay,
  isChatPanelOpen,
  setChatPanel,
  setFocusable,
  setInteractive,
  showOverlay,
  startDrag,
  toggleVisibility
} from './overlay'
import {
  captureScreenBase64,
  getActiveWindowTitle,
  getMaxAgentSteps,
  getPermissionLevel,
  runTools
} from './tools'
import { createTray, showContextMenu } from './tray'
import { synthesizeSpeech } from './tts'
import { getGlobalStopHotkey, getPolicy } from './policy'
import { setupVoiceIpc, handleRecordingComplete, handleVoiceResponse, setVoiceCallbacks, defaultVoiceCallbacks } from './voice/index'

// Import core pack to register tools
import './packs/core'
import { toolRegistry } from './registry'  // Force inclusion in bundle
// Import voice module for side effects (exports functions used via IPC)
import './voice/index'


let brain: Brain | null = null
let lastActiveWindow = ''
// One agent run at a time: concurrent runs would interleave on the shared
// brain history and the tool session.
let agentBusy = false
// Mirrors the renderer's Auto-Speak checkbox; when false, replies skip TTS.
let autospeakEnabled = true

// Cap renderer-fed audio (~27 MB decoded) so a compromised renderer cannot
// exhaust memory/disk through the STT temp-file path.
const MAX_AUDIO_B64_CHARS = 36_000_000

/**
 * Defense-in-depth: privileged IPC handlers only serve the overlay page.
 * The window never loads remote content, but if the renderer is ever
 * compromised, a foreign frame must not be able to drive the agent.
 */
function senderIsOverlay(e: { senderFrame?: { url?: string } | null }): boolean {
  const url = e.senderFrame?.url ?? ''
  const devUrl = process.env['ELECTRON_RENDERER_URL']
  return devUrl ? url.startsWith(devUrl) : url.startsWith('file://')
}

const SAVE_SHOT_RE = /take\s+(a\s+)?screenshot|save\s+(a\s+)?screenshot|screenshot\s+save/i
const CLICK_RE = /\b(click|double[\s-]*click|right[\s-]*click|press|tap)\b/i
const VISION_RE =
  /\b(my\s+screen|on\s+screen|look\s+at|see\s+on|what('s|\s+is)\s+(this|on)|read\s+this|explain\s+this|fix\s+this|error|bug|code)\b/i

// Tools that visibly change the screen — only these warrant a fresh screenshot
// for verification. Info-only tools (battery, system info, volume) leave the
// screen unchanged, so re-attaching a screenshot would only burn tokens.
const SCREEN_CHANGING_TOOLS = new Set([
  'click_screen',
  'type_text',
  'press_key',
  'scroll_page',
  'open_app',
  'open_url',
  'web_search',
  'play_youtube',
  'look_at_screen'
])

function loadApiKey(): string {
  // Precedence: runtime environment → .env file → build-time substitution (last
  // resort: electron-vite inlines MAIN_VITE_* at BUILD time, so a release build
  // made with this variable set would bake the key into the bundle).
  const envKey = process.env['MAIN_VITE_GEMINI_API_KEY'] || process.env['GEMINI_API_KEY']
  if (envKey && envKey.trim()) return envKey.trim()

  // App path BEFORE cwd: a stray .env in an unrelated working directory must
  // not silently substitute a different key.
  const candidates = [path.join(app.getAppPath(), '.env'), path.join(process.cwd(), '.env')]

  for (const envPath of candidates) {
    try {
      if (!fs.existsSync(envPath)) continue
      const raw = fs.readFileSync(envPath, 'utf-8').replace(/^\uFEFF/, '')
      for (const line of raw.split(/\r?\n/)) {
        const match = line.match(/^\s*(?:MAIN_VITE_)?GEMINI_API_KEY\s*=\s*(.+?)\s*$/)
        if (match) {
          const cleaned = match[1].replace(/^["']|["']$/g, '').trim()
          if (cleaned) return cleaned
        }
      }
    } catch {
      /* ignore read errors */
    }
  }

  const viteKey = (import.meta as unknown as { env?: Record<string, string> }).env?.MAIN_VITE_GEMINI_API_KEY
  return viteKey && viteKey.trim() ? viteKey.trim() : ''
}

function loadGroqApiKey(): string | undefined {
  const envKey = process.env['MAIN_VITE_GROQ_API_KEY'] || process.env['GROQ_API_KEY']
  if (envKey && envKey.trim()) return envKey.trim()
  const viteKey = (import.meta as unknown as { env?: Record<string, string> }).env?.MAIN_VITE_GROQ_API_KEY
  return viteKey && viteKey.trim() ? viteKey.trim() : undefined
}

function getBrain(): Brain {
  if (!brain) {
    brain = createBrain({ 
      apiKey: loadApiKey(), 
      groqApiKey: loadGroqApiKey()
    })
  }
  return brain
}

function emitAgentStep(payload: AgentStepPayload): void {
  const win = getOverlay()
  if (win && !win.isDestroyed()) {
    win.webContents.send(IPC.agentStep, payload)
  }
}

if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', showOverlay)
  app.on('window-all-closed', () => {})
  app.on('will-quit', () => globalShortcut.unregisterAll())

  app.whenReady().then(() => {
    ipcMain.on(IPC.setInteractive, (_e, interactive: unknown) => setInteractive(interactive === true))
    ipcMain.on(IPC.setFocusable, (_e, focusable: unknown) => {
      if (focusable === true) {
        void getActiveWindowTitle().then((title) => {
          if (title) lastActiveWindow = title
        })
      }
      setFocusable(focusable === true)
    })
    ipcMain.on(IPC.dragStart, startDrag)
    ipcMain.on(IPC.dragEnd, endDrag)
    ipcMain.on(IPC.contextMenu, showContextMenu)
    ipcMain.handle(IPC.getModel, () => readModel())
    ipcMain.handle(IPC.chatPanelGet, () => isChatPanelOpen())
    ipcMain.on(IPC.chatPanelSet, (e, open: unknown) => {
      if (senderIsOverlay(e) && typeof open === 'boolean') setChatPanel(open)
    })
    // Renderer reports its Auto-Speak setting so replies can skip TTS
    // synthesis entirely (saves ~1-2s latency + API usage per reply) when
    // the user has it disabled.
    ipcMain.on(IPC.ttsSetAutospeak, (e, enabled: unknown) => {
      if (senderIsOverlay(e) && typeof enabled === 'boolean') autospeakEnabled = enabled
    })

    // Voice IPC
    setupVoiceIpc()

    // Install voice wiring so the mic button works even before voice mode
    // (wake word) is enabled from the tray. Toggling voice mode only adds
    // the wake word and the Ctrl+Alt+V push-to-talk hotkey.
    setVoiceCallbacks(defaultVoiceCallbacks())
    
    // Voice IPC handlers - registered here to ensure handler functions are included in bundle
    ipcMain.on(IPC.voiceRecordingComplete, async (e: Electron.IpcMainEvent, audioBase64: string) => {
      if (!senderIsOverlay(e)) return;
      await handleRecordingComplete(audioBase64);
    });
    ipcMain.on(IPC.voiceResponse, async (e: Electron.IpcMainEvent, text: string) => {
      if (!senderIsOverlay(e)) return;
      await handleVoiceResponse(text);
    });

    ipcMain.handle(IPC.askBrain, async (e, payload: any) => {
      if (!senderIsOverlay(e)) {
        return { speech: 'Request rejected.', emotion: 'neutral', gesture: 'none', actions: [], done: true }
      }
      const prompt = String(payload?.text ?? '').trim()
      const rawAudio = typeof payload?.audioBase64 === 'string' ? payload.audioBase64 : null
      if (rawAudio && rawAudio.length > MAX_AUDIO_B64_CHARS) {
        return { speech: 'That recording is too large to process.', emotion: 'neutral', gesture: 'none', actions: [], done: true }
      }
      const audioBase64 = rawAudio

      if (!prompt && !audioBase64) {
        return { speech: 'Did you want to say something?', emotion: 'neutral', gesture: 'none', actions: [], done: true }
      }
      if (agentBusy) {
        return {
          speech: "I'm still working on your last request - give me a moment!",
          emotion: 'neutral',
          gesture: 'think',
          actions: [],
          done: true
        }
      }
      agentBusy = true
      try {
        // Reset abort controller for new request
        resetAbortController()
        const abortSignal = abortController.signal

        const b = getBrain()
        const wantsSaveShot = SAVE_SHOT_RE.test(prompt)
        const wantsClick = !wantsSaveShot && CLICK_RE.test(prompt)
        const wantsVision = !wantsSaveShot && (wantsClick || VISION_RE.test(prompt))

        let activeWindow = (await getActiveWindowTitle()) || lastActiveWindow
        let imageBase64: string | null = null
        if (wantsVision) {
          console.log('[vision] Pre-capturing screen for visual/click query...')
          imageBase64 = await captureScreenBase64()
        }

        let currentPrompt = prompt
        const allToolResults: string[] = []
        let finalReply: BrainReply | null = null
        const tabSession = { opened: false }
        const permissionLevel = getPermissionLevel()

        for (let step = 1; step <= getMaxAgentSteps(); step++) {
          // Check for emergency stop before each step
          if (abortSignal.aborted) {
            return { speech: 'Stopped by user (Ctrl+Alt+X)', emotion: 'neutral', gesture: 'none', actions: [], done: true }
          }

          console.log('[agent] Step ' + step + '/' + getMaxAgentSteps() + ' asking brain...')
          let reply = await b.ask(currentPrompt, { 
            activeWindow, 
            imageBase64, 
            permissionLevel, 
            userAudioBase64: step === 1 ? audioBase64 : null 
          })
          
          let forcedSingle = false
          if (reply.actions && reply.actions.length > 1) {
            console.log('[agent] Model attempted batching. Forcing single action execution.')
            reply.actions = [reply.actions[0]]
            reply.done = false
            forcedSingle = true
          }
          
          finalReply = reply

          const askedToLook = reply.actions.some((a) => a.tool === 'look_at_screen')
          if (askedToLook && !imageBase64) {
            console.log('[vision] Model requested look_at_screen, capturing now...')
            imageBase64 = await captureScreenBase64()
            if (imageBase64) {
              reply = await b.ask('Here is the screen capture for my request: ' + prompt, {
                activeWindow,
                imageBase64,
                permissionLevel
              })
              
              if (reply.actions && reply.actions.length > 1) {
                reply.actions = [reply.actions[0]]
                reply.done = false
                forcedSingle = true
              }
              finalReply = reply
            }
          }

          if (step === 1 && wantsClick && !reply.actions.some((a) => a.tool === 'click_screen') && imageBase64) {
            console.log('[vision] Re-prompting for exact click_screen coordinates...')
            reply = await b.ask(
              'Use the click_screen tool in actions with exact x (0-1000) and y (0-1000) coordinates from the attached image for: ' +
                prompt,
              { activeWindow, imageBase64, permissionLevel }
            )
            
            if (reply.actions && reply.actions.length > 1) {
              reply.actions = [reply.actions[0]]
              reply.done = false
              forcedSingle = true
            }
            finalReply = reply
          }

          if (step === 1 && reply.actions.length === 0 && wantsSaveShot) {
            reply.actions.push({ tool: 'take_screenshot', args: {} })
            reply.done = true
          }

          if (reply.actions.length === 0) {
            break
          }

          const stepResults = await runTools(reply.actions, tabSession, abortSignal)
          allToolResults.push(...stepResults)
          if (stepResults.length > 0) {
            b.noteToolResult(stepResults.join('; '))
          }

          if (reply.done || step === getMaxAgentSteps()) {
            break
          }

          emitAgentStep({
            step,
            speech: '[Step ' + step + '] ' + reply.speech,
            emotion: reply.emotion,
            gesture: reply.gesture,
            toolResults: stepResults
          })

          // Re-read the active window and (only if the last actions could have
          // changed the screen) grab a fresh screenshot — in parallel. After
          // info-only steps neither the window nor the screen changed.
          const affectsScreen = reply.actions.some((a) => SCREEN_CHANGING_TOOLS.has(a.tool))
          if (affectsScreen) {
            const [nextTitle, nextShot] = await Promise.all([
              getActiveWindowTitle(),
              captureScreenBase64()
            ])
            activeWindow = nextTitle || activeWindow
            imageBase64 = nextShot
          } else {
            imageBase64 = null
          }

          const prefix = forcedSingle
            ? 'WARNING: You attempted multiple actions. I ONLY executed the FIRST one: '
            : 'Previous actions executed: '

          currentPrompt =
            '[Autonomous Step ' +
            (step + 1) +
            ' of ' +
            getMaxAgentSteps() +
            '] ' +
            prefix +
            '(' +
            stepResults.join('; ') +
            ').' +
            (imageBase64
              ? ' CRITICAL VERIFICATION: Look at the attached screen. Did your action actually succeed? If the UI is still loading or incorrect, call "look_at_screen" to wait. If it is ready, output your NEXT single action.'
              : ' No screenshot is attached for this step. Call "look_at_screen" if you need to see the screen, otherwise output your NEXT single action.') +
            ' Set "done": false to continue or "done": true if the entire task is complete.'
        }

        const chosen = finalReply ?? {
          speech: 'All done!',
          emotion: 'happy',
          gesture: 'nod',
          actions: [],
          done: true
        }
        // Remember the freshest window title for the next request's fallback
        if (activeWindow) lastActiveWindow = activeWindow

        // Skip TTS synthesis entirely when the user disabled auto-speak
        // (the renderer would discard the audio anyway).
        const audio = autospeakEnabled ? await synthesizeSpeech(chosen.speech) : null
        return { ...chosen, toolResults: allToolResults, audio }
      } catch (err) {
        return {
          speech: (err as Error).message,
          emotion: 'sad',
          gesture: 'shrug',
          actions: [],
          done: true
        }
      } finally {
        agentBusy = false
      }
    })

    createOverlay()
    createTray()

    // Observability: a typo in policy.json trustedTools would otherwise
    // silently disable trust for that tool (important once Phase 4 adds
    // wa_send_file to the trusted list).
    const trustedWarnings = getPolicy().trustedTools.filter((t) => !toolRegistry.get(t))
    if (trustedWarnings.length > 0) {
      console.warn('[policy] trustedTools entries match no registered tool:', trustedWarnings.join(', '))
    }

    // Global abort controller for emergency stop
    let abortController = new AbortController()

    function resetAbortController(): void {
      abortController = new AbortController()
    }

    // Register emergency stop hotkey from policy
    const stopHotkey = getGlobalStopHotkey()
    try {
      globalShortcut.register(stopHotkey, () => {
        console.log('[agent] Emergency stop triggered via ' + stopHotkey)
        abortController.abort()
      })
    } catch (err) {
      console.error('[agent] Failed to register stop hotkey:', stopHotkey, err)
    }

    globalShortcut.register('Control+Space', async () => {
      const title = await getActiveWindowTitle()
      if (title) lastActiveWindow = title
      focusChatInput()
    })

    globalShortcut.register('Alt+M', () => {
      toggleVisibility()
    })

    // Reset abort controller on new request (handled in askBrain)
  })
}