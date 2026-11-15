import { createServer as createHttpServer, type Server } from 'node:http';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import {
  ensureManagedOpenCodeServer,
  managedOpenCodeServerStatus,
  stopManagedOpenCodeServer,
} from '../../src/runtimes/opencode-server-manager.js';

async function freePort(): Promise<number> {
  const server = createHttpServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const port = address && typeof address === 'object' ? address.port : 0;
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
  return port;
}

async function fakeOpenCode(dir: string): Promise<string> {
  const source = `
const http = require('node:http');
const args = process.argv.slice(2);
if (args[0] !== 'serve') process.exit(2);
const host = args[args.indexOf('--hostname') + 1];
const port = Number(args[args.indexOf('--port') + 1]);
const expected = 'Basic ' + Buffer.from('opencode:' + process.env.OPENCODE_SERVER_PASSWORD).toString('base64');
const server = http.createServer((request, response) => {
  if (request.headers.authorization !== expected) {
    response.writeHead(401).end('unauthorized');
    return;
  }
  if (request.url !== '/api/info') {
    response.writeHead(404).end('missing');
    return;
  }
  response.setHeader('content-type', 'application/json');
  response.end(JSON.stringify({ version: 'test', pid: process.pid }));
});
server.listen(port, host);
process.on('SIGTERM', () => server.close(() => process.exit(0)));
`;
  if (process.platform === 'win32') {
    const runner = path.join(dir, 'fake-opencode.cjs');
    const command = path.join(dir, 'opencode.cmd');
    await fs.writeFile(runner, source);
    await fs.writeFile(command, `@echo off\r\nnode "${runner}" %*\r\n`);
    return command;
  }
  const command = path.join(dir, 'opencode');
  await fs.writeFile(command, `#!/usr/bin/env node\n${source}`);
  await fs.chmod(command, 0o755);
  return command;
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
}

afterEach(async () => {
  await stopManagedOpenCodeServer();
});

describe('OpenCode Server manager', () => {
  it('starts an authenticated loopback server and stops the owned child', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'od-opencode-manager-'));
    const port = await freePort();
    try {
      const bin = await fakeOpenCode(dir);
      const effective = await ensureManagedOpenCodeServer(bin, {
        OPEN_DESIGN_OPENCODE_SERVER_URL: `http://127.0.0.1:${port}`,
      });

      expect(effective.OPENCODE_PASSWORD).toMatch(/^[a-f0-9]{64}$/u);
      expect(managedOpenCodeServerStatus()).toMatchObject({
        owned: true,
        url: `http://127.0.0.1:${port}`,
      });
      const authorization = `Basic ${Buffer.from(
        `opencode:${effective.OPENCODE_PASSWORD}`,
      ).toString('base64')}`;
      await expect(fetch(`http://127.0.0.1:${port}/api/info`, {
        headers: { authorization },
      }).then((response) => response.status)).resolves.toBe(200);

      await stopManagedOpenCodeServer();
      expect(managedOpenCodeServerStatus()).toEqual({
        owned: false,
        pid: null,
        url: null,
      });
      await expect(fetch(`http://127.0.0.1:${port}/api/info`)).rejects.toThrow();
    } finally {
      await fs.rm(dir, { force: true, recursive: true });
    }
  });

  it('reuses but never stops an already-running compatible server', async () => {
    const password = 'existing-secret';
    const expected = `Basic ${Buffer.from(`opencode:${password}`).toString('base64')}`;
    const server = createHttpServer((request, response) => {
      if (request.headers.authorization !== expected) {
        response.writeHead(401).end();
        return;
      }
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify({ version: 'existing' }));
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    const port = address && typeof address === 'object' ? address.port : 0;
    try {
      await ensureManagedOpenCodeServer('/unused/opencode', {
        OPEN_DESIGN_OPENCODE_SERVER_URL: `http://127.0.0.1:${port}`,
        OPENCODE_PASSWORD: password,
      });
      expect(managedOpenCodeServerStatus().owned).toBe(false);
      await stopManagedOpenCodeServer();
      expect(server.listening).toBe(true);
    } finally {
      await closeServer(server);
    }
  });

  it('leaves remote and HTTPS endpoints externally managed', async () => {
    const effective = await ensureManagedOpenCodeServer('/unused/opencode', {
      OPEN_DESIGN_OPENCODE_SERVER_URL: 'https://agents.example.test',
      OPENCODE_PASSWORD: 'remote-secret',
    });
    expect(effective).toEqual({
      OPEN_DESIGN_OPENCODE_SERVER_URL: 'https://agents.example.test',
      OPENCODE_PASSWORD: 'remote-secret',
    });
    expect(managedOpenCodeServerStatus().owned).toBe(false);
  });
});
