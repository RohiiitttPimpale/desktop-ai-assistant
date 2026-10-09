import { toolRegistry, ToolContext, TabSession, TrayMode } from './registry';
import { logError } from './logger';
import { isVoiceModeActive } from './voice';
import './packs/core';

let maxAgentSteps = 15;
export function setMaxAgentSteps(steps: number): void { maxAgentSteps = steps }
export function getMaxAgentSteps(): number { return maxAgentSteps }

export type PermissionLevel = 'read-only' | 'only-browser' | 'normal' | 'full';
let currentPermission: PermissionLevel = 'normal';

export function setPermissionLevel(level: PermissionLevel): void {
  // Permission level is changed ONLY from the tray (the user's privileged
  // control surface). The old renderer IPC channel was removed: a compromised
  // renderer must never be able to escalate to full control by itself.
  currentPermission = level;
}
export function getPermissionLevel(): PermissionLevel {
  return currentPermission;
}

export type { TabSession } from './registry';

export async function runTools(
  actions: Array<{ tool: string; args: Record<string, unknown> }>,
  session: TabSession = { opened: false },
  abortSignal?: AbortSignal
): Promise<string[]> {
  const results: string[] = [];
  const trayMode = currentPermission;

  const navIndices = actions
    .map((a, idx) => (['open_url', 'web_search', 'play_youtube'].includes(a.tool) ? idx : -1))
    .filter((idx) => idx !== -1);
  const lastNavIdx = navIndices.length > 0 ? navIndices[navIndices.length - 1] : -1;

  for (let i = 0; i < actions.length; i++) {
    const action = actions[i];
    if (['open_url', 'web_search', 'play_youtube'].includes(action.tool) && i !== lastNavIdx) {
      continue;
    }

    // Check global abort signal before each tool
    if (abortSignal?.aborted) {
      results.push('Execution aborted by user (Ctrl+Alt+X)');
      break;
    }

    try {
      const tool = toolRegistry.get(action.tool);
      if (!tool) {
        results.push(`Unknown tool: ${action.tool}`);
        continue;
      }

      const { allowed, needsConfirm } = toolRegistry.checkPermission(action.tool, trayMode);
      if (!allowed) {
        const maxRisk = toolRegistry.getToolsForTrayMode(trayMode).map(t => t.risk).join(', ');
        results.push(`Blocked "${action.tool}": requires ${tool.risk}, tray mode ${trayMode} allows up to ${maxRisk}`);
        continue;
      }

      // Enforce input rules BEFORE asking the user, so we never show a
      // confirmation dialog for arguments that would fail validation anyway.
      const validated = toolRegistry.validateArgs(action.tool, action.args);
      if (!validated.ok) {
        results.push(`${action.tool} rejected invalid arguments: ${validated.error}`);
        continue;
      }

      if (needsConfirm) {
        let confirmed: boolean;
        if (isVoiceModeActive()) {
          confirmed = await (await import('./voice')).handleVoiceConfirmation(action.tool, validated.value);
        } else {
          confirmed = await (await import('./confirm')).confirmSensitive(action.tool, validated.value);
        }
        if (!confirmed) {
          results.push(`User denied ${action.tool}`);
          continue;
        }
      }

      const ctx: ToolContext = { trayMode, session, abortSignal };
      const result = await toolRegistry.executeWithTimeout(action.tool, validated.value, ctx);

      if (result.success) {
        results.push(result.output);
      } else {
        results.push(`${action.tool} failed: ${result.error}`);
      }
    } catch (err) {
      logError(`runTools: ${action.tool}`, err);
      results.push(`${action.tool} failed: ${(err as Error).message}`);
    }
  }
  return results;
}

export async function getActiveWindowTitle(): Promise<string> {
  const { getForegroundWindowTitle, OVERLAY_TITLE } = await import('./foreground')
  const title = await getForegroundWindowTitle()
  if (title && title !== OVERLAY_TITLE) return title
  return ''
}

export async function captureScreenBase64(): Promise<string | null> {
  const { sleep } = await import('./packs/core');
  const { desktopCapturer, screen } = await import('electron');
  const { getOverlay } = await import('./overlay');

  const overlay = getOverlay();
  const wasVisible = Boolean(overlay && !overlay.isDestroyed() && overlay.isVisible());

  if (wasVisible && overlay) {
    overlay.setOpacity(0);
    await sleep(90);
  }

  try {
    const disp = screen.getPrimaryDisplay();
    const ratio = disp.size.height / Math.max(disp.size.width, 1);
    const width = 1280;
    const height = Math.max(720, Math.round(width * ratio));

    const sources = await desktopCapturer.getSources({
      types: ['screen'],
      thumbnailSize: { width, height },
    });

    if (sources.length > 0 && !sources[0].thumbnail.isEmpty()) {
      return sources[0].thumbnail.toJPEG(75).toString('base64');
    }
    return null;
  } catch (err) {
    console.warn('[vision] Screen capture failed:', (err as Error).message);
    return null;
  } finally {
    if (wasVisible && overlay && !overlay.isDestroyed()) {
      overlay.setOpacity(1);
    }
  }
}