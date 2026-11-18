import type { Server } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';

type StartedServer = {
  url: string;
  server: Server;
  shutdown?: () => Promise<void> | void;
};

const originalDataDir = process.env.OD_DATA_DIR;
const originalWorkspaceContextSource = process.env.OD_WORKSPACE_CONTEXT_SOURCE;
let dataDir: string | null = null;
let started: StartedServer | null = null;

afterEach(async () => {
  const current = started;
  started = null;
  if (current) {
    await Promise.resolve(current.shutdown?.());
    current.server.closeAllConnections?.();
    current.server.closeIdleConnections?.();
    if (current.server.listening) {
      await new Promise<void>((resolve) => current.server.close(() => resolve()));
    }
  }
  const { closeDatabase } = await import('../src/db.js');
  closeDatabase();
  if (dataDir) await rm(dataDir, { recursive: true, force: true });
  dataDir = null;
  if (originalDataDir === undefined) delete process.env.OD_DATA_DIR;
  else process.env.OD_DATA_DIR = originalDataDir;
  if (originalWorkspaceContextSource === undefined) {
    delete process.env.OD_WORKSPACE_CONTEXT_SOURCE;
  } else {
    process.env.OD_WORKSPACE_CONTEXT_SOURCE = originalWorkspaceContextSource;
  }
  vi.resetModules();
}, 30_000);

it('removes design-system, account-login, community, and media-provider capabilities', async () => {
  dataDir = await mkdtemp(join(tmpdir(), 'od-design-systems-removed-'));
  process.env.OD_DATA_DIR = dataDir;
  delete process.env.OD_WORKSPACE_CONTEXT_SOURCE;
  vi.resetModules();
  const { startServer } = await import('../src/server.js');
  started = await startServer({ port: 0, returnServer: true }) as StartedServer;

  for (const path of [
    '/api/design-systems',
    '/api/design-systems/example',
    '/api/workspace/design-systems/team',
    '/api/brands/example',
  ]) {
    const response = await fetch(`${started.url}${path}`);
    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toMatchObject({
      error: {
        code: 'FEATURE_REMOVED',
        message: 'Design Systems has been removed.',
      },
    });
  }

  for (const [method, path] of [
    ['GET', '/api/integrations/vela/status'],
    ['POST', '/api/integrations/vela/login'],
    ['POST', '/api/integrations/vela/login/cancel'],
    ['POST', '/api/integrations/vela/logout'],
    ['POST', '/api/workspace/invite'],
    ['POST', '/api/workspace/invite/continue'],
  ] as const) {
    const response = await fetch(`${started.url}${path}`, { method });
    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toMatchObject({
      error: {
        code: 'FEATURE_REMOVED',
        message: 'Account login has been removed.',
      },
    });
  }

  const communityResponse = await fetch(`${started.url}/api/community/discord`);
  expect(communityResponse.status).toBe(404);
  await expect(communityResponse.json()).resolves.toMatchObject({
    error: {
      code: 'FEATURE_REMOVED',
      message: 'Community has been removed.',
    },
  });

  for (const [method, path] of [
    ['GET', '/api/media/models'],
    ['GET', '/api/media/config'],
    ['PUT', '/api/media/config'],
    ['POST', '/api/projects/example/media/generate'],
    ['POST', '/api/tools/media/generate'],
  ] as const) {
    const response = await fetch(`${started.url}${path}`, { method });
    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toMatchObject({
      error: {
        code: 'FEATURE_REMOVED',
        message: 'Media generation providers have been removed.',
      },
    });
  }

  const agentsResponse = await fetch(`${started.url}/api/agents`);
  expect(agentsResponse.status).toBe(200);
  const payload = await agentsResponse.json() as { agents?: Array<{ id?: string }> };
  expect(payload.agents?.some((agent) => agent.id === 'amr')).toBe(false);
}, 120_000);
