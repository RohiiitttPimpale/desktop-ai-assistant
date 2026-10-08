import { spawn, ChildProcessWithoutNullStreams } from 'node:child_process';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { dirname, resolve } from 'node:path';
import { getLogger, logError } from '../logger';
import { getGlobalStopHotkey } from '../policy';
import { getOverlay, setFocusable } from '../overlay';
import { synthesizeSpeech } from '../tts';
import { toolRegistry } from '../registry';
import { confirmSensitive } from '../confirm';
import { IPC } from '../../shared/ipc';

const execFileAsync = promisify(execFile);

// Resolve script paths correctly for both dev (esbuild test) and production (Electron)
function getScriptsDir(): string {
  try {
    // Production: use import.meta.url (ESM)
    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
    const metaUrl = (import.meta as unknown as { url?: string }).url;
    if (metaUrl) {
      // Handle file:// URL properly: file:///C:/path/on/windows or file:///path/on/linux
      let path = metaUrl;
      if (path.startsWith('file://')) {
        path = path.slice('file://'.length);
      }
      // On Windows, file:///C:/... becomes /C:/... after slice, need to remove leading slash
      if (path.startsWith('/') && path.length >= 3 && path[2] === ':') {
        path = path.slice(1);
      }
      return resolve(dirname(path), 'scripts');
    }
  } catch {
    // ignore
  }
  // Dev/test fallback: use __dirname from CommonJS or process.cwd
  try {
    // In esbuild bundle, we can use __dirname if available
    // @ts-ignore - __dirname may not exist in ESM
    if (typeof __dirname === 'string') {
      return resolve(__dirname, 'scripts');
    }
  } catch {
    // ignore
  }
  // Final fallback: relative to process.cwd()
  return resolve(process.cwd(), 'src/main/scripts');
}

const SCRIPTS_DIR = getScriptsDir();

export const _voiceScriptWake = resolve(SCRIPTS_DIR, 'wake.py');
export const _voiceScriptStt = resolve(SCRIPTS_DIR, 'stt.py');
export const _voiceScriptPiper = resolve(SCRIPTS_DIR, 'piper-tts.py');

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

      const result = await execFileAsync('python', [scriptPath, dummyAudio], {
        timeout: 300000, // 5 minutes for initial model download
        windowsHide: true,
        env: {
          ...process.env,
          WHISPER_MODEL: 'small',
          WHISPER_DEVICE: 'cpu',
          WHISPER_COMPUTE_TYPE: 'int8',
          HF_HUB_DISABLE_SYMLINKS_WARNING: '1', // Suppress symlink warnings on Windows
        },
      });
      const stdout = result.stdout;
      if (result.stderr) {
        log.warn({ stderr: result.stderr }, 'STT model load stderr');
      }

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
  // Using "jarvis" as built-in Porcupine keyword (placeholder for custom "Hey Miko")
  // To use custom "Hey Miko", train keyword at https://console.picovoice.ai/ and set PORCUPINE_KEYWORD_FILE
  const env = {
    ...process.env,
    PORCUPINE_KEYWORD: 'jarvis',
  };

  wakeProcess = spawn('python', [_voiceScriptWake], {
    env,
    windowsHide: true,
  });

  wakeProcess.stdout?.on('data', (data) => {
    const output = data.toString().trim();
    if (output.includes('WAKE_WORD_DETECTED')) {
      getLogger().info({ event: 'wake_word' }, 'Wake word detected');
      void handleWakeWord();
    } else if (output.includes('MISSING_ACCESS_KEY')) {
      getLogger().info({ event: 'wake_no_key' }, 'Porcupine wake word requires key; Push-to-Talk (Ctrl+Alt+V) active');
    } else if (output.startsWith('[wake]')) {
      getLogger().debug({ output }, 'Wake process output');
    }
  });

  wakeProcess.stderr?.on('data', (data) => {
    const error = data.toString().trim();
    if (error) {
      getLogger().warn({ error }, 'Wake process stderr');
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

    const execResult = await execFileAsync('python', [scriptPath, audioFile], {
      timeout: 120000, // 2 minutes for transcription (model already loaded)
      windowsHide: true,
      env: {
        ...process.env,
        WHISPER_MODEL: 'small',
        WHISPER_DEVICE: 'cpu',
        WHISPER_COMPUTE_TYPE: 'int8',
        HF_HUB_DISABLE_SYMLINKS_WARNING: '1',
      },
    });
    const stdout = execResult.stdout;
    if (execResult.stderr) {
      log.warn({ stderr: execResult.stderr }, 'STT transcribe stderr');
    }

    const duration = Date.now() - startTime;
    const parsed = JSON.parse(stdout.trim());

    if (parsed.error) {
      log.error({ error: parsed.error, event: 'stt_transcribe_error' }, 'STT transcription failed');
      cb.onError('Could not understand audio');
      return;
    }

    log.info({ text: parsed.text, language: parsed.language, durationMs: duration, event: 'stt_transcribe_done' }, `STT: "${parsed.text}"`);

    if (!parsed || !parsed.text) {
      cb.onError('Could not understand audio');
      return;
    }

    log.info({ text: parsed.text, event: 'transcript' }, `Transcript: "${parsed.text}"`);
    cb.onTranscript(parsed.text);
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
    const audio = await synthesizeSpeech(text);
    voiceCallbacks.onResponse(text, audio);
  } catch (err) {
    log.error({ error: (err as Error).message, event: 'tts_error' }, 'TTS failed');
    voiceCallbacks.onError('Failed to synthesize speech');
  }
}

export async function handleVoiceConfirmation(toolName: string, args: Record<string, unknown>): Promise<boolean> {
  const cb = voiceCallbacks;
  if (!cb) {
    // Fallback to dialog if voice callbacks not available
    return await confirmSensitive(toolName, args);
  }

  const log = getLogger();
  log.info({ tool: toolName, event: 'voice_confirmation' }, `Requesting voice confirmation for ${toolName}`);

  const argsStr = JSON.stringify(args, null, 2);
  const prompt = `Miko wants to run ${toolName}. Arguments: ${argsStr}. Say yes to allow or no to cancel.`;

  // Speak the confirmation prompt
  await handleVoiceResponse(prompt);

  // Wait for user response (yes/no) via voice
  return new Promise((resolve) => {
    const originalOnTranscript = cb.onTranscript;
    const timeout = setTimeout(() => {
      log.warn({ tool: toolName, event: 'voice_confirmation_timeout' }, 'Voice confirmation timed out');
      cb.onTranscript = originalOnTranscript;
      cb.onError('Confirmation timed out');
      resolve(false);
    }, 15000);

    // Temporarily override onTranscript to capture yes/no
    cb.onTranscript = (text: string) => {
      const lower = text.toLowerCase().trim();
      if (lower.includes('yes') || lower.includes('yeah') || lower.includes('yep') || lower.includes('sure') || lower.includes('ok') || lower.includes('okay') || lower.includes('allow') || lower.includes('confirm')) {
        clearTimeout(timeout);
        cb.onTranscript = originalOnTranscript;
        log.info({ tool: toolName, event: 'voice_confirmed' }, 'Voice confirmation: ALLOWED');
        resolve(true);
      } else if (lower.includes('no') || lower.includes('nope') || lower.includes('cancel') || lower.includes('deny') || lower.includes('stop') || lower.includes('dont') || lower.includes("don't")) {
        clearTimeout(timeout);
        cb.onTranscript = originalOnTranscript;
        log.info({ tool: toolName, event: 'voice_denied' }, 'Voice confirmation: DENIED');
        resolve(false);
      } else {
        // Not a yes/no, forward to original handler
        originalOnTranscript(text);
      }
    };
  });
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