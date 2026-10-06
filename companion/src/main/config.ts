import { app } from 'electron'
import fs from 'node:fs'
import path from 'node:path'

export type SizePreset = 'small' | 'medium' | 'large'

export const SIZES: Record<SizePreset, { width: number; height: number }> = {
  small: { width: 280, height: 420 },
  medium: { width: 360, height: 540 },
  large: { width: 480, height: 720 }
}

export interface Config {
  modelPath: string | null
  size: SizePreset
  position: { x: number; y: number } | null
}

const defaults: Config = { modelPath: null, size: 'medium', position: null }

let cache: Config | null = null

const configFile = (): string => path.join(app.getPath('userData'), 'config.json')

export function getConfig(): Config {
  if (cache) return cache
  try {
    const raw = JSON.parse(fs.readFileSync(configFile(), 'utf-8')) as Partial<Config>
    cache = { ...defaults, ...raw }
  } catch {
    cache = { ...defaults }
  }
  return cache
}

export function updateConfig(patch: Partial<Config>): Config {
  cache = { ...getConfig(), ...patch }
  try {
    fs.mkdirSync(path.dirname(configFile()), { recursive: true })
    fs.writeFileSync(configFile(), JSON.stringify(cache, null, 2))
  } catch (err) {
    console.error('Could not save config:', err)
  }
  return cache
}
