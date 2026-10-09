import { z } from 'zod';
import { app, clipboard, desktopCapturer, dialog, screen, shell } from 'electron';
import { execFile, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { toolRegistry, ToolContext, TabSession, RiskLevel } from '../../registry';
import { getOverlay, setOnTop } from '../../overlay';
import { getForegroundWindowTitle, OVERLAY_TITLE } from '../../foreground';

const execFileAsync = promisify(execFile);
export const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

const ALLOWED_APPS: Record<string, string> = {
  notepad: 'notepad.exe',
  calc: 'calc.exe',
  calculator: 'calc.exe',
  explorer: 'explorer.exe',
  taskmgr: 'taskmgr.exe',
  code: 'code',
  chrome: 'chrome',
  edge: 'msedge',
  brave: 'brave',
};
// NOTE (security): cmd.exe / Windows Terminal are deliberately NOT openable by
// the agent. open_app + type_text are both NORMAL-risk (auto-run), so a
// terminal the agent opened itself would allow unconfirmed shell command
// execution (AGENTS.md: shell is DANGEROUS-class and must always ask).
// If a terminal tool is ever needed, add a separate SENSITIVE tool with
// mandatory confirmation.

function launchDetached(exe: string): void {
  const child = spawn('cmd.exe', ['/c', 'start', '', exe], {
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
  });
  child.unref();
}

async function captureScreenToFile(filePath: string): Promise<boolean> {
  const overlay = getOverlay();
  const wasVisible = Boolean(overlay && !overlay.isDestroyed() && overlay.isVisible());

  if (wasVisible && overlay) {
    overlay.setOpacity(0);
    await sleep(120);
  }

  try {
    const disp = screen.getPrimaryDisplay();
    const width = Math.max(1280, Math.round(disp.size.width * disp.scaleFactor));
    const height = Math.max(720, Math.round(disp.size.height * disp.scaleFactor));

    const sources = await desktopCapturer.getSources({
      types: ['screen'],
      thumbnailSize: { width, height },
    });

    if (sources.length > 0 && !sources[0].thumbnail.isEmpty()) {
      await fs.promises.writeFile(filePath, sources[0].thumbnail.toPNG());
      return fs.existsSync(filePath);
    }
    return false;
  } finally {
    if (wasVisible && overlay && !overlay.isDestroyed()) {
      overlay.setOpacity(1);
    }
  }
}

async function navigateInBrowser(url: string, session: TabSession, signal?: AbortSignal): Promise<void> {
  if (!session.opened) {
    session.opened = true;
    await shell.openExternal(url);
    await sleep(1800);
    return;
  }

  const overlay = getOverlay();
  if (overlay && !overlay.isDestroyed()) {
    overlay.setIgnoreMouseEvents(true, { forward: true });
    overlay.blur();
  }

  const prevClip = await clipboard.readText();
  clipboard.writeText(url);
  const pyNav = [
    'import ctypes, time',
    'u = ctypes.windll.user32',
    'time.sleep(0.05)',
    'u.keybd_event(0x11, 0, 0, 0)',
    'u.keybd_event(0x4C, 0, 0, 0)',
    'time.sleep(0.03)',
    'u.keybd_event(0x4C, 0, 2, 0)',
    'u.keybd_event(0x11, 0, 2, 0)',
    'time.sleep(0.08)',
    'u.keybd_event(0x11, 0, 0, 0)',
    'u.keybd_event(0x56, 0, 0, 0)',
    'time.sleep(0.03)',
    'u.keybd_event(0x56, 0, 2, 0)',
    'u.keybd_event(0x11, 0, 2, 0)',
    'time.sleep(0.06)',
    'u.keybd_event(0x0D, 0, 0, 0)',
    'u.keybd_event(0x0D, 0, 2, 0)',
  ].join('\n');

  try {
    await execFileAsync('python', ['-c', pyNav], { timeout: 3000, windowsHide: true, signal });
    await sleep(1600);
  } finally {
    // Always restore the user's clipboard, even if navigation failed/timed out
    clipboard.writeText(prevClip);
  }
}

async function clickScreenNormalized(rawX: number, rawY: number, mode: string, signal?: AbortSignal): Promise<string> {
  let nx = rawX;
  let ny = rawY;
  if (nx > 0 && nx <= 1 && ny > 0 && ny <= 1) {
    nx *= 1000;
    ny *= 1000;
  }
  nx = Math.max(0, Math.min(1000, nx));
  ny = Math.max(0, Math.min(1000, ny));

  const dx = Math.round((nx / 1000) * 65535);
  const dy = Math.round((ny / 1000) * 65535);

  const overlay = getOverlay();
  if (overlay && !overlay.isDestroyed()) {
    overlay.setIgnoreMouseEvents(true, { forward: true });
  }

  const isRight = mode.includes('right');
  const isDouble = mode.includes('double');
  const downFlag = isRight ? 8 : 2;
  const upFlag = isRight ? 16 : 4;
  const clicks = isDouble ? 2 : 1;

  const pyScript = [
    'import ctypes, time',
    'u = ctypes.windll.user32',
    'u.SetProcessDPIAware()',
    `u.mouse_event(0x8001, ${dx}, ${dy}, 0, 0)`,
    'time.sleep(0.04)',
    `for _ in range(${clicks}):`,
    `    u.mouse_event(${downFlag}, 0, 0, 0, 0)`,
    '    time.sleep(0.03)',
    `    u.mouse_event(${upFlag}, 0, 0, 0, 0)`,
    '    time.sleep(0.05)',
  ].join('\n');

  await execFileAsync('python', ['-c', pyScript], { timeout: 4000, windowsHide: true, signal });
  const label = isDouble ? 'Double-clicked' : isRight ? 'Right-clicked' : 'Clicked';
  return `${label} at (${Math.round(nx)}, ${Math.round(ny)})`;
}

async function sendShortcutKey(rawKey: string, signal?: AbortSignal): Promise<string> {
  const k = rawKey.toLowerCase().trim();
  let codes: number[] | null = null;

  if (k === 'ctrl+tab' || k === 'next_tab') codes = [0x11, 0x09];
  else if (k === 'ctrl+shift+tab' || k === 'prev_tab') codes = [0x11, 0x10, 0x09];
  else if (k === 'ctrl+t' || k === 'new_tab') codes = [0x11, 0x54];
  else if (k === 'ctrl+w' || k === 'close_tab') codes = [0x11, 0x57];
  else if (k === 'ctrl+l' || k === 'address_bar') codes = [0x11, 0x4c];
  else if (k === 'ctrl+s' || k === 'save') codes = [0x11, 0x53];
  else if (k === 'alt+f4' || k === 'close_window') codes = [0x12, 0x73];
  else if (k === 'back' || k === 'alt+left') codes = [0x12, 0x25];
  else if (k === 'pagedown' || k === 'page_down') codes = [0x22];
  else if (k === 'pageup' || k === 'page_up') codes = [0x21];
  else if (k === 'escape' || k === 'esc') codes = [0x1b];
  else if (k === 'enter' || k === 'return') codes = [0x0d];

  // NOTE: keep SUPPORTED_KEYS (below) in sync with these mappings.
  // Unknown keys must never fall through to a default key press.
  if (codes === null) {
    throw new Error(`Unsupported key: "${rawKey}"`);
  }

  const pyKey = [
    'import ctypes, time',
    'u = ctypes.windll.user32',
    `codes = [${codes.join(', ')}]`,
    'for c in codes:',
    '    u.keybd_event(c, 0, 0, 0)',
    '    time.sleep(0.02)',
    'for c in reversed(codes):',
    '    u.keybd_event(c, 0, 2, 0)',
    '    time.sleep(0.02)',
  ].join('\n');

  await execFileAsync('python', ['-c', pyKey], { timeout: 3000, windowsHide: true, signal });
  return `Pressed ${k}`;
}

// Every key the mappings in sendShortcutKey actually handle.
const SUPPORTED_KEYS = [
  'ctrl+tab', 'next_tab', 'ctrl+shift+tab', 'prev_tab',
  'ctrl+t', 'new_tab', 'ctrl+w', 'close_tab',
  'ctrl+l', 'address_bar', 'ctrl+s', 'save',
  'alt+f4', 'close_window', 'back', 'alt+left',
  'pagedown', 'page_down', 'pageup', 'page_up',
  'escape', 'esc', 'enter', 'return',
] as const;

async function scrollActivePage(direction: string, signal?: AbortSignal): Promise<string> {
  const isUp = direction.toLowerCase().includes('up');
  const delta = isUp ? 650 : -650;
  const pyScroll = [
    'import ctypes',
    'u = ctypes.windll.user32',
    `u.mouse_event(0x0800, 0, 0, ${delta}, 0)`,
  ].join('\n');
  await execFileAsync('python', ['-c', pyScroll], { timeout: 3000, windowsHide: true, signal });
  return `Scrolled ${isUp ? 'up' : 'down'}`;
}

async function searchAndOpenYouTube(query: string, session: TabSession, signal?: AbortSignal): Promise<string> {
  const searchUrl = `https://www.youtube.com/results?search_query=${encodeURIComponent(query)}`;
  try {
    const res = await fetch(searchUrl, {
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        'Accept-Language': 'en-US,en;q=0.9',
      },
      signal: signal ?? AbortSignal.timeout(6000),
    });
    const html = await res.text();
    const match = html.match(/"videoRenderer":\{"videoId":"([a-zA-Z0-9_-]{11})".*?"title":\{"runs":\[\{"text":"([^"]+)"/);
    if (match) {
      const videoId = match[1];
      const title = match[2];
      await navigateInBrowser(`https://www.youtube.com/watch?v=${videoId}`, session, signal);
      return `Playing "${title}" in active tab`;
    }
    const idOnly = html.match(/"videoId":"([a-zA-Z0-9_-]{11})"/);
    if (idOnly) {
      await navigateInBrowser(`https://www.youtube.com/watch?v=${idOnly[1]}`, session, signal);
      return `Playing YouTube video for "${query}" in active tab`;
    }
  } catch {
    /* fallback to search results page */
  }
  await navigateInBrowser(searchUrl, session, signal);
  return `Searched YouTube for "${query}" in active tab`;
}

// ===== TOOL DEFINITIONS =====

// READ tools
toolRegistry.register({
  name: 'look_at_screen',
  description: 'Captures a fresh view of the screen (use this to wait if the UI is still loading).',
  risk: 'READ',
  schema: z.object({}),
  handler: async () => {
    await sleep(1500);
    return { success: true, output: 'Looked at screen' };
  },
});

toolRegistry.register({
  name: 'get_battery',
  description: 'Returns the current battery percentage.',
  risk: 'READ',
  schema: z.object({}),
  handler: async (_args, ctx) => {
    const pyBat = [
      'import ctypes',
      'class SPS(ctypes.Structure):',
      '    _fields_ = [("AC", ctypes.c_byte), ("Flag", ctypes.c_byte), ("Pct", ctypes.c_byte), ("R1", ctypes.c_byte), ("Life", ctypes.c_ulong), ("Full", ctypes.c_ulong)]',
      's = SPS()',
      'ctypes.windll.kernel32.GetSystemPowerStatus(ctypes.byref(s))',
      'print(s.Pct)',
    ].join('\n');
    const { stdout } = await execFileAsync('python', ['-c', pyBat], { windowsHide: true, signal: ctx?.execSignal });
    const pct = stdout.trim() || 'AC';
    return { success: true, output: `Battery: ${pct}%` };
  },
});

toolRegistry.register({
  name: 'get_system_info',
  description: 'Returns system memory information.',
  risk: 'READ',
  schema: z.object({}),
  handler: async () => {
    const freeGb = (os.freemem() / 1024 ** 3).toFixed(1);
    const totalGb = (os.totalmem() / 1024 ** 3).toFixed(1);
    return { success: true, output: `RAM: ${freeGb}GB free / ${totalGb}GB total` };
  },
});

// NORMAL tools
toolRegistry.register({
  name: 'web_search',
  description: 'Searches Google in the active tab. Set "query" to the search query.',
  risk: 'NORMAL',
  schema: z.object({ query: z.string().min(1) }),
  handler: async ({ query }, ctx) => {
    const url = `https://www.google.com/search?q=${encodeURIComponent(query)}`;
    await navigateInBrowser(url, ctx.session, ctx.execSignal);
    return { success: true, output: `Searched Google for "${query}"` };
  },
});

toolRegistry.register({
  name: 'play_youtube',
  description: 'Finds and plays a YouTube video in the active tab. Set "query" to the search query.',
  risk: 'NORMAL',
  schema: z.object({ query: z.string().min(1) }),
  handler: async ({ query }, ctx) => {
    const msg = await searchAndOpenYouTube(query, ctx.session, ctx.execSignal);
    return { success: true, output: msg };
  },
});

toolRegistry.register({
  name: 'open_url',
  description: 'Navigates to an http(s) URL in the active tab. Set "url" to the URL.',
  risk: 'NORMAL',
  schema: z.object({
    url: z
      .string()
      .url()
      .refine((v) => /^https?:\/\//i.test(v), { message: 'must be an http(s):// URL' })
  }),
  handler: async ({ url }, ctx) => {
    await navigateInBrowser(url, ctx.session, ctx.execSignal);
    return { success: true, output: `Navigated to ${url}` };
  },
});

toolRegistry.register({
  name: 'open_app',
  description: 'Opens a desktop app. Set "app" to the app name (notepad, calc, explorer, taskmgr, code, chrome, edge, brave).',
  risk: 'NORMAL',
  schema: z.object({ app: z.string().min(1) }),
  handler: async ({ app: appName }, ctx) => {
    const rawName = appName.toLowerCase().replace(/\.exe$/, '').trim();
    const target = ALLOWED_APPS[rawName];
    if (!target) {
      return { success: false, output: '', error: `Blocked app "${rawName}"` };
    }
    launchDetached(target);
    await sleep(3000);
    return { success: true, output: `Opened ${rawName}` };
  },
});

toolRegistry.register({
  name: 'set_volume',
  description: 'Adjusts system volume. Set "mode" to "up", "down", or "mute".',
  risk: 'NORMAL',
  schema: z.object({ mode: z.enum(['up', 'down', 'mute']).default('up') }),
  handler: async ({ mode }, ctx) => {
    const vk = mode === 'mute' ? 0xad : mode === 'down' ? 0xae : 0xaf;
    const steps = mode === 'mute' ? 1 : 5;
    const pyVol = [
      'import ctypes, time',
      'u = ctypes.windll.user32',
      `for _ in range(${steps}):`,
      `    u.keybd_event(${vk}, 0, 0, 0)`,
      `    u.keybd_event(${vk}, 0, 2, 0)`,
      '    time.sleep(0.02)',
    ].join('\n');
    await execFileAsync('python', ['-c', pyVol], { windowsHide: true, signal: ctx?.execSignal });
    return { success: true, output: `Volume: ${mode}` };
  },
});

toolRegistry.register({
  name: 'take_screenshot',
  description: 'Saves a PNG screenshot to Pictures folder.',
  risk: 'NORMAL',
  schema: z.object({}),
  handler: async () => {
    const picturesDir = app.getPath('pictures');
    await fs.promises.mkdir(picturesDir, { recursive: true });
    const fileName = `miko-shot-${Date.now()}.png`;
    const filePath = path.join(picturesDir, fileName);
    const saved = await captureScreenToFile(filePath);
    if (!saved || !fs.existsSync(filePath)) {
      return { success: false, output: '', error: 'Screen capture failed - no file was saved' };
    }
    return { success: true, output: `Saved ${fileName} in Pictures` };
  },
});

// GUI interaction tools (NORMAL risk per blueprint.md: run automatically and log in Normal/Full Control)
toolRegistry.register({
  name: 'click_screen',
  description: 'Clicks on screen at normalized coordinates. Set "x" (0-1000) and "y" (0-1000). Set "button" to "left", "right", or "double".',
  risk: 'NORMAL',
  schema: z.object({
    x: z.number().min(0).max(1000),
    y: z.number().min(0).max(1000),
    button: z.enum(['left', 'right', 'double']).default('left'),
  }),
  handler: async ({ x, y, button }, ctx) => {
    const msg = await clickScreenNormalized(x, y, button, ctx.execSignal);
    await sleep(1000);
    return { success: true, output: msg };
  },
});

toolRegistry.register({
  name: 'type_text',
  description: 'Types text into the focused input box and presses Enter. Set "text" to the text to type.',
  risk: 'NORMAL',
  schema: z.object({ text: z.string().min(1) }),
  handler: async ({ text }, ctx) => {
    // Never type into our own window: if the overlay has focus (the user
    // clicked Miko's chat input), the paste + Enter would submit the text
    // to Miko herself.
    const fg = await getForegroundWindowTitle();
    if (fg === OVERLAY_TITLE) {
      return {
        success: false,
        output: '',
        error: "Focused window is Miko's own overlay - refusing to type into myself. Use click_screen to focus the target app first."
      };
    }
    const prevClip = await clipboard.readText();
    clipboard.writeText(text);
    const pyPaste = [
      'import ctypes, time',
      'u = ctypes.windll.user32',
      'time.sleep(0.06)',
      'u.keybd_event(0x11, 0, 0, 0)',
      'u.keybd_event(0x56, 0, 0, 0)',
      'time.sleep(0.03)',
      'u.keybd_event(0x56, 0, 2, 0)',
      'u.keybd_event(0x11, 0, 2, 0)',
      'time.sleep(0.06)',
      'u.keybd_event(0x0D, 0, 0, 0)',
      'u.keybd_event(0x0D, 0, 2, 0)',
    ].join('\n');
    try {
      await execFileAsync('python', ['-c', pyPaste], { timeout: 3000, windowsHide: true, signal: ctx.execSignal });
      await sleep(1200);
    } finally {
      // Always restore the user's clipboard, even if the paste failed/timed out
      clipboard.writeText(prevClip);
    }
    return { success: true, output: `Typed "${text}"` };
  },
});

toolRegistry.register({
  name: 'press_key',
  description: 'Presses a key combination. Set "key" to one of: ctrl+tab, ctrl+shift+tab, ctrl+t, ctrl+w, ctrl+l, ctrl+s, alt+f4, back, enter, escape, pagedown, pageup.',
  risk: 'NORMAL',
  schema: z.object({ key: z.enum(SUPPORTED_KEYS) }),
  handler: async ({ key }, ctx) => {
    // Keyboard shortcuts (especially alt+f4) must never be sent to Miko's
    // own window — that is how she used to close herself and vanish.
    const fg = await getForegroundWindowTitle();
    if (fg === OVERLAY_TITLE) {
      return {
        success: false,
        output: '',
        error: "Focused window is Miko's own overlay - refusing to press keys against myself. Use click_screen to focus the target window first."
      };
    }
    const msg = await sendShortcutKey(key, ctx.execSignal);
    const delay = key.toLowerCase().includes('ctrl+s') ? 2500 : 800;
    await sleep(delay);
    return { success: true, output: msg };
  },
});

toolRegistry.register({
  name: 'scroll_page',
  description: 'Scrolls the active page. Set "direction" to "up" or "down".',
  risk: 'NORMAL',
  schema: z.object({ direction: z.enum(['up', 'down']).default('down') }),
  handler: async ({ direction }, ctx) => {
    const msg = await scrollActivePage(direction, ctx.execSignal);
    await sleep(800);
    return { success: true, output: msg };
  },
});

// Test SENSITIVE tool
toolRegistry.register({
  name: 'test_sensitive',
  description: 'Test tool that does nothing, just tests the confirmation gate.',
  risk: 'SENSITIVE',
  schema: z.object({}),
  handler: async () => {
    return { success: true, output: 'Test sensitive tool executed successfully' };
  },
});