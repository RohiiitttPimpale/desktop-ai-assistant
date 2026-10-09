import { z } from 'zod';
import type { BrainAction } from './brain';
import { isToolTrusted, getToolTimeout } from './policy';
import { logPermissionCheck, logToolCall, logToolResult } from './logger';

export type RiskLevel = 'READ' | 'NORMAL' | 'SENSITIVE' | 'DANGEROUS';

export type TrayMode = 'read-only' | 'only-browser' | 'normal' | 'full';

export interface ToolResult {
  success: boolean;
  output: string;
  error?: string;
}

export interface ToolContext {
  trayMode: TrayMode;
  session: TabSession;
  abortSignal?: AbortSignal;
  /**
   * Aborted when this tool call times out or the user hits the stop hotkey.
   * Handlers that spawn child processes should pass it as the `signal`
   * option so the children die with the call instead of landing their side
   * effects after the agent was told the tool failed.
   */
  execSignal?: AbortSignal;
}

export interface TabSession {
  opened: boolean;
}

export interface ToolDef<Args extends z.ZodTypeAny = z.ZodTypeAny> {
  name: string;
  description: string;
  risk: RiskLevel;
  schema: Args;
  handler: (args: z.infer<Args>, ctx: ToolContext) => Promise<ToolResult>;
  /** Derived from the zod schema at registration — single source of truth for LLM-visible arg names. */
  argNames?: string[];
  /** Arg name -> JSON type for the LLM schema (ZodNumber => NUMBER, else STRING). */
  argTypes?: Record<string, 'string' | 'number'>;
}

const RISK_ORDER: Record<RiskLevel, number> = {
  READ: 0,
  NORMAL: 1,
  SENSITIVE: 2,
  DANGEROUS: 3,
};

const TRAY_MODE_MAX_RISK: Record<TrayMode, RiskLevel> = {
  'read-only': 'READ',
  'only-browser': 'NORMAL',
  'normal': 'SENSITIVE',
  'full': 'DANGEROUS',
};

const BROWSER_TOOLS = new Set(['web_search', 'play_youtube', 'open_url']);

export class ToolRegistry {
  private tools = new Map<string, ToolDef<z.ZodTypeAny>>();

  register<Args extends z.ZodTypeAny>(def: ToolDef<Args>): void {
    if (this.tools.has(def.name)) {
      throw new Error(`Tool "${def.name}" already registered`);
    }
    // Derive arg names/types once from the zod schema so the LLM schema and
    // brain.sanitize never drift from the actual validation rules.
    const argTypes: Record<string, 'string' | 'number'> = {};
    if (def.schema instanceof z.ZodObject) {
      for (const [key, type] of Object.entries(def.schema.shape)) {
        argTypes[key] = type instanceof z.ZodNumber ? 'number' : 'string';
      }
    }
    this.tools.set(
      def.name,
      { ...def, argNames: Object.keys(argTypes), argTypes } as unknown as ToolDef<z.ZodTypeAny>
    );
  }

  get(name: string): ToolDef | undefined {
    return this.tools.get(name);
  }

  getAll(): ToolDef[] {
    return Array.from(this.tools.values());
  }

  getNames(): string[] {
    return Array.from(this.tools.keys());
  }

  getSchemaForLLM(): Record<string, unknown> {
    const properties: Record<string, unknown> = {
      speech: { type: 'STRING' },
      emotion: { type: 'STRING', enum: ['neutral', 'happy', 'sad', 'angry', 'surprised', 'relaxed'] },
      gesture: { type: 'STRING', enum: ['none', 'nod', 'wave', 'shrug', 'think'] },
      done: { type: 'BOOLEAN' },
    };

    if (this.tools.size > 0) {
      const argProps: Record<string, unknown> = {
        tool: { type: 'STRING', enum: this.getNames() },
      };
      for (const tool of this.tools.values()) {
        for (const [key, type] of Object.entries(tool.argTypes ?? {})) {
          if (key !== 'tool') argProps[key] ??= { type: type === 'number' ? 'NUMBER' : 'STRING' };
        }
      }
      properties.actions = {
        type: 'ARRAY',
        items: {
          type: 'OBJECT',
          properties: argProps,
          required: ['tool'],
        },
      };
    }

    return {
      type: 'OBJECT',
      properties,
      required: this.tools.size > 0
        ? ['speech', 'emotion', 'gesture', 'actions', 'done']
        : ['speech', 'emotion', 'gesture', 'done'],
    };
  }

  checkPermission(toolName: string, trayMode: TrayMode): { allowed: boolean; needsConfirm: boolean } {
    const tool = this.tools.get(toolName);
    if (!tool) {
      logPermissionCheck(toolName, trayMode, false, false, false);
      return { allowed: false, needsConfirm: false };
    }

    if (trayMode === 'only-browser' && !BROWSER_TOOLS.has(toolName)) {
      logPermissionCheck(toolName, trayMode, false, false, false);
      return { allowed: false, needsConfirm: false };
    }

    const maxRisk = TRAY_MODE_MAX_RISK[trayMode];
    const toolRiskLevel = RISK_ORDER[tool.risk];
    const maxRiskLevel = RISK_ORDER[maxRisk];

    if (toolRiskLevel > maxRiskLevel) {
      logPermissionCheck(toolName, trayMode, false, false, false);
      return { allowed: false, needsConfirm: false };
    }

    const trusted = this.isTrustedInternal(toolName, tool.risk);
    const needsConfirm = toolRiskLevel >= RISK_ORDER.SENSITIVE && !trusted;

    logPermissionCheck(toolName, trayMode, true, needsConfirm, trusted);
    return { allowed: true, needsConfirm };
  }

  isTrustedInternal(toolName: string, risk: RiskLevel): boolean {
    // DANGEROUS tools are NEVER trusted, regardless of policy
    if (risk === 'DANGEROUS') {
      return false;
    }
    return isToolTrusted(toolName);
  }

  validateArgs(
    toolName: string,
    args: Record<string, unknown>
  ): { ok: true; value: Record<string, unknown> } | { ok: false; error: string } {
    const tool = this.tools.get(toolName);
    if (!tool) {
      return { ok: false, error: `Unknown tool: ${toolName}` };
    }
    const parsed = tool.schema.safeParse(args);
    if (!parsed.success) {
      const issues = parsed.error.issues
        .map((issue) => `${issue.path.join('.') || 'args'}: ${issue.message}`)
        .join('; ');
      return { ok: false, error: issues };
    }
    return { ok: true, value: parsed.data as Record<string, unknown> };
  }

  async executeWithTimeout<Args extends z.ZodTypeAny>(
    toolName: string,
    args: z.infer<Args>,
    ctx: ToolContext
  ): Promise<ToolResult> {
    const tool = this.tools.get(toolName);
    if (!tool) {
      return { success: false, output: '', error: `Unknown tool: ${toolName}` };
    }

    const timeoutMs = getToolTimeout(toolName);
    const startTime = Date.now();

    logToolCall({
      tool: toolName,
      args: args as Record<string, unknown>,
      trayMode: ctx.trayMode,
      trusted: this.isTrustedInternal(toolName, tool.risk),
      needsConfirm: tool.risk === 'SENSITIVE' || tool.risk === 'DANGEROUS',
    });

    // Emergency stop (Ctrl+Alt+X) already fired: never start the handler.
    // (An abort listener attached after the signal fired would never trigger.)
    if (ctx.abortSignal?.aborted) {
      logToolResult(toolName, false, '', 'Aborted by user', 0);
      return { success: false, output: '', error: 'Aborted by user (Ctrl+Alt+X)' };
    }

    // Per-tool timeout from policy.json (default 30s). The same controller
    // also kills any child processes the handler spawned (via ctx.execSignal).
    const execController = new AbortController();
    const handlerCtx: ToolContext = { ...ctx, execSignal: execController.signal };

    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeoutPromise = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        execController.abort();
        reject(new Error(`timed out after ${timeoutMs}ms`));
      }, timeoutMs);
    });

    // Emergency stop (Ctrl+Alt+X)
    let abortHandler: (() => void) | undefined;
    const abortPromise = new Promise<never>((_resolve, reject) => {
      if (!ctx.abortSignal) return;
      abortHandler = () => {
        execController.abort();
        reject(new Error('Aborted by user'));
      };
      ctx.abortSignal.addEventListener('abort', abortHandler, { once: true });
    });

    const execPromise = tool.handler(args, handlerCtx);
    // If the timeout wins the race, a late handler rejection must not become
    // an unhandled rejection - mark it handled without touching the race.
    execPromise.catch(() => undefined);

    try {
      const result = await Promise.race([execPromise, timeoutPromise, abortPromise]);
      const durationMs = Date.now() - startTime;
      logToolResult(toolName, result.success, result.output, result.error, durationMs);
      return result;
    } catch (err) {
      const durationMs = Date.now() - startTime;
      const errorMsg = (err as Error).message;
      logToolResult(toolName, false, '', errorMsg, durationMs);
      if (errorMsg === 'Aborted by user') {
        return { success: false, output: '', error: 'Aborted by user (Ctrl+Alt+X)' };
      }
      return { success: false, output: '', error: errorMsg };
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      if (abortHandler && ctx.abortSignal) {
        ctx.abortSignal.removeEventListener('abort', abortHandler);
      }
    }
  }

  getToolsForTrayMode(trayMode: TrayMode): ToolDef[] {
    if (trayMode === 'only-browser') {
      return this.getBrowserTools();
    }
    const maxRisk = TRAY_MODE_MAX_RISK[trayMode];
    const maxRiskLevel = RISK_ORDER[maxRisk];
    return this.getAll().filter((t) => RISK_ORDER[t.risk] <= maxRiskLevel);
  }

  getBrowserTools(): ToolDef[] {
    return this.getAll().filter((t) => BROWSER_TOOLS.has(t.name));
  }
}

export const toolRegistry = new ToolRegistry();