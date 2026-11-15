import { describe, expect, it } from 'vitest';

import {
  DEFAULT_OPENCODE_SERVER_URL,
  opencodeServerAgentDef,
  resolveOpenCodeServerUrl,
} from '../../src/runtimes/defs/opencode-server.js';
import { getAgentDef } from '../../src/runtimes/registry.js';

describe('opencode-server runtime', () => {
  it('defaults to the local OpenCode v2 server and normalizes trailing slashes', () => {
    expect(resolveOpenCodeServerUrl({})).toBe(DEFAULT_OPENCODE_SERVER_URL);
    expect(resolveOpenCodeServerUrl({
      OPEN_DESIGN_OPENCODE_SERVER_URL: ' https://agent.example.test:8443/api/// ',
    })).toBe('https://agent.example.test:8443/api');
  });

  it.each([
    'ftp://agent.example.test',
    'https://user:secret@agent.example.test',
    'https://agent.example.test?token=secret',
    'https://agent.example.test/#session',
    'not a url',
  ])('rejects an unsafe or invalid server URL: %s', (serverUrl) => {
    expect(() => resolveOpenCodeServerUrl({
      OPEN_DESIGN_OPENCODE_SERVER_URL: serverUrl,
    })).toThrow(/OPEN_DESIGN_OPENCODE_SERVER_URL/u);
  });

  it('builds a network-client invocation with resume and model variant', () => {
    const args = opencodeServerAgentDef.buildArgs(
      'prompt travels over stdin',
      [],
      [],
      { model: 'openai/gpt-5', reasoning: 'high' },
      {
        configuredEnv: {
          OPEN_DESIGN_OPENCODE_SERVER_URL: 'https://agent.example.test/',
        },
        resumeSessionId: 'ses_remote_123',
      },
    );

    expect(args).toEqual([
      'run',
      '--server',
      'https://agent.example.test',
      '--format',
      'json',
      '--auto',
      '-s',
      'ses_remote_123',
      '-m',
      'openai/gpt-5#high',
    ]);
  });

  it('does not invent a model flag for the default selection', () => {
    const args = opencodeServerAgentDef.buildArgs('', [], [], {
      model: 'default',
      reasoning: 'high',
    }, {});
    expect(args).not.toContain('-m');
  });

  it('is registered as a capture-style OpenCode event-stream runtime', () => {
    expect(getAgentDef('opencode-server')).toBe(opencodeServerAgentDef);
    expect(opencodeServerAgentDef.promptViaStdin).toBe(true);
    expect(opencodeServerAgentDef.resumesSessionViaCli).toBe(true);
    expect(opencodeServerAgentDef.capturesSessionIdFromStream).toBe(true);
    expect(opencodeServerAgentDef.eventParser).toBe('opencode');
  });
});
