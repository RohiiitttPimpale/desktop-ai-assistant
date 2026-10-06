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
