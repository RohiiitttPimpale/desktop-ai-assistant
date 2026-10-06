import { app } from 'electron';
import fs from 'node:fs';
import path from 'node:path';

export interface Policy {
  trustedTools: string[];
  toolTimeouts: Record<string, number>;
  globalStopHotkey: string;
  logLevel: string;
}

const DEFAULT_POLICY: Policy = {
  trustedTools: [],
  toolTimeouts: {},
  globalStopHotkey: 'Ctrl+Alt+X',
  logLevel: 'info',
};

const POLICY_FILE = path.join(app.getPath('userData'), 'policy.json');

let policyCache: Policy | null = null;

export function getPolicy(): Policy {
  if (policyCache) return policyCache;

  try {
    if (fs.existsSync(POLICY_FILE)) {
      const raw = fs.readFileSync(POLICY_FILE, 'utf-8');
      const parsed = JSON.parse(raw) as Partial<Policy>;
      policyCache = { ...DEFAULT_POLICY, ...parsed };
    } else {
      policyCache = { ...DEFAULT_POLICY };
    }
  } catch (err) {
    console.error('[policy] Failed to load policy, using defaults:', err);
    policyCache = { ...DEFAULT_POLICY };
  }
  return policyCache;
}

export function updatePolicy(patch: Partial<Policy>): Policy {
  policyCache = { ...getPolicy(), ...patch };
  try {
    fs.mkdirSync(path.dirname(POLICY_FILE), { recursive: true });
    fs.writeFileSync(POLICY_FILE, JSON.stringify(policyCache, null, 2));
  } catch (err) {
    console.error('[policy] Failed to save policy:', err);
  }
  return policyCache;
}

export function getToolTimeout(toolName: string): number {
  const policy = getPolicy();
  return policy.toolTimeouts[toolName] ?? 30000;
}

export function isToolTrusted(toolName: string): boolean {
  const policy = getPolicy();
  return policy.trustedTools.includes(toolName);
}

export function getGlobalStopHotkey(): string {
  return getPolicy().globalStopHotkey;
}

export function getLogLevel(): string {
  return getPolicy().logLevel;
}