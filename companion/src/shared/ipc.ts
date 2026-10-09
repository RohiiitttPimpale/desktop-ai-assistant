import type { BrainReply } from '../main/brain'

export const IPC = {
  setInteractive: 'overlay:set-interactive',
  setFocusable: 'overlay:set-focusable',
  dragStart: 'overlay:drag-start',
  dragEnd: 'overlay:drag-end',
  contextMenu: 'overlay:context-menu',
  getModel: 'model:get',
  modelChanged: 'model:changed',
  askBrain: 'brain:ask',
  cursorMove: 'overlay:cursor-move',
  focusChat: 'overlay:focus-chat',
  agentStep: 'brain:agent-step',
  voiceStartRecording: 'voice:start-recording',
  voiceRecordingComplete: 'voice:recording-complete',
  voiceResponse: 'voice:response',
  voiceWake: 'voice:wake',
  voiceTranscript: 'voice:transcript',
  voiceError: 'voice:error',
  chatPanelGet: 'chatPanel:get',
  chatPanelSet: 'chatPanel:set',
  chatPanelChanged: 'chatPanel:changed',
  ttsSetAutospeak: 'tts:set-autospeak',
} as const

/** Total window width (px) the chat panel expands the overlay window by on its left side. */
export const CHAT_PANEL_WIDTH = 360

export interface ModelPayload {
  name: string
  data: Uint8Array
}

export interface AgentStepPayload {
  step: number
  speech: string
  emotion: string
  gesture: string
  toolResults: string[]
}

export type BrainResponsePayload = BrainReply & {
  toolResults?: string[]
  audio?: Uint8Array | null
}

export interface CompanionApi {
  setInteractive(interactive: boolean): void
  setFocusable(focusable: boolean): void
  dragStart(): void
  dragEnd(): void
  showContextMenu(): void
  getModel(): Promise<ModelPayload | null>
  onModelChanged(callback: () => void): () => void
  onCursorMove(callback: (nx: number, ny: number) => void): () => void
  onFocusChat(callback: () => void): () => void
  onAgentStep(callback: (payload: AgentStepPayload) => void): () => void
  askBrain(payload: { text: string; audioBase64?: string }): Promise<BrainResponsePayload>
  onVoiceWake(callback: () => void): () => void
  onVoiceTranscript(callback: (text: string) => void): () => void
  onVoiceResponse(callback: (speech: string, audio: Uint8Array | null) => void): () => void
  onVoiceError(callback: (error: string) => void): () => void
  onVoiceStartRecording(callback: () => void): () => void
  startVoiceRecording(): void
  sendVoiceRecordingComplete(audioBase64: string): void
  getChatPanel(): Promise<boolean>
  setChatPanel(open: boolean): void
  onChatPanelChanged(callback: (open: boolean) => void): () => void
  setAutospeak(enabled: boolean): void
}