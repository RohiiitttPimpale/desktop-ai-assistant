const API_ROOT = 'https://generativelanguage.googleapis.com/v1beta/models'
const GROQ_API_ROOT = 'https://api.groq.com/openai/v1'
const FALLBACK_MODELS = ['gemini-3.8-flash', 'gemini-3.5-flash', 'gemini-flash-latest']
const GROQ_FALLBACK_MODELS = ['llama-3.3-70b-versatile', 'llama-3.1-8b-instant']

export const EMOTIONS = ['neutral', 'happy', 'sad', 'angry', 'surprised', 'relaxed'] as const
export const GESTURES = ['none', 'nod', 'wave', 'shrug', 'think'] as const

export type Emotion = (typeof EMOTIONS)[number]
export type Gesture = (typeof GESTURES)[number]

export interface BrainAction {
  tool: string
  args: Record<string, unknown>
}

export interface BrainReply {
  speech: string
  emotion: Emotion
  gesture: Gesture
  actions: BrainAction[]
  done: boolean
}

export interface BrainOptions {
  apiKey: string
  groqApiKey?: string
  model?: string
  maxHistory?: number
  maxRetries?: number
  timeoutMs?: number
}

interface Part {
  text?: string
  inlineData?: {
    mimeType: string
    data: string
  }
}

interface Turn {
  role: 'user' | 'model'
  parts: Part[]
}

interface GroqMessage {
  role: 'system' | 'user' | 'assistant'
  content: string
}

interface GroqRequestBody {
  messages: GroqMessage[]
  temperature: number
  max_tokens: number
  response_format: { type: 'json_object' }
}

const PERSONA_RULES = [
  "You are Miko, an autonomous anime desktop companion and browser agent living on the user's screen.",
  'Style: warm, playful, concise. Speak in 1-3 short sentences.',
  'SINGLE-TAB RULE: Never open multiple tabs for one task! Once a browser tab is open on screen, stay in that SAME tab:',
  'CRITICAL RULE: You MUST output exactly ONE tool action per step. NEVER batch multiple items in the "actions" array.',
  'PHYSICAL PC CONTROL & VERIFICATION RULE: You are driving a real computer. It takes time to load apps and dialogs!',
  '1. NEVER assume an action succeeded. ALWAYS visually verify the screen state before taking the next step.',
  '2. If you open an app, wait to see it on screen before typing. If you press "ctrl+s", wait to see the "Save As" dialog.',
  '3. If the UI is not ready yet, use the "look_at_screen" tool to wait and grab a fresh frame.',
].join('\n')

import { toolRegistry } from './registry'

function buildPersona(): string {
  const toolLines = toolRegistry.getAll().map((t) => `- ${t.name}: ${t.description}`)
  return PERSONA_RULES + '\nAvailable tools for the "actions" array:\n' + toolLines.join('\n')
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

function sanitize(raw: unknown, toolNames: string[]): BrainReply | null {
  if (!raw || typeof raw !== 'object') return null
  const r = raw as Record<string, unknown>
  if (typeof r.speech !== 'string' || !r.speech.trim()) return null
  const actions: BrainAction[] = []
  if (Array.isArray(r.actions)) {
    for (const a of r.actions as Record<string, unknown>[]) {
      if (!a || typeof a.tool !== 'string' || !toolNames.includes(a.tool)) continue
      let args: Record<string, unknown> = {}
      if (typeof a.query === 'string' && a.query.trim()) args.query = a.query.trim()
      if (typeof a.url === 'string' && a.url.trim()) args.url = a.url.trim()
      if (typeof a.x === 'number' && Number.isFinite(a.x)) args.x = a.x
      if (typeof a.y === 'number' && Number.isFinite(a.y)) args.y = a.y
      if (typeof a.button === 'string' && a.button.trim()) args.button = a.button.trim()
      if (typeof a.text === 'string' && a.text.trim()) args.text = a.text.trim()
      if (typeof a.key === 'string' && a.key.trim()) args.key = a.key.trim()
      if (typeof a.direction === 'string' && a.direction.trim()) args.direction = a.direction.trim()
      if (typeof a.app === 'string' && a.app.trim()) args.app = a.app.trim()
      if (typeof a.mode === 'string' && a.mode.trim()) args.mode = a.mode.trim()
      actions.push({ tool: a.tool, args })
    }
  }
  return {
    speech: r.speech.trim(),
    emotion: (EMOTIONS as readonly unknown[]).includes(r.emotion) ? (r.emotion as Emotion) : 'neutral',
    gesture: (GESTURES as readonly unknown[]).includes(r.gesture) ? (r.gesture as Gesture) : 'none',
    actions,
    done: typeof r.done === 'boolean' ? r.done : actions.length === 0
  }
}

export interface BrainContext {
  activeWindow?: string
  imageBase64?: string | null
  permissionLevel?: string
  userAudioBase64?: string | null
}

export interface Brain {
  ask(userText: string, context?: BrainContext): Promise<BrainReply>
  noteToolResult(summary: string): void
  reset(): void
}

let toolNamesCache: string[] | null = null

function getToolNames(): string[] {
  if (toolNamesCache === null) {
    toolNamesCache = toolRegistry.getNames() ?? []
  }
  return toolNamesCache
}

function getSchemaForLLM(): Record<string, unknown> {
  return toolRegistry.getSchemaForLLM()
}

export function createBrain(opts: BrainOptions): Brain {
  const { apiKey, groqApiKey, model, maxHistory = 14, timeoutMs = 15000 } = opts
  if (!apiKey) throw new Error('Gemini API key is missing (set MAIN_VITE_GEMINI_API_KEY in .env)')

  let geminiModelPool: string[] | null = model ? [model] : null
  let groqModelPool: string[] = []
  let preferredIdx = 0
  const persona = buildPersona()
  const schema = getSchemaForLLM()
  const toolNames = getToolNames()
  let history: Turn[] = []

  const pushTurn = (role: 'user' | 'model', text: string): void => {
    const last = history[history.length - 1]
    if (last && last.role === role) last.parts.push({ text })
    else history.push({ role, parts: [{ text }] })
    if (history.length > maxHistory) history = history.slice(-maxHistory)
    while (history.length && history[0].role !== 'user') history.shift()
  }

  async function resolveGeminiModels(): Promise<string[]> {
    if (geminiModelPool && geminiModelPool.length > 0) return geminiModelPool
    try {
      const res = await fetch(API_ROOT + '?key=' + apiKey, { signal: AbortSignal.timeout(6000) })
      if (res.ok) {
        const data = (await res.json()) as any
        const available = (data.models ?? [])
          .filter((m: any) => m.supportedGenerationMethods?.includes('generateContent'))
          .map((m: any) => m.name.replace(/^models\//, ''))
          .filter((n: string) => n.includes('flash') && !n.includes('tts') && !n.includes('audio'))
        
        if (available.length > 0) {
          const priority = ['gemini-3.8-flash', 'gemini-3.5-flash', 'gemini-flash-latest']
          const pool = [...priority.filter(x => available.includes(x)), ...available.filter((x: string) => !priority.includes(x))]
          geminiModelPool = pool
          console.log('[brain] Live Flash pool mapped (' + pool.length + ' models)')
          return pool
        }
      }
    } catch {}
    geminiModelPool = [...FALLBACK_MODELS]
    return geminiModelPool
  }

  async function resolveGroqModels(): Promise<string[]> {
    if (!groqApiKey) return []
    if (groqModelPool && groqModelPool.length > 0) return groqModelPool
    try {
      const res = await fetch(GROQ_API_ROOT + '/models', {
        headers: { 'Authorization': 'Bearer ' + groqApiKey },
        signal: AbortSignal.timeout(6000)
      })
      if (res.ok) {
        const data = (await res.json()) as any
        const available = (data.data ?? [])
          .filter((m: any) => m.active)
          .map((m: any) => m.id)
        
        if (available.length > 0) {
          groqModelPool = available
          console.log('[brain] Groq models available (' + groqModelPool.length + ' models)')
          return groqModelPool
        }
      }
    } catch {}
    groqModelPool = [...GROQ_FALLBACK_MODELS]
    return groqModelPool
  }

  async function postGenerateGemini(activeModel: string, payload: Record<string, unknown>): Promise<Response> {
    return fetch(API_ROOT + '/' + activeModel + ':generateContent', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(timeoutMs)
    })
  }

  async function postGenerateGroq(activeModel: string, body: GroqRequestBody): Promise<Response> {
    return fetch(GROQ_API_ROOT + '/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + groqApiKey },
      body: JSON.stringify({ ...body, model: activeModel }),
      signal: AbortSignal.timeout(timeoutMs)
    })
  }

  async function callGemini(baseBody: Record<string, unknown>): Promise<any> {
    const pool = await resolveGeminiModels()
    let lastErr: unknown
    for (let pass = 0; pass < 2; pass++) {
      for (let offset = 0; offset < pool.length; offset++) {
        const activeModel = pool[(preferredIdx + offset) % pool.length]
        try {
          let res = await postGenerateGemini(activeModel, baseBody)
          
          if (res.status === 400) {
            const fallbackBody = JSON.parse(JSON.stringify(baseBody)) as any
            delete fallbackBody.generationConfig?.thinkingConfig
            res = await postGenerateGemini(activeModel, fallbackBody)
          }
          
          if (res.ok) {
            preferredIdx = (preferredIdx + offset) % pool.length
            return await res.json()
          }
          
          const errText = await res.text().catch(() => '')
          lastErr = new Error(`HTTP ${res.status} (${activeModel}): ${errText.slice(0, 100)}`)
          console.warn(`[brain] ${activeModel} failed (HTTP ${res.status}), instantly trying next...`)
          continue
          
        } catch (e) {
          lastErr = e
        }
      }
      await sleep(1000) 
    }
    throw lastErr ?? new Error('All Gemini models are currently busy or unavailable.')
  }

  async function callGroq(baseBody: {
    contents?: Array<{ role: string; parts?: Array<{ text?: string }> }>;
    systemInstruction?: { parts?: Array<{ text?: string }> };
    tools?: unknown;
    tool_choice?: unknown;
    generationConfig?: { temperature?: number; maxOutputTokens?: number };
  }): Promise<any> {
    if (!groqApiKey) throw new Error('Groq API key not configured')
    
    const pool = await resolveGroqModels()
    if (pool.length === 0) throw new Error('No Groq models available')
    
    let lastErr: unknown
    for (let pass = 0; pass < 2; pass++) {
      for (let offset = 0; offset < pool.length; offset++) {
        const activeModel = pool[(preferredIdx + offset) % pool.length]
        try {
          // Convert Gemini format to Groq format
          const systemText = baseBody.systemInstruction?.parts?.map((p: any) => p.text).join('') ?? ''
          const messages = [
            ...(systemText ? [{ role: 'system' as const, content: systemText }] : []),
            ...(baseBody.contents?.map((c: any) => ({
              role: c.role === 'model' ? 'assistant' : c.role,
              content: c.parts?.map((p: any) => p.text).join('') ?? ''
            })) ?? [])
          ]
          const groqBody = {
            model: activeModel,
            messages,
            tools: baseBody.tools,
            tool_choice: baseBody.tool_choice,
            temperature: baseBody.generationConfig?.temperature ?? 0.4,
            max_tokens: baseBody.generationConfig?.maxOutputTokens ?? 2000,
            response_format: { type: 'json_object' as const }
          }
          
          const res = await postGenerateGroq(activeModel, groqBody)
          
          if (res.ok) {
            preferredIdx = (preferredIdx + offset) % pool.length
            const data = await res.json()
            // Convert Groq response to Gemini-like format
            return {
              candidates: [{
                content: {
                  parts: [{ text: data.choices[0]?.message?.content ?? '{}' }]
                }
              }]
            }
          }
          
          const errText = await res.text().catch(() => '')
          lastErr = new Error(`HTTP ${res.status} (${activeModel}): ${errText.slice(0, 100)}`)
          console.warn(`[brain] Groq ${activeModel} failed (HTTP ${res.status}), instantly trying next...`)
          continue
          
        } catch (e) {
          lastErr = e
        }
      }
      await sleep(1000)
    }
    throw lastErr ?? new Error('All Groq models are currently busy or unavailable.')
  }

  async function callWithFallback(baseBody: Record<string, unknown>): Promise<any> {
    try {
      return await callGemini(baseBody)
    } catch (geminiErr) {
      console.warn('[brain] Gemini failed, trying Groq fallback:', (geminiErr as Error).message)
      if (groqApiKey) {
        try {
          return await callGroq(baseBody)
        } catch (groqErr) {
          console.error('[brain] Groq fallback also failed:', (groqErr as Error).message)
        }
      }
      throw geminiErr
    }
  }

  return {
    async ask(userText, context = {}) {
      const ctx: string[] = []
      if (context.activeWindow) ctx.push('Active window: ' + context.activeWindow)
      if (context.permissionLevel) ctx.push('Permission Level: ' + context.permissionLevel)
      ctx.push('Tools: ' + (toolNames.join(', ') || 'none'))
      
      const snapshot = JSON.parse(JSON.stringify(history)) as Turn[]
      
      const userParts: Part[] = []
      if (userText) userParts.push({ text: userText })
      else if (context.userAudioBase64) userParts.push({ text: 'Please respond to this voice message.' })

      if (context.userAudioBase64) {
        userParts.push({ inlineData: { mimeType: 'audio/webm', data: context.userAudioBase64 } })
      }

      history.push({ role: 'user', parts: userParts })
      const requestContents = JSON.parse(JSON.stringify(history)) as Turn[]
      
      if (context.imageBase64) {
        requestContents[requestContents.length - 1].parts.push({
          inlineData: { mimeType: 'image/jpeg', data: context.imageBase64 }
        })
      }

      try {
        const data = await callWithFallback({
          systemInstruction: { parts: [{ text: persona + '\n\n' + ctx.join('\n') }] },
          contents: requestContents,
          generationConfig: { temperature: 0.4, maxOutputTokens: 2000, responseSchema: schema, responseMimeType: 'application/json' }
        })
        const text = (data?.candidates?.[0]?.content?.parts ?? []).filter((p: any) => !p.thought && typeof p.text === 'string').map((p: any) => p.text).join('')
        const reply = sanitize(JSON.parse(text), toolNames) ?? { speech: 'Hmm, could you repeat that?', emotion: 'neutral', gesture: 'think', actions: [], done: true }
        pushTurn('model', JSON.stringify(reply))
        return reply
      } catch (err) {
        history = snapshot
        return { speech: "Google's servers are a bit busy right now!", emotion: 'sad', gesture: 'shrug', actions: [], done: true }
      }
    },
    noteToolResult(summary) { pushTurn('user', '[tool result] ' + summary) },
    reset() { history = [] }
  }
}