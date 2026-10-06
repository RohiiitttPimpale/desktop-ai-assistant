import { spawn, ChildProcessWithoutNullStreams } from 'node:child_process';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { getLogger, logError } from '../logger';
import { getGlobalStopHotkey } from '../policy';
import { getOverlay, setFocusable } from '../overlay';
import { synthesizeSpeech } from '../tts';
import { toolRegistry } from '../registry';
import { confirmSensitive } from '../confirm';
import { IPC } from '../../shared/ipc';

const execFileAsync = promisify(execFile);

// Script paths - hardcoded relative paths (Python scripts are copied to out/main/scripts/ by build)
// Export to prevent tree-shaking
export const _voiceScriptWake = 'scripts/wake.py';
export const _voiceScriptStt = 'scripts/stt.py';
export const _voiceScriptPiper = 'scripts/piper-tts.py';

interface WakeWordCallbacks {
  onWake: () => void;
  onError: (err: Error) => void;
}

interface VoiceCallbacks {
  onWake: () => void;
  onTranscript: (text: string) => void;
  onResponse: (speech: string, audio: Uint8Array | null) => void;
  onError: (error: string) => void;
}

let wakeProcess: ChildProcessWithoutNullStreams | null = null;
let isListening = false;
let wakeCallbacks: WakeWordCallbacks | null = null;

let voiceCallbacks: VoiceCallbacks | null = null;
let isVoiceMode = false;
let isProcessing = false;
let sttIdleTimer: ReturnType<typeof setTimeout> | null = null;
const STT_IDLE_TIMEOUT = 60000;

const PUSH_TO_TALK_HOTKEY = 'Control+Alt+V';

// Voice callbacks are the app-level wiring (how transcripts/replies/errors reach the UI).
// They are installed once at startup so the manual mic button always works,
// independent of whether voice mode (wake word) is enabled.

export function setVoiceCallbacks(callbacks: VoiceCallbacks): void {
  voiceCallbacks = callbacks;
}

// Default wiring: forward every voice event to the overlay renderer over IPC.
export function defaultVoiceCallbacks(): VoiceCallbacks {
  const send = (channel: string, ...args: unknown[]): void => {
    const win = getOverlay();
    if (win && !win.isDestroyed()) win.webContents.send(channel, ...args);
  };
  return {
    onWake: () => send(IPC.voiceWake),
    onTranscript: (text) => send(IPC.voiceTranscript, text),
    onResponse: (speech, audio) => send(IPC.voiceResponse, speech, audio),
    onError: (error) => send(IPC.voiceError, error),
  };
}

// Wake word detection
export function stopWakeWord(): void {
  if (wakeProcess) {
    wakeProcess.kill('SIGTERM');
    wakeProcess = null;
    isListening = false;
  }
}

export function isWakeWordActive(): boolean {
  return isListening;
}

// STT
let sttModelLoaded = false;
let sttLoadPromise: Promise<void> | null = null;

async function ensureSttModel(): Promise<void> {
  if (sttModelLoaded) return;
  if (sttLoadPromise) return sttLoadPromise;

  const attempt = (async () => {
    const log = getLogger();
    log.info({ event: 'stt_load_start' }, 'Loading faster-whisper model...');

    try {
      const scriptPath = _voiceScriptStt;
      const dummyAudio = require('node:path').join(require('node:os').tmpdir(), 'miko-dummy.wav');

      const wavHeader = Buffer.alloc(44);
      wavHeader.write('RIFF', 0);
      wavHeader.writeUInt32LE(36, 4);
      wavHeader.write('WAVE', 8);
      wavHeader.write('fmt ', 12);
      wavHeader.writeUInt32LE(16, 16);
      wavHeader.writeUInt16LE(1, 20);
      wavHeader.writeUInt16LE(1, 22);
      wavHeader.writeUInt32LE(16000, 24);
      wavHeader.writeUInt32LE(32000, 28);
      wavHeader.writeUInt16LE(2, 32);
      wavHeader.writeUInt16LE(16, 34);
      wavHeader.write('data', 36);
      wavHeader.writeUInt32LE(0, 40);
      require('node:fs').writeFileSync(dummyAudio, wavHeader);

      const { stdout } = await execFileAsync('python', [scriptPath, dummyAudio], {
        timeout: 60000,
        windowsHide: true,
        env: {
          ...process.env,
          WHISPER_MODEL: 'small',
          WHISPER_DEVICE: 'cpu',
          WHISPER_COMPUTE_TYPE: 'int8',
        },
      });

      require('node:fs').unlinkSync(dummyAudio);
      sttModelLoaded = true;
      log.info({ event: 'stt_load_done' }, 'faster-whisper model loaded');
    } catch (err) {
      log.error({ error: (err as Error).message }, 'Failed to load STT model');
      throw err;
    }
  })();

  sttLoadPromise = attempt;
  try {
    await attempt;
  } catch (err) {
    // Do not cache a failed load - the next recording should retry
    sttLoadPromise = null;
    throw err;
  }
}

function unloadSttModel(): void {
  sttModelLoaded = false;
  sttLoadPromise = null;
  getLogger().info({ event: 'stt_unload' }, 'STT model unloaded');
}

// Piper TTS
let piperTtsAvailable = false;

async function checkPiperAvailability(): Promise<boolean> {
  if (piperTtsAvailable) return true;
  
  try {
    await execFileAsync('python', ['-c', 'import piper; print("OK")'], {
      timeout: 5000,
      windowsHide: true,
    });
    piperTtsAvailable = true;
    return true;
  } catch {
    piperTtsAvailable = false;
    return false;
  }
}

// Voice mode integration
export function startVoiceMode(callbacks: VoiceCallbacks): void {
  if (isVoiceMode) return;

  setVoiceCallbacks(callbacks);
  isVoiceMode = true;
  isProcessing = false;
  
  const log = getLogger();
  log.info({ event: 'voice_mode_start' }, 'Starting voice mode');
  
  // Start wake word detection
  const env = {
    ...process.env,
    PORCUPINE_KEYWORD: 'hey google',
  };

  wakeProcess = spawn('python', [_voiceScriptWake], {
    env,
    windowsHide: true,
  });

  wakeProcess.stdout?.on('data', (data) => {
    const output = data.toString().trim();
    if (output === '[wake] WAKE_WORD_DETECTED') {
      getLogger().info({ event: 'wake_word' }, 'Wake word detected');
      void handleWakeWord();
    } else if (output.startsWith('[wake]')) {
      getLogger().debug({ output }, 'Wake process output');
    }
  });

  wakeProcess.stderr?.on('data', (data) => {
    const error = data.toString().trim();
    if (error) {
      getLogger().error({ error }, 'Wake process stderr');
    }
  });

  wakeProcess.on('error', (err) => {
    getLogger().error({ error: err.message }, 'Wake process error');
    isListening = false;
    wakeCallbacks?.onError(err);
  });

  wakeProcess.on('exit', (code) => {
    getLogger().info({ code, event: 'wake_exit' }, 'Wake process exited');
    isListening = false;
    wakeProcess = null;
    if (code !== 0 && code !== null) {
      wakeCallbacks?.onError(new Error(`Wake process exited with code ${code}`));
    }
  });

  isListening = true;
  
  try {
    const { globalShortcut } = require('electron');
    globalShortcut.register(PUSH_TO_TALK_HOTKEY, () => {
      if (!isProcessing) {
        handlePushToTalk();
      }
    });
  } catch (err) {
    log.error({ error: (err as Error).message }, 'Failed to register push-to-talk hotkey');
  }
}

export function stopVoiceMode(): void {
  if (!isVoiceMode) return;

  isVoiceMode = false;
  isProcessing = false;
  
  stopWakeWord();
  
  try {
    const { globalShortcut } = require('electron');
    globalShortcut.unregister(PUSH_TO_TALK_HOTKEY);
  } catch {
    // ignore
  }
  
  if (sttIdleTimer) {
    clearTimeout(sttIdleTimer);
    sttIdleTimer = null;
  }
  
  unloadSttModel();
  
  getLogger().info({ event: 'voice_mode_stop' }, 'Stopped voice mode');
}

export function isVoiceModeActive(): boolean {
  return isVoiceMode;
}

async function handleWakeWord(): Promise<void> {
  if (!voiceCallbacks || isProcessing) return;

  const log = getLogger();
  log.info({ event: 'wake_handled' }, 'Wake word triggered, starting recording');

  try {
    voiceCallbacks.onWake();

    const overlay = getOverlay();
    if (!overlay || overlay.isDestroyed()) {
      throw new Error('Overlay window not available');
    }

    overlay.webContents.send(IPC.voiceStartRecording);
  } catch (err) {
    log.error({ error: (err as Error).message, event: 'wake_handle_error' }, 'Error handling wake word');
    voiceCallbacks?.onError(`Error: ${(err as Error).message}`);
  }
}

async function handlePushToTalk(): Promise<void> {
  if (!voiceCallbacks || isProcessing) return;

  const log = getLogger();
  log.info({ event: 'push_to_talk' }, 'Push-to-talk activated');

  try {
    const overlay = getOverlay();
    if (!overlay || overlay.isDestroyed()) {
      throw new Error('Overlay window not available');
    }

    overlay.webContents.send(IPC.voiceStartRecording);
  } catch (err) {
    log.error({ error: (err as Error).message, event: 'push_to_talk_error' }, 'Error in push-to-talk');
    voiceCallbacks?.onError(`Error: ${(err as Error).message}`);
  }
}

export async function handleRecordingComplete(audioBase64: string): Promise<void> {
  const cb = voiceCallbacks;
  if (!cb) return;

  if (isProcessing) {
    cb.onError('Already processing a voice request');
    return;
  }

  isProcessing = true;
  const log = getLogger();
  let audioFile = '';

  try {
    const fs = require('node:fs');
    const path = require('node:path');
    const os = require('node:os');
    const audioBuffer = Buffer.from(audioBase64, 'base64');
    audioFile = path.join(os.tmpdir(), `miko-stt-${Date.now()}.webm`);
    fs.writeFileSync(audioFile, audioBuffer);

    log.info({ event: 'recording_complete' }, 'Recording complete, transcribing...');

    await ensureSttModel();
    const scriptPath = _voiceScriptStt;

    log.info({ file: audioFile, event: 'stt_transcribe_start' }, 'Transcribing audio...');
    const startTime = Date.now();

    const { stdout } = await execFileAsync('python', [scriptPath, audioFile], {
      timeout: 60000,
      windowsHide: true,
      env: {
        ...process.env,
        WHISPER_MODEL: 'small',
        WHISPER_DEVICE: 'cpu',
        WHISPER_COMPUTE_TYPE: 'int8',
      },
    });

    const duration = Date.now() - startTime;
    const result = JSON.parse(stdout.trim());

    if (result.error) {
      log.error({ error: result.error, event: 'stt_transcribe_error' }, 'STT transcription failed');
      cb.onError('Could not understand audio');
      return;
    }

    log.info({ text: result.text, language: result.language, durationMs: duration, event: 'stt_transcribe_done' }, `STT: "${result.text}"`);

    if (!result || !result.text) {
      cb.onError('Could not understand audio');
      return;
    }

    log.info({ text: result.text, event: 'transcript' }, `Transcript: "${result.text}"`);
    cb.onTranscript(result.text);
  } catch (err) {
    log.error({ error: (err as Error).message, event: 'transcribe_error' }, 'Transcription failed');
    cb.onError(`Transcription failed: ${(err as Error).message}`);
  } finally {
    if (audioFile) {
      try {
        require('node:fs').unlinkSync(audioFile);
      } catch {
        /* file already gone */
      }
    }
    isProcessing = false;
    resetSttIdleTimer();
  }
}

export async function handleVoiceResponse(text: string): Promise<void> {
  if (!voiceCallbacks) return;
  
  const log = getLogger();
  log.info({ text: text.substring(0, 50), event: 'voice_response' }, `Speaking: "${text}"`);
  
  try {
    const fs = require('node:fs');
    const path = require('node:path');
    const os = require('node:os');
    
    const outputFile = path.join(os.tmpdir(), `miko-tts-${Date.now()}.wav`);
    
    // Piper TTS - use module-level constant
    const modelPath = process.env['PIPER_MODEL'] || path.join(os.homedir(), '.local', 'share', 'piper', 'en_US-lessac-medium.onnx');
    
    let piperSuccess = false;
    let audio: Uint8Array | null = null;
    
    if (fs.existsSync(modelPath)) {
      try {
        const scriptPath = _voiceScriptPiper;
        const { stdout } = await execFileAsync('python', [scriptPath, text, outputFile], {
          timeout: 30000,
          windowsHide: true,
          env: {
            ...process.env,
            PIPER_MODEL: modelPath,
          },
        });
        
        const result = JSON.parse(stdout.trim());
        if (result.success) {
          log.info({ text: text.substring(0, 50), outputFile, event: 'piper_tts_done' }, 'Piper TTS synthesized');
          piperSuccess = true;
        }
      } catch (err) {
        log.error({ error: (err as Error).message, event: 'piper_tts_error' }, 'Piper TTS failed');
      }
    } else {
      log.warn({ modelPath, event: 'piper_model_missing' }, 'Piper model not found, falling back to edge-tts');
    }
    
    if (piperSuccess && fs.existsSync(outputFile)) {
      const audioBuffer = fs.readFileSync(outputFile);
      audio = new Uint8Array(audioBuffer);
      fs.unlinkSync(outputFile);
    } else {
      audio = await synthesizeSpeech(text);
    }
    
    voiceCallbacks?.onResponse(text, audio);
  } catch (err) {
    log.error({ error: (err as Error).message, event: 'tts_error' }, 'TTS failed');
    try {
      const audio = await synthesizeSpeech(text);
      voiceCallbacks?.onResponse(text, audio);
    } catch {
      voiceCallbacks?.onError('Failed to synthesize speech');
    }
  }
}

export async function handleVoiceConfirmation(toolName: string, args: Record<string, unknown>): Promise<boolean> {
  const log = getLogger();
  log.info({ tool: toolName, event: 'voice_confirmation' }, `Requesting voice confirmation for ${toolName}`);
  
  return await confirmSensitive(toolName, args);
}

function resetSttIdleTimer(): void {
  if (sttIdleTimer) {
    clearTimeout(sttIdleTimer);
  }
  sttIdleTimer = setTimeout(() => {
    getLogger().info({ event: 'stt_idle_unload' }, 'STT idle timeout, unloading model');
    unloadSttModel();
  }, STT_IDLE_TIMEOUT);
}

export function setupVoiceIpc(): void {
  // IPC handlers are registered in index.ts to ensure functions are included in bundle
}