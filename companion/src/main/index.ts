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
  runTools,
  setPermissionLevel
} from './tools'
import { createTray, showContextMenu } from './tray'
import { synthesizeSpeech } from './tts'
import { getGlobalStopHotkey } from './policy'
import { setupVoiceIpc, handleRecordingComplete, handleVoiceResponse, setVoiceCallbacks, defaultVoiceCallbacks } from './voice/index'

// Import core pack to register tools
import './packs/core'
import { toolRegistry } from './registry'  // Force inclusion in bundle
// Import voice module for side effects (exports functions used via IPC)
import './voice/index'


let brain: Brain | null = null
let lastActiveWindow = ''

const SAVE_SHOT_RE = /take\s+(a\s+)?screenshot|save\s+(a\s+)?screenshot|screenshot\s+save/i
const CLICK_RE = /\b(click|double[\s-]*click|right[\s-]*click|press|tap)\b/i
const VISION_RE =
  /\b(my\s+screen|on\s+screen|look\s+at|see\s+on|what('s|\s+is)\s+(this|on)|read\s+this|explain\s+this|fix\s+this|error|bug|code)\b/i

function loadApiKey(): string {
  const viteKey = (import.meta as unknown as { env?: Record<string, string> }).env?.MAIN_VITE_GEMINI_API_KEY
  const envKey = viteKey || process.env['MAIN_VITE_GEMINI_API_KEY'] || process.env['GEMINI_API_KEY']
  if (envKey && envKey.trim()) return envKey.trim()

  const candidates = [path.join(process.cwd(), '.env'), path.join(app.getAppPath(), '.env')]

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
  return ''
}

function loadGroqApiKey(): string | undefined {
  const viteKey = (import.meta as unknown as { env?: Record<string, string> }).env?.MAIN_VITE_GROQ_API_KEY
  const envKey = viteKey || process.env['MAIN_VITE_GROQ_API_KEY'] || process.env['GROQ_API_KEY']
  if (envKey && envKey.trim()) return envKey.trim()
  return undefined
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
    ipcMain.on(IPC.setPermission, (_e, level: unknown) => {
      if (typeof level === 'string' && ['read-only', 'only-browser', 'normal', 'full'].includes(level)) {
        setPermissionLevel(level as any)
      }
    })
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

    // Voice IPC
    setupVoiceIpc()

    // Install voice wiring so the mic button works even before voice mode
    // (wake word) is enabled from the tray. Toggling voice mode only adds
    // the wake word and the Ctrl+Alt+V push-to-talk hotkey.
    setVoiceCallbacks(defaultVoiceCallbacks())
    
    // Voice IPC handlers - registered here to ensure handler functions are included in bundle
    ipcMain.on('voice:recording-complete', async (_e: Electron.IpcMainEvent, audioBase64: string) => {
      await handleRecordingComplete(audioBase64);
    });
    ipcMain.on('voice:response', async (_e: Electron.IpcMainEvent, text: string) => {
      await handleVoiceResponse(text);
    });

    ipcMain.handle(IPC.askBrain, async (_e, payload: any) => {
      const prompt = String(payload?.text ?? '').trim()
      const audioBase64 = payload?.audioBase64 || null
      
      if (!prompt && !audioBase64) {
        return { speech: 'Did you want to say something?', emotion: 'neutral', gesture: 'none', actions: [], done: true }
      }
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

          activeWindow = (await getActiveWindowTitle()) || activeWindow
          imageBase64 = await captureScreenBase64()
          
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
            '). CRITICAL VERIFICATION: Look at the attached screen. Did your action actually succeed? If the UI is still loading or incorrect, call "look_at_screen" to wait. If it is ready, output your NEXT single action. Set "done": false to continue or "done": true if the entire task is complete.'
        }

        const chosen = finalReply ?? {
          speech: 'All done!',
          emotion: 'happy',
          gesture: 'nod',
          actions: [],
          done: true
        }

        const audio = await synthesizeSpeech(chosen.speech)
        return { ...chosen, toolResults: allToolResults, audio }
      } catch (err) {
        return {
          speech: (err as Error).message,
          emotion: 'sad',
          gesture: 'shrug',
          actions: [],
          done: true
        }
      }
    })

    createOverlay()
    createTray()

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