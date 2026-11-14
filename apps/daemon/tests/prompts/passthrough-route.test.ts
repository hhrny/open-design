import type http from 'node:http';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { delimiter, join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const USER_INPUT = '  保留前后空格\n修改我选中的文件  ';

describe('prompt passthrough route', () => {
  let server: http.Server;
  let baseUrl = '';
  let captureDir = '';
  let capturePath = '';
  const originalPath = process.env.PATH;
  const originalCapture = process.env.OD_CAPTURE_PROMPT_PATH;
  const originalPromptMode = process.env.OD_PROMPT_MODE;
  const originalRollout = process.env.OD_NEXT_STRATEGY_ROLLOUT;

  beforeAll(async () => {
    captureDir = await mkdtemp(join(tmpdir(), 'od-passthrough-route-'));
    capturePath = join(captureDir, 'prompt.txt');
    const fakeAgentPath = join(captureDir, 'opencode');
    await writeFile(
      fakeAgentPath,
      `#!/usr/bin/env node
const fs = require('node:fs');
let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => { input += chunk; });
process.stdin.on('end', () => {
  fs.writeFileSync(process.env.OD_CAPTURE_PROMPT_PATH, input, 'utf8');
  console.log(JSON.stringify({ type: 'text', part: { text: 'ok' } }));
});
`,
      'utf8',
    );
    await chmod(fakeAgentPath, 0o755);
    process.env.PATH = `${captureDir}${delimiter}${originalPath ?? ''}`;
    process.env.OD_CAPTURE_PROMPT_PATH = capturePath;
    process.env.OD_PROMPT_MODE = 'passthrough';
    // A conflicting rollout flag must not be able to restore OD Next prompts.
    process.env.OD_NEXT_STRATEGY_ROLLOUT = 'active';

    const { startServer } = await import('../../src/server.js');
    const started = await startServer({ port: 0, returnServer: true }) as {
      url: string;
      server: http.Server;
    };
    baseUrl = started.url;
    server = started.server;
  }, 60_000);

  afterAll(async () => {
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
    if (captureDir) await rm(captureDir, { recursive: true, force: true });
    if (originalPath === undefined) delete process.env.PATH;
    else process.env.PATH = originalPath;
    if (originalCapture === undefined) delete process.env.OD_CAPTURE_PROMPT_PATH;
    else process.env.OD_CAPTURE_PROMPT_PATH = originalCapture;
    if (originalPromptMode === undefined) delete process.env.OD_PROMPT_MODE;
    else process.env.OD_PROMPT_MODE = originalPromptMode;
    if (originalRollout === undefined) delete process.env.OD_NEXT_STRATEGY_ROLLOUT;
    else process.env.OD_NEXT_STRATEGY_ROLLOUT = originalRollout;
  });

  it('delivers only allowlisted runtime facts, history, and the exact current input', async () => {
    const response = await fetch(`${baseUrl}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        agentId: 'opencode',
        conversationId: 'passthrough-route-test',
        message: `## user\n旧请求\n\n## assistant\n旧回复\n\n## user\n${USER_INPUT}`,
        currentPrompt: USER_INPUT,
        priorTranscript: '## user\n旧请求\n\n## assistant\n旧回复',
        systemPrompt: 'CLIENT_SYSTEM_SENTINEL',
        research: { mode: 'deep' },
        context: {
          skillIds: ['deliverable-discovery'],
          pluginIds: ['open-design'],
          workspaceItems: [
            { id: 'selected-file', kind: 'file', label: 'target.ts', path: 'src/target.ts' },
          ],
        },
      }),
    });
    expect(response.ok).toBe(true);
    await response.text();

    const prompt = await readFile(capturePath, 'utf8');
    expect(prompt).toContain('"working_directory"');
    expect(prompt).toContain('"selected_files"');
    expect(prompt).toContain('src/target.ts');
    expect(prompt).toContain('<conversation-history>');
    expect(prompt).toContain('旧请求');
    expect(prompt.endsWith(USER_INPUT)).toBe(true);
    expect(prompt).not.toContain('deliverable-discovery');
    expect(prompt).not.toContain('CLIENT_SYSTEM_SENTINEL');
    expect(prompt).not.toContain('OpenDesign');
    expect(prompt).not.toContain('OD Next');
    expect(prompt).not.toContain('# Instructions');
    expect(prompt).not.toContain('od-done');
    expect(prompt).not.toContain('od-next');
    expect(prompt).not.toContain('question-form');
    expect(prompt).not.toContain('TodoWrite');

    const rolloutResponse = await fetch(`${baseUrl}/api/strategies/od-next/rollout`);
    expect(rolloutResponse.ok).toBe(true);
    await expect(rolloutResponse.json()).resolves.toMatchObject({
      status: { requestedMode: 'off', effectiveMode: 'off' },
    });
  }, 60_000);
});
