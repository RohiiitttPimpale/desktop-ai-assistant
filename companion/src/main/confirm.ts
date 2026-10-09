import { dialog, BrowserWindow } from 'electron';
import { getOverlay } from './overlay';

/** Cap the args preview so a confirmation dialog never becomes a wall of text. */
function previewArgs(args: Record<string, unknown>, maxChars = 400): string {
  const full = JSON.stringify(args, null, 2);
  if (full.length <= maxChars) return full;
  return full.slice(0, maxChars) + '…';
}

export async function confirmSensitive(
  toolName: string,
  args: Record<string, unknown>
): Promise<boolean> {
  const overlay = getOverlay();
  const argsStr = previewArgs(args);

  const msgOpts = {
    type: 'question' as const,
    buttons: ['Allow', 'Cancel'],
    // Default to Cancel: an accidental Enter must never approve a SENSITIVE action
    defaultId: 1,
    cancelId: 1,
    title: 'Confirm Sensitive Action',
    message: `Miko wants to run: ${toolName}`,
    detail: `Arguments:\n${argsStr}\n\nThis action requires confirmation.`,
  };

  const win = overlay || undefined;
  const result = win
    ? await dialog.showMessageBox(win as BrowserWindow, msgOpts)
    : await dialog.showMessageBox(msgOpts);

  return result.response === 0;
}