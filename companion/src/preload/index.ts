import { contextBridge, ipcRenderer } from 'electron'
import { IPC, type AgentStepPayload, type CompanionApi } from '../shared/ipc'

const api: CompanionApi = {
  onVoiceStartRecording: (callback: () => void): () => void => {
    const listener = (): void => callback()
    ipcRenderer.on(IPC.voiceStartRecording, listener)
    return () => ipcRenderer.removeListener(IPC.voiceStartRecording, listener)
  },
  setInteractive: (interactive) => ipcRenderer.send(IPC.setInteractive, interactive),
  setFocusable: (focusable) => ipcRenderer.send(IPC.setFocusable, focusable),
  dragStart: () => ipcRenderer.send(IPC.dragStart),
  dragEnd: () => ipcRenderer.send(IPC.dragEnd),
  showContextMenu: () => ipcRenderer.send(IPC.contextMenu),
  getModel: () => ipcRenderer.invoke(IPC.getModel),
  onModelChanged: (callback) => {
    const listener = (): void => callback()
    ipcRenderer.on(IPC.modelChanged, listener)
    return () => ipcRenderer.removeListener(IPC.modelChanged, listener)
  },
  onCursorMove: (callback) => {
    const listener = (_e: unknown, nx: number, ny: number): void => callback(nx, ny)
    ipcRenderer.on(IPC.cursorMove, listener)
    return () => ipcRenderer.removeListener(IPC.cursorMove, listener)
  },
  onFocusChat: (callback) => {
    const listener = (): void => callback()
    ipcRenderer.on(IPC.focusChat, listener)
    return () => ipcRenderer.removeListener(IPC.focusChat, listener)
  },
  onAgentStep: (callback) => {
    const listener = (_e: unknown, payload: AgentStepPayload): void => callback(payload)
    ipcRenderer.on(IPC.agentStep, listener)
    return () => ipcRenderer.removeListener(IPC.agentStep, listener)
  },
  setPermission: (level) => ipcRenderer.send(IPC.setPermission, level),
  onPermissionChanged: (callback) => {
    const listener = (_e: unknown, level: string): void => callback(level as any)
    ipcRenderer.on(IPC.permissionChanged, listener)
    return () => ipcRenderer.removeListener(IPC.permissionChanged, listener)
  },
  askBrain: (payload) => ipcRenderer.invoke(IPC.askBrain, payload),
  onVoiceWake: (callback) => {
    const listener = (): void => callback()
    ipcRenderer.on(IPC.voiceWake, listener)
    return () => ipcRenderer.removeListener(IPC.voiceWake, listener)
  },
  onVoiceTranscript: (callback) => {
    const listener = (_e: unknown, text: string): void => callback(text)
    ipcRenderer.on(IPC.voiceTranscript, listener)
    return () => ipcRenderer.removeListener(IPC.voiceTranscript, listener)
  },
  onVoiceResponse: (callback) => {
    const listener = (_e: unknown, speech: string, audio: Uint8Array | null): void => callback(speech, audio)
    ipcRenderer.on(IPC.voiceResponse, listener)
    return () => ipcRenderer.removeListener(IPC.voiceResponse, listener)
  },
  onVoiceError: (callback) => {
    const listener = (_e: unknown, error: string): void => callback(error)
    ipcRenderer.on(IPC.voiceError, listener)
    return () => ipcRenderer.removeListener(IPC.voiceError, listener)
  },
  startVoiceRecording: () => ipcRenderer.send(IPC.voiceStartRecording),
  sendVoiceRecordingComplete: (audioBase64: string) => ipcRenderer.send(IPC.voiceRecordingComplete, audioBase64),
  getChatPanel: (): Promise<boolean> => ipcRenderer.invoke(IPC.chatPanelGet) as Promise<boolean>,
  setChatPanel: (open: boolean) => ipcRenderer.send(IPC.chatPanelSet, open),
  onChatPanelChanged: (callback: (open: boolean) => void): (() => void) => {
    const listener = (_e: unknown, open: boolean): void => callback(open)
    ipcRenderer.on(IPC.chatPanelChanged, listener)
    return () => ipcRenderer.removeListener(IPC.chatPanelChanged, listener)
  },
}

contextBridge.exposeInMainWorld('companion', api)