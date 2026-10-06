import { dialog, BrowserWindow } from 'electron';
import { getOverlay } from './overlay';

export async function confirmSensitive(
  toolName: string,
  args: Record<string, unknown>
): Promise<boolean> {
  const overlay = getOverlay();
  const argsStr = JSON.stringify(args, null, 2);

  const msgOpts = {
    type: 'question' as const,
    buttons: ['Allow', 'Cancel'],
    defaultId: 0,
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