import http from 'node:http';
import { once } from 'node:events';
import { describe, expect, it } from 'vitest';

import { createOpenCodeServerTransport } from '../../src/runtimes/opencode-server-transport.js';

async function readJson(request: http.IncomingMessage): Promise<unknown> {
  let raw = '';
  request.setEncoding('utf8');
  for await (const chunk of request) raw += chunk;
  return raw ? JSON.parse(raw) : null;
}

async function listen(server: http.Server): Promise<number> {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('missing test server address');
  return address.port;
}

describe('OpenCode Server native transport', () => {
  it('creates a session, prompts over HTTP, and streams native SSE without a CLI', async () => {
    const sessionID = 'ses_native_test';
    const requests: Array<{ method: string; url: string; body: unknown }> = [];
    let eventResponse: http.ServerResponse | null = null;
    const server = http.createServer(async (request, response) => {
      const authorization = request.headers.authorization;
      if (authorization !== `Basic ${Buffer.from('opencode:test-secret').toString('base64')}`) {
        response.writeHead(401).end();
        return;
      }
      if (request.url === '/api/event') {
        eventResponse = response;
        response.writeHead(200, { 'content-type': 'text/event-stream' });
        response.flushHeaders();
        return;
      }
      const body = await readJson(request);
      requests.push({ method: request.method ?? '', url: request.url ?? '', body });
      response.setHeader('content-type', 'application/json');
      if (request.method === 'POST' && request.url === '/api/session') {
        response.end(JSON.stringify({ data: { id: sessionID } }));
        return;
      }
      if (request.method === 'POST' && request.url === `/api/session/${sessionID}/prompt`) {
        response.end(JSON.stringify({ data: { id: 'msg_test' } }));
        const emit = (value: unknown) => eventResponse?.write(`data: ${JSON.stringify(value)}\n\n`);
        setImmediate(() => {
          emit({ type: 'session.reasoning.delta', data: { sessionID, delta: 'thinking' } });
          emit({ type: 'session.text.delta', data: { sessionID, delta: 'ok' } });
          emit({
            type: 'session.step.ended',
            data: {
              sessionID,
              tokens: { input: 2, output: 1, reasoning: 1, cache: { read: 0, write: 0 } },
              cost: 0.01,
            },
          });
          emit({ type: 'session.execution.succeeded', data: { sessionID } });
        });
        return;
      }
      response.writeHead(404).end(JSON.stringify({ error: 'not found' }));
    });
    const port = await listen(server);
    try {
      const child = createOpenCodeServerTransport({
        cwd: '/workspace/project',
        env: {
          OPEN_DESIGN_OPENCODE_SERVER_URL: `http://127.0.0.1:${port}`,
          OPENCODE_PASSWORD: 'test-secret',
        },
        model: 'openai/gpt-5',
        prompt: 'Reply with only: ok',
        reasoning: 'high',
      });
      child.stdout.setEncoding('utf8');
      let stdout = '';
      child.stdout.on('data', (chunk) => { stdout += chunk; });
      const [code, signal] = await once(child, 'close');

      expect({ code, signal }).toEqual({ code: 0, signal: null });
      expect(requests).toEqual([
        {
          method: 'POST',
          url: '/api/session',
          body: {
            title: 'Open Design',
            location: { directory: '/workspace/project' },
            model: { providerID: 'openai', id: 'gpt-5', variant: 'high' },
            permissions: [{ action: '*', resource: '*', effect: 'allow' }],
          },
        },
        {
          method: 'POST',
          url: `/api/session/${sessionID}/prompt`,
          body: { text: 'Reply with only: ok' },
        },
      ]);
      const frames = stdout.trim().split('\n').map((line) => JSON.parse(line));
      expect(frames).toEqual([
        { type: 'step_start', sessionID, part: {} },
        { type: 'reasoning', sessionID, part: { text: 'thinking' } },
        { type: 'text', sessionID, part: { text: 'ok' } },
        {
          type: 'step_finish',
          sessionID,
          part: {
            tokens: { input: 2, output: 1, reasoning: 1, cache: { read: 0, write: 0 } },
            cost: 0.01,
          },
        },
      ]);
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('resumes a server session and maps kill to the interrupt endpoint', async () => {
    const sessionID = 'ses_resume_test';
    const urls: string[] = [];
    let eventResponse: http.ServerResponse | null = null;
    const server = http.createServer(async (request, response) => {
      urls.push(`${request.method} ${request.url}`);
      if (request.url === '/api/event') {
        eventResponse = response;
        response.writeHead(200, { 'content-type': 'text/event-stream' });
        response.flushHeaders();
        return;
      }
      if (request.method === 'GET' && request.url === `/api/session/${sessionID}`) {
        response.setHeader('content-type', 'application/json');
        response.end(JSON.stringify({ data: { id: sessionID } }));
        return;
      }
      if (request.method === 'POST' && request.url === `/api/session/${sessionID}/prompt`) {
        await readJson(request);
        response.setHeader('content-type', 'application/json');
        response.end(JSON.stringify({ data: { id: 'msg_resume' } }));
        return;
      }
      if (request.method === 'POST' && request.url === `/api/session/${sessionID}/interrupt`) {
        response.setHeader('content-type', 'application/json');
        response.end(JSON.stringify({ interrupted: true }));
        return;
      }
      response.writeHead(404).end();
    });
    const port = await listen(server);
    try {
      const child = createOpenCodeServerTransport({
        cwd: '/ignored-on-resume',
        env: { OPEN_DESIGN_OPENCODE_SERVER_URL: `http://127.0.0.1:${port}` },
        prompt: 'continue',
        resumeSessionId: sessionID,
      });
      for (let index = 0; index < 100 && !urls.includes(`POST /api/session/${sessionID}/prompt`); index += 1) {
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      const close = once(child, 'close');
      expect(child.kill('SIGTERM')).toBe(true);
      await close;
      for (let index = 0; index < 100 && !urls.includes(`POST /api/session/${sessionID}/interrupt`); index += 1) {
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      expect(urls).not.toContain('POST /api/session');
      expect(urls).toContain(`GET /api/session/${sessionID}`);
      expect(urls).toContain(`POST /api/session/${sessionID}/prompt`);
      expect(urls).toContain(`POST /api/session/${sessionID}/interrupt`);
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
