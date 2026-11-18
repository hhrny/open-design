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

  it('does not build a per-turn CLI invocation', () => {
    expect(opencodeServerAgentDef.buildArgs()).toEqual([]);
  });

  it('is registered as a capture-style native server runtime', () => {
    expect(getAgentDef('opencode-server')).toBe(opencodeServerAgentDef);
    expect(opencodeServerAgentDef).not.toHaveProperty('promptViaStdin');
    expect(opencodeServerAgentDef).not.toHaveProperty('resumesSessionViaCli');
    expect(opencodeServerAgentDef.resumesSessionViaServer).toBe(true);
    expect(opencodeServerAgentDef.capturesSessionIdFromStream).toBe(true);
    expect(opencodeServerAgentDef.eventParser).toBe('opencode');
  });
});
