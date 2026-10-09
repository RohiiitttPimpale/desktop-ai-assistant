import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

/** Title of the overlay window (from index.html <title>) — used to detect self-targeting. */
export const OVERLAY_TITLE = 'AI Companion'

/**
 * Raw foreground window title ('' on failure). Unlike the brain-context
 * variant in tools.ts this does NOT filter Miko's own window, so tool
 * handlers can detect when the overlay itself has focus.
 */
export async function getForegroundWindowTitle(): Promise<string> {
  try {
    const pyWin = [
      'import ctypes',
      'u = ctypes.windll.user32',
      'h = u.GetForegroundWindow()',
      'b = ctypes.create_unicode_buffer(256)',
      'u.GetWindowTextW(h, b, 256)',
      'print(b.value)',
    ].join('\n')
    const { stdout } = await execFileAsync('python', ['-c', pyWin], {
      timeout: 1500,
      windowsHide: true,
    })
    return stdout.trim()
  } catch {
    /* ignore active window lookup failure */
  }
  return ''
}
