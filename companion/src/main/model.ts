import { app } from 'electron'
import fs from 'node:fs'
import path from 'node:path'
import type { ModelPayload } from '../shared/ipc'
import { getConfig } from './config'

/** Saved model first, then assets/models/avatar.vrm in the project folder. */
function resolveModelPath(): string | null {
  const saved = getConfig().modelPath
  if (saved && fs.existsSync(saved)) return saved
  const fallback = path.join(app.getAppPath(), 'assets', 'models', 'avatar.vrm')
  return fs.existsSync(fallback) ? fallback : null
}

export async function readModel(): Promise<ModelPayload | null> {
  const file = resolveModelPath()
  if (!file) return null
  try {
    const buf = await fs.promises.readFile(file)
    // Copy into a fresh Uint8Array so the renderer gets an exact-size ArrayBuffer.
    return { name: path.basename(file), data: new Uint8Array(buf) }
  } catch (err) {
    console.error('Could not read model:', err)
    return null
  }
}
