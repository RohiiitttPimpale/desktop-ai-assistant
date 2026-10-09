import { app } from 'electron';
import fs from 'node:fs';
import path from 'node:path';

/**
 * Runtime settings (blueprint §11 / phases.md Phase 1, previously deferred).
 * Lives next to policy.json in %APPDATA%/ai-companion/settings.json.
 *
 * - MIKO_VISIBLE: automation windows stay visible (project rule: true for now;
 *   the "Final Step" checklist in docs/phases.md flips this at project end).
 * - DRY_RUN: tools do everything except actually sending messages/files.
 *   Phase 4's wa_send_file and Phase 6's end-to-end test read this.
 */
export interface Settings {
  MIKO_VISIBLE: boolean;
  DRY_RUN: boolean;
}

const DEFAULT_SETTINGS: Settings = {
  MIKO_VISIBLE: true,
  DRY_RUN: false,
};

const SETTINGS_FILE = path.join(app.getPath('userData'), 'settings.json');

let settingsCache: Settings | null = null;

export function getSettings(): Settings {
  if (settingsCache) return settingsCache;

  try {
    if (fs.existsSync(SETTINGS_FILE)) {
      const raw = JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf-8')) as Partial<Settings>;
      settingsCache = {
        MIKO_VISIBLE: typeof raw.MIKO_VISIBLE === 'boolean' ? raw.MIKO_VISIBLE : DEFAULT_SETTINGS.MIKO_VISIBLE,
        DRY_RUN: typeof raw.DRY_RUN === 'boolean' ? raw.DRY_RUN : DEFAULT_SETTINGS.DRY_RUN,
      };
    } else {
      settingsCache = { ...DEFAULT_SETTINGS };
    }
  } catch (err) {
    console.error('[settings] Failed to load settings, using defaults:', err);
    settingsCache = { ...DEFAULT_SETTINGS };
  }
  return settingsCache;
}

export function updateSettings(patch: Partial<Settings>): Settings {
  settingsCache = { ...getSettings(), ...patch };
  try {
    fs.mkdirSync(path.dirname(SETTINGS_FILE), { recursive: true });
    fs.writeFileSync(SETTINGS_FILE, JSON.stringify(settingsCache, null, 2));
  } catch (err) {
    console.error('[settings] Failed to save settings:', err);
  }
  return settingsCache;
}

export function isDryRun(): boolean {
  return getSettings().DRY_RUN;
}

export function isVisibleMode(): boolean {
  return getSettings().MIKO_VISIBLE;
}
