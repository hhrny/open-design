import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';

import {
  OPENCODE_SERVER_CLIENT_PASSWORD,
  resolveOpenCodeServerUrl,
} from './defs/opencode-server.js';
import type { RuntimeEnv } from './types.js';

type JsonObject = Record<string, unknown>;

export type OpenCodeServerTransportOptions = {
  cwd: string;
  env: RuntimeEnv;
  model?: string | null;
  prompt: string;
  reasoning?: string | null;
  resumeSessionId?: string | null;
  title?: string;
};

function isRecord(value: unknown): value is JsonObject {
  return value != null && typeof value === 'object' && !Array.isArray(value);
}

function apiUrl(baseUrl: string, pathname: string): string {
  return `${baseUrl.replace(/\/+$/u, '')}/${pathname.replace(/^\/+/, '')}`;
}

function authorizationHeader(env: RuntimeEnv): string | null {
  const password = env[OPENCODE_SERVER_CLIENT_PASSWORD]?.trim();
  if (!password) return null;
  return `Basic ${Buffer.from(`opencode:${password}`, 'utf8').toString('base64')}`;
}

function modelRef(model: string | null | undefined, reasoning: string | null | undefined): JsonObject | null {
  const value = typeof model === 'string' ? model.trim() : '';
  if (!value || value === 'default') return null;
  const separator = value.indexOf('/');
  if (separator <= 0 || separator === value.length - 1) {
    throw new Error(`OpenCode Server model must use provider/model format: ${value}`);
  }
  const variant = typeof reasoning === 'string' ? reasoning.trim() : '';
  return {
    providerID: value.slice(0, separator),
    id: value.slice(separator + 1),
    ...(variant && variant !== 'default' ? { variant } : {}),
  };
}

function errorMessage(value: unknown, fallback: string): string {
  if (typeof value === 'string' && value.trim()) return value;
  if (isRecord(value)) {
    if (typeof value.message === 'string' && value.message.trim()) return value.message;
    if (typeof value.error === 'string' && value.error.trim()) return value.error;
    if (value.error != null) return errorMessage(value.error, fallback);
    if (value.data != null) return errorMessage(value.data, fallback);
  }
  return fallback;
}

function toolContentText(value: unknown): string {
  if (!Array.isArray(value)) return value == null ? '' : JSON.stringify(value);
  return value.map((item) => {
    if (!isRecord(item)) return String(item ?? '');
    if (item.type === 'text' && typeof item.text === 'string') return item.text;
    if (item.type === 'file' && typeof item.url === 'string') return item.url;
    return JSON.stringify(item);
  }).filter(Boolean).join('\n');
}

class OpenCodeServerTransport extends EventEmitter {
  readonly stdin = null;
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly pid = undefined;
  killed = false;

  private readonly abortController = new AbortController();
  private readonly baseUrl: string;
  private readonly headers: Record<string, string>;
  private closed = false;
  private sessionId: string | null = null;
  private readonly toolNames = new Map<string, string>();

  constructor(private readonly options: OpenCodeServerTransportOptions) {
    super();
    this.baseUrl = resolveOpenCodeServerUrl(options.env);
    const authorization = authorizationHeader(options.env);
    this.headers = {
      accept: 'application/json',
      ...(authorization ? { authorization } : {}),
    };
    queueMicrotask(() => void this.start());
  }

  kill(signal: NodeJS.Signals | number = 'SIGTERM'): boolean {
    if (this.closed) return false;
    this.killed = true;
    const sessionId = this.sessionId;
    if (sessionId) {
      void fetch(apiUrl(this.baseUrl, `/api/session/${encodeURIComponent(sessionId)}/interrupt`), {
        method: 'POST',
        headers: this.headers,
      }).catch(() => undefined);
    }
    this.abortController.abort();
    this.finish(null, typeof signal === 'string' ? signal : 'SIGTERM');
    return true;
  }

  private emitFrame(frame: JsonObject): void {
    if (!this.closed) this.stdout.write(`${JSON.stringify(frame)}\n`);
  }

  private finish(code: number | null, signal: NodeJS.Signals | null): void {
    if (this.closed) return;
    this.closed = true;
    this.abortController.abort();
    this.stdout.end();
    this.stderr.end();
    queueMicrotask(() => {
      this.emit('exit', code, signal);
      this.emit('close', code, signal);
    });
  }

  private fail(error: unknown): void {
    if (this.closed) return;
    const message = errorMessage(error, 'OpenCode Server transport failed');
    this.stderr.write(`${message}\n`);
    this.emitFrame({ type: 'error', error: { message } });
    this.finish(1, null);
  }

  private async request(pathname: string, init: RequestInit = {}): Promise<Response> {
    const response = await fetch(apiUrl(this.baseUrl, pathname), {
      ...init,
      headers: {
        ...this.headers,
        ...(init.body != null ? { 'content-type': 'application/json' } : {}),
        ...(init.headers ?? {}),
      },
      signal: this.abortController.signal,
    });
    if (response.ok) return response;
    const raw = await response.text().catch(() => '');
    let detail: unknown = raw;
    try {
      detail = raw ? JSON.parse(raw) : null;
    } catch {
      // Keep the bounded HTTP response text as the diagnostic.
    }
    throw new Error(
      `OpenCode Server ${init.method ?? 'GET'} ${pathname} failed (${response.status}): ${errorMessage(detail, response.statusText)}`,
    );
  }

  private async requestJson(pathname: string, init: RequestInit = {}): Promise<unknown> {
    const response = await this.request(pathname, init);
    return response.json();
  }

  private async start(): Promise<void> {
    try {
      const eventResponse = await this.request('/api/event', {
        headers: { accept: 'text/event-stream' },
      });
      if (!eventResponse.body) throw new Error('OpenCode Server event stream returned no body.');
      const eventLoop = this.consumeEventStream(eventResponse.body).catch((error) => {
        if (!this.closed && !this.abortController.signal.aborted) this.fail(error);
      });

      const requestedSessionId = this.options.resumeSessionId?.trim() || null;
      if (requestedSessionId) {
        const existing = await this.requestJson(`/api/session/${encodeURIComponent(requestedSessionId)}`);
        const existingData = isRecord(existing) && isRecord(existing.data) ? existing.data : null;
        if (existingData?.id !== requestedSessionId) {
          throw new Error(`OpenCode Server did not return resumed session ${requestedSessionId}.`);
        }
        this.sessionId = requestedSessionId;
      } else {
        const selectedModel = modelRef(this.options.model, this.options.reasoning);
        const created = await this.requestJson('/api/session', {
          method: 'POST',
          body: JSON.stringify({
            title: this.options.title ?? 'Open Design',
            location: { directory: this.options.cwd },
            ...(selectedModel ? { model: selectedModel } : {}),
            permissions: [{ action: '*', resource: '*', effect: 'allow' }],
          }),
        });
        const createdData = isRecord(created) && isRecord(created.data) ? created.data : null;
        if (typeof createdData?.id !== 'string' || !createdData.id) {
          throw new Error('OpenCode Server create-session response did not include a session id.');
        }
        this.sessionId = createdData.id;
      }

      this.emitFrame({ type: 'step_start', sessionID: this.sessionId, part: {} });
      await this.request(`/api/session/${encodeURIComponent(this.sessionId)}/prompt`, {
        method: 'POST',
        body: JSON.stringify({ text: this.options.prompt }),
      });
      await eventLoop;
    } catch (error) {
      if (!this.closed && !this.abortController.signal.aborted) this.fail(error);
    }
  }

  private async consumeEventStream(stream: ReadableStream<Uint8Array>): Promise<void> {
    const reader = stream.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    while (!this.closed) {
      const { done, value } = await reader.read();
      buffer += decoder.decode(value, { stream: !done });
      let boundary = buffer.search(/\r?\n\r?\n/u);
      while (boundary >= 0) {
        const block = buffer.slice(0, boundary);
        const separator = /^\r\n\r\n/u.test(buffer.slice(boundary)) ? 4 : 2;
        buffer = buffer.slice(boundary + separator);
        this.handleSseBlock(block);
        boundary = buffer.search(/\r?\n\r?\n/u);
      }
      if (done) break;
    }
    if (!this.closed) throw new Error('OpenCode Server event stream disconnected before completion.');
  }

  private handleSseBlock(block: string): void {
    const data = block.split(/\r?\n/u)
      .filter((line) => line.startsWith('data:'))
      .map((line) => line.slice(5).trimStart())
      .join('\n');
    if (!data) return;
    let event: unknown;
    try {
      event = JSON.parse(data);
    } catch {
      throw new Error('OpenCode Server sent an invalid SSE JSON event.');
    }
    if (!isRecord(event) || !isRecord(event.data)) return;
    const payload = event.data;
    if (payload.sessionID !== this.sessionId) return;
    this.handleSessionEvent(event.type, payload);
  }

  private handleSessionEvent(type: unknown, data: JsonObject): void {
    const sessionID = this.sessionId;
    if (!sessionID || typeof type !== 'string') return;
    if (type === 'session.text.delta' && typeof data.delta === 'string') {
      this.emitFrame({ type: 'text', sessionID, part: { text: data.delta } });
      return;
    }
    if (type === 'session.reasoning.delta' && typeof data.delta === 'string') {
      this.emitFrame({ type: 'reasoning', sessionID, part: { text: data.delta } });
      return;
    }
    if (type === 'session.tool.input.started' && typeof data.id === 'string' && typeof data.name === 'string') {
      this.toolNames.set(data.id, data.name);
      return;
    }
    if (type === 'session.tool.called' && typeof data.id === 'string') {
      const name = this.toolNames.get(data.id) ?? 'tool';
      this.emitFrame({
        type: 'tool_use',
        sessionID,
        part: { tool: name, callID: data.id, state: { status: 'running', input: data.input ?? {} } },
      });
      return;
    }
    if (type === 'session.tool.success' && typeof data.id === 'string') {
      const name = this.toolNames.get(data.id) ?? 'tool';
      this.emitFrame({
        type: 'tool_use',
        sessionID,
        part: {
          tool: name,
          callID: data.id,
          state: { status: 'completed', output: toolContentText(data.content), metadata: data.metadata ?? {} },
        },
      });
      return;
    }
    if (type === 'session.tool.failed' && typeof data.id === 'string') {
      const name = this.toolNames.get(data.id) ?? 'tool';
      this.emitFrame({
        type: 'tool_use',
        sessionID,
        part: {
          tool: name,
          callID: data.id,
          state: { status: 'error', error: errorMessage(data.error, 'OpenCode tool failed') },
        },
      });
      return;
    }
    if (type === 'permission.asked' && typeof data.id === 'string') {
      void this.request(`/api/session/${encodeURIComponent(sessionID)}/permission/${encodeURIComponent(data.id)}/reply`, {
        method: 'POST',
        body: JSON.stringify({ decision: 'once' }),
      }).catch((error) => this.fail(error));
      return;
    }
    if (type === 'session.step.ended') {
      this.emitFrame({
        type: 'step_finish',
        sessionID,
        part: { tokens: data.tokens ?? {}, cost: data.cost },
      });
      return;
    }
    if (type === 'session.execution.failed') {
      this.emitFrame({ type: 'error', sessionID, error: data.error ?? { message: 'OpenCode execution failed' } });
      this.finish(1, null);
      return;
    }
    if (type === 'session.execution.interrupted') {
      this.finish(null, 'SIGTERM');
      return;
    }
    if (type === 'session.execution.succeeded') {
      this.finish(0, null);
    }
  }
}

/**
 * Child-process-shaped adapter for the existing run lifecycle. It performs no
 * process spawn: stdout carries translated OpenCode Server events, kill()
 * maps to the server interrupt endpoint, and close mirrors transport terminal
 * state so the daemon's normal persistence/finalization path remains shared.
 */
export function createOpenCodeServerTransport(
  options: OpenCodeServerTransportOptions,
): ChildProcessWithoutNullStreams {
  return new OpenCodeServerTransport(options) as unknown as ChildProcessWithoutNullStreams;
}
