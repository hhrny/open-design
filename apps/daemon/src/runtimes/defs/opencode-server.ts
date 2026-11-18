import type { RuntimeAgentDef, RuntimeEnv } from '../types.js';
import {
  OPENCODE_FALLBACK_MODELS,
} from './opencode.js';

export const OPEN_DESIGN_OPENCODE_SERVER_URL = 'OPEN_DESIGN_OPENCODE_SERVER_URL';
export const OPENCODE_SERVER_CLIENT_PASSWORD = 'OPENCODE_PASSWORD';
export const DEFAULT_OPENCODE_SERVER_URL = 'http://127.0.0.1:4096';

export function resolveOpenCodeServerUrl(
  env: RuntimeEnv = process.env,
): string {
  const raw = env[OPEN_DESIGN_OPENCODE_SERVER_URL]?.trim()
    || DEFAULT_OPENCODE_SERVER_URL;
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error(`${OPEN_DESIGN_OPENCODE_SERVER_URL} must be a valid HTTP(S) URL.`);
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`${OPEN_DESIGN_OPENCODE_SERVER_URL} must use http:// or https://.`);
  }
  if (parsed.username || parsed.password) {
    throw new Error(
      `${OPEN_DESIGN_OPENCODE_SERVER_URL} must not contain credentials; configure ${OPENCODE_SERVER_CLIENT_PASSWORD} separately.`,
    );
  }
  if (parsed.search || parsed.hash) {
    throw new Error(`${OPEN_DESIGN_OPENCODE_SERVER_URL} must not contain a query or fragment.`);
  }
  parsed.pathname = parsed.pathname.replace(/\/+$/, '') || '/';
  return parsed.toString().replace(/\/$/, '');
}

function authorizationHeader(env: RuntimeEnv): string | null {
  const password = env[OPENCODE_SERVER_CLIENT_PASSWORD]?.trim();
  if (!password) return null;
  return `Basic ${Buffer.from(`opencode:${password}`, 'utf8').toString('base64')}`;
}

async function fetchOpenCodeServerModels(
  _resolvedBin: string,
  env: RuntimeEnv,
) {
  const serverUrl = resolveOpenCodeServerUrl(env);
  const authorization = authorizationHeader(env);
  const response = await fetch(`${serverUrl}/api/model`, {
    headers: {
      accept: 'application/json',
      ...(authorization ? { authorization } : {}),
    },
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) throw new Error(`OpenCode Server model request failed (${response.status}).`);
  const body = await response.json() as {
    data?: Array<{
      enabled?: unknown;
      id?: unknown;
      name?: unknown;
      providerID?: unknown;
      variants?: Array<{ id?: unknown }>;
    }>;
  };
  if (!Array.isArray(body.data)) return null;
  const models = body.data.flatMap((entry) => {
    if (
      entry.enabled === false
      || typeof entry.providerID !== 'string'
      || typeof entry.id !== 'string'
    ) return [];
    const id = `${entry.providerID}/${entry.id}`;
    const variants = Array.isArray(entry.variants)
      ? entry.variants.flatMap((variant) => (
          typeof variant.id === 'string' && variant.id
            ? [{ id: variant.id, label: variant.id }]
            : []
        ))
      : [];
    return [{
      id,
      label: typeof entry.name === 'string' && entry.name ? entry.name : id,
      ...(variants.length > 0 ? { reasoningOptions: variants } : {}),
    }];
  });
  return models.length > 0
    ? [OPENCODE_FALLBACK_MODELS[0]!, ...models]
    : null;
}

/**
 * OpenCode v2 native server transport. The executable is used only to start a
 * managed local `opencode serve`; chat and model traffic use HTTP/SSE directly.
 */
export const opencodeServerAgentDef = {
  id: 'opencode-server',
  name: 'OpenCode Server',
  bin: 'opencode-cli',
  fallbackBins: ['opencode'],
  versionArgs: ['--version'],
  fetchModels: fetchOpenCodeServerModels,
  fallbackModels: OPENCODE_FALLBACK_MODELS,
  buildArgs: () => [],
  resumesSessionViaServer: true,
  capturesSessionIdFromStream: true,
  streamFormat: 'json-event-stream',
  eventParser: 'opencode',
  supportsCustomModel: true,
  installUrl: 'https://opencode.ai/docs/cli/',
  docsUrl: 'https://opencode.ai/docs/cli/web/',
} satisfies RuntimeAgentDef;
