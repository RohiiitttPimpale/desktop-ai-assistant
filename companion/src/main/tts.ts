import { execFile } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)
const VOICE = 'en-US-AnaNeural'

export async function synthesizeSpeech(text: string): Promise<Uint8Array | null> {
  const clean = text.replace(/[*_~`#]/g, '').trim()
  if (!clean) return null

  // 1. Check if Piper model is configured and available
  const piperModel = process.env['PIPER_MODEL'] || path.join(os.homedir(), '.local', 'share', 'piper', 'en_US-lessac-medium.onnx')
  if (fs.existsSync(piperModel)) {
    const tmpWav = path.join(os.tmpdir(), `miko-piper-${crypto.randomUUID()}.wav`)
    try {
      const piperScript = path.join(__dirname, 'scripts', 'piper-tts.py')
      const scriptToRun = fs.existsSync(piperScript) ? piperScript : path.join(process.cwd(), 'src', 'main', 'scripts', 'piper-tts.py')
      await execFileAsync('python', [scriptToRun, clean, tmpWav], {
        timeout: 15000,
        windowsHide: true,
        env: { ...process.env, PIPER_MODEL: piperModel }
      })
      if (fs.existsSync(tmpWav)) {
        const buf = await fs.promises.readFile(tmpWav)
        return new Uint8Array(buf)
      }
    } catch (err) {
      console.warn('[tts] Piper TTS failed, falling back to edge-tts:', (err as Error).message)
    } finally {
      fs.promises.unlink(tmpWav).catch(() => {})
    }
  }

  // 2. Default/Fallback: high quality Microsoft Edge Neural TTS
  const tmpFile = path.join(os.tmpdir(), `miko-tts-${crypto.randomUUID()}.mp3`)
  try {
    await execFileAsync(
      'python',
      [
        '-m',
        'edge_tts',
        '--voice',
        VOICE,
        '--rate=+8%',
        '--pitch=+10Hz',
        '--text',
        clean,
        '--write-media',
        tmpFile
      ],
      { timeout: 10000, windowsHide: true }
    )
    const buf = await fs.promises.readFile(tmpFile)
    return new Uint8Array(buf)
  } catch (err) {
    console.warn('[tts] edge-tts failed, falling back to browser TTS:', (err as Error).message)
    return null
  } finally {
    fs.promises.unlink(tmpFile).catch(() => {})
  }
}
