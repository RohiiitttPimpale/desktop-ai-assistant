import pino from 'pino';
import fs from 'node:fs';
import path from 'node:path';
import { app } from 'electron';
import { getLogLevel } from './policy';

const LOG_DIR = path.join(app.getPath('userData'), 'logs');
const LOG_FILE = path.join(LOG_DIR, 'miko.log');

let loggerInstance: pino.Logger | null = null;

function createLogger(): pino.Logger {
  if (!fs.existsSync(LOG_DIR)) {
    fs.mkdirSync(LOG_DIR, { recursive: true });
  }

  const isDev = process.env['NODE_ENV'] === 'development' || process.env['COMPANION_DEVTOOLS'] === '1';
  const logLevel = getLogLevel();

  const fileStream = pino.destination({ dest: LOG_FILE, sync: false });

  const transports: pino.TransportTargetOptions[] = [
    { target: 'pino/file', options: { destination: LOG_FILE }, level: logLevel },
  ];

  if (isDev) {
    transports.unshift({
      target: 'pino-pretty',
      options: { colorize: true, translateTime: 'HH:MM:ss Z', ignore: 'pid,hostname' },
      level: logLevel,
    });
  }

  return pino({
    level: logLevel,
    base: { service: 'miko' },
    timestamp: pino.stdTimeFunctions.isoTime,
  }, isDev ? pino.transport({ targets: transports }) : fileStream);
}

export function getLogger(): pino.Logger {
  if (!loggerInstance) {
    loggerInstance = createLogger();
  }
  return loggerInstance;
}

export interface ToolLogContext {
  tool: string;
  args: Record<string, unknown>;
  trayMode: string;
  trusted: boolean;
  needsConfirm: boolean;
}

export function logToolCall(ctx: ToolLogContext): void {
  const log = getLogger();
  log.info({ ...ctx, event: 'tool_call' }, `Tool call: ${ctx.tool}`);
}

export function logToolResult(tool: string, success: boolean, output: string, error: string | undefined, durationMs: number): void {
  const log = getLogger();
  if (success) {
    log.info({ tool, output, durationMs, event: 'tool_result' }, `Tool success: ${tool} (${durationMs}ms)`);
  } else {
    log.error({ tool, error, durationMs, event: 'tool_error' }, `Tool failed: ${tool} (${durationMs}ms) - ${error}`);
  }
}

export function logAgentStep(step: number, speech: string, toolResults: string[]): void {
  const log = getLogger();
  log.info({ step, speech, toolResults, event: 'agent_step' }, `Agent step ${step}: ${speech}`);
}

export function logPermissionCheck(tool: string, trayMode: string, allowed: boolean, needsConfirm: boolean, trusted: boolean): void {
  const log = getLogger();
  log.info({ tool, trayMode, allowed, needsConfirm, trusted, event: 'permission_check' },
    `Permission: ${tool} (tray=${trayMode}) allowed=${allowed} confirm=${needsConfirm} trusted=${trusted}`);
}

export function logError(context: string, err: unknown): void {
  const log = getLogger();
  log.error({ context, error: (err as Error)?.message ?? String(err), event: 'error' }, `${context}: ${(err as Error)?.message ?? String(err)}`);
}