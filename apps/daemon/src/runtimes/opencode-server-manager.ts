import { spawn, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import os from 'node:os';

import {
  captureProcessSnapshot,
  createCommandInvocation,
  readProcessIdentities,
  selectOwnedProcessTree,
  stopProcesses,
  terminateProcessGroup,
} from '@open-design/platform';

import {
  OPEN_DESIGN_OPENCODE_SERVER_URL,
  OPENCODE_SERVER_CLIENT_PASSWORD,
  resolveOpenCodeServerUrl,
} from './defs/opencode-server.js';

const READINESS_TIMEOUT_MS = 10_000;
const READINESS_POLL_MS = 100;
const HEALTH_TIMEOUT_MS = 1_000;
const LOG_TAIL_LIMIT = 16 * 1024;

type ManagedTarget = {
  hostname: string;
  port: number;
  url: string;
};

type ManagedState = {
  child: ChildProcess;
  key: string;
  logTail: string;
  password: string;
  processGroupId: number | null;
  spawnError: Error | null;
  url: string;
};

let managedState: ManagedState | null = null;
let lifecycleQueue: Promise<void> = Promise.resolve();

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function managedTarget(env: NodeJS.ProcessEnv | Record<string, string>): ManagedTarget | null {
  const url = new URL(resolveOpenCodeServerUrl(env));
  const loopback = url.hostname === '127.0.0.1'
    || url.hostname === 'localhost'
    || url.hostname === '[::1]';
  if (!loopback || url.protocol !== 'http:' || url.pathname !== '/') return null;
  return {
    hostname: url.hostname === '[::1]' ? '::1' : url.hostname,
    port: Number(url.port || '80'),
    url: url.toString().replace(/\/$/u, ''),
  };
}

function authorizationHeader(password: string): string {
  return `Basic ${Buffer.from(`opencode:${password}`, 'utf8').toString('base64')}`;
}

async function probeServer(
  url: string,
  password: string,
): Promise<'healthy' | 'occupied' | 'unreachable'> {
  try {
    const response = await fetch(`${url}/api/info`, {
      headers: { authorization: authorizationHeader(password) },
      signal: AbortSignal.timeout(HEALTH_TIMEOUT_MS),
    });
    if (!response.ok) return 'occupied';
    const body = await response.json().catch(() => null) as { version?: unknown } | null;
    return typeof body?.version === 'string' ? 'healthy' : 'occupied';
  } catch {
    return 'unreachable';
  }
}

function appendLog(state: ManagedState, chunk: unknown): void {
  state.logTail = `${state.logTail}${String(chunk)}`.slice(-LOG_TAIL_LIMIT);
}

async function stopState(state: ManagedState): Promise<void> {
  if (managedState === state) managedState = null;
  if (state.child.exitCode != null || state.child.signalCode != null) return;
  if (process.platform !== 'win32' && state.processGroupId != null) {
    await terminateProcessGroup(state.processGroupId, {
      termGraceMs: 2_000,
      killGraceMs: 2_000,
    });
    return;
  }
  const pid = state.child.pid;
  if (typeof pid !== 'number') return;
  if (process.platform === 'win32') {
    const identities = await readProcessIdentities([pid]);
    const root = identities.get(pid);
    if (root && typeof root.startedAtMs === 'number') {
      const tree = selectOwnedProcessTree(
        [{
          command: root.command,
          pid: root.pid,
          ppid: root.ppid,
          startedAtMs: root.startedAtMs,
        }],
        await captureProcessSnapshot(),
      );
      await stopProcesses(tree.map((entry) => entry.pid), {
        termGraceMs: 2_000,
        killGraceMs: 2_000,
      });
      return;
    }
  }
  await stopProcesses([pid], { termGraceMs: 2_000, killGraceMs: 2_000 });
}

async function stopCurrentState(): Promise<void> {
  const current = managedState;
  if (current) await stopState(current);
}

function enqueue<T>(operation: () => Promise<T>): Promise<T> {
  const result = lifecycleQueue.then(operation, operation);
  lifecycleQueue = result.then(() => undefined, () => undefined);
  return result;
}

/**
 * Ensure a loopback OpenCode v2 server is available for the server runtime.
 * Remote and HTTPS endpoints remain externally owned. A healthy pre-existing
 * loopback server is reused, but only a child started here is stopped here.
 */
export function ensureManagedOpenCodeServer(
  resolvedBin: string,
  configuredEnv: Record<string, string>,
): Promise<Record<string, string>> {
  return enqueue(async () => {
    const target = managedTarget({ ...process.env, ...configuredEnv });
    if (!target) {
      // A remote connection is independent from a locally managed child.
      // Do not tear down an active local server merely because another probe
      // or run targets an externally owned endpoint.
      return { ...configuredEnv };
    }

    const configuredPassword = (
      configuredEnv[OPENCODE_SERVER_CLIENT_PASSWORD]
      ?? process.env[OPENCODE_SERVER_CLIENT_PASSWORD]
    )?.trim();
    const password = configuredPassword
      || (managedState?.url === target.url ? managedState.password : randomBytes(32).toString('hex'));
    const effectiveEnv = {
      ...configuredEnv,
      [OPEN_DESIGN_OPENCODE_SERVER_URL]: target.url,
      [OPENCODE_SERVER_CLIENT_PASSWORD]: password,
    };
    const key = JSON.stringify({ resolvedBin, url: target.url, password });

    if (managedState?.key === key) {
      if (await probeServer(target.url, password) === 'healthy') return effectiveEnv;
      await stopCurrentState();
    } else if (managedState) {
      await stopCurrentState();
    }

    const existing = await probeServer(target.url, password);
    if (existing === 'healthy') return effectiveEnv;
    if (existing === 'occupied') {
      throw new Error(
        `OpenCode Server URL ${target.url} is already in use but did not accept the configured password.`,
      );
    }

    const invocation = createCommandInvocation({
      command: resolvedBin,
      args: [
        'serve',
        '--hostname',
        target.hostname,
        '--port',
        String(target.port),
        '--print-logs',
      ],
      env: effectiveEnv,
    });
    const child = spawn(invocation.command, invocation.args, {
      cwd: os.tmpdir(),
      detached: process.platform !== 'win32',
      env: {
        ...process.env,
        ...effectiveEnv,
        OPENCODE_SERVER_PASSWORD: password,
      },
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
      windowsVerbatimArguments: invocation.windowsVerbatimArguments,
    });
    const state: ManagedState = {
      child,
      key,
      logTail: '',
      password,
      processGroupId:
        process.platform !== 'win32' && typeof child.pid === 'number'
          ? child.pid
          : null,
      spawnError: null,
      url: target.url,
    };
    managedState = state;
    child.stdout?.on('data', (chunk) => appendLog(state, chunk));
    child.stderr?.on('data', (chunk) => appendLog(state, chunk));
    child.once('error', (error) => {
      state.spawnError = error;
    });
    child.once('exit', () => {
      if (managedState === state) managedState = null;
    });

    const deadline = Date.now() + READINESS_TIMEOUT_MS;
    while (Date.now() < deadline) {
      if (state.spawnError) {
        if (managedState === state) managedState = null;
        throw new Error(
          `OpenDesign could not start the managed OpenCode Server: ${state.spawnError.message}`,
        );
      }
      if (child.exitCode != null || child.signalCode != null) {
        const detail = state.logTail.trim();
        throw new Error(
          `OpenDesign-managed OpenCode Server exited before readiness${detail ? `: ${detail}` : '.'}`,
        );
      }
      if (await probeServer(target.url, password) === 'healthy') {
        console.log(`[opencode-server] managed server ready at ${target.url}`);
        return effectiveEnv;
      }
      await delay(READINESS_POLL_MS);
    }

    await stopState(state);
    const detail = state.logTail.trim();
    throw new Error(
      `Timed out starting OpenDesign-managed OpenCode Server at ${target.url}${detail ? `: ${detail}` : '.'}`,
    );
  });
}

/** Stop the OpenCode Server child owned by this daemon, if any. */
export function stopManagedOpenCodeServer(): Promise<void> {
  return enqueue(stopCurrentState);
}

export function managedOpenCodeServerStatus(): {
  owned: boolean;
  pid: number | null;
  url: string | null;
} {
  return {
    owned: managedState != null,
    pid: managedState?.child.pid ?? null,
    url: managedState?.url ?? null,
  };
}
