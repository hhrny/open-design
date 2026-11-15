import { execAgentFile } from '../invocation.js';
import type { RuntimeAgentDef, RuntimeEnv } from '../types.js';
import {
  OPENCODE_FALLBACK_MODELS,
  parseOpenCodeModels,
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

function selectedServerModel(
  model: string | null | undefined,
  reasoning: string | null | undefined,
): string | null {
  const trimmedModel = typeof model === 'string' ? model.trim() : '';
  if (!trimmedModel || trimmedModel === 'default') return null;
  const trimmedReasoning = typeof reasoning === 'string' ? reasoning.trim() : '';
  if (!trimmedReasoning || trimmedReasoning === 'default' || trimmedModel.includes('#')) {
    return trimmedModel;
  }
  return `${trimmedModel}#${trimmedReasoning}`;
}

async function fetchOpenCodeServerModels(
  resolvedBin: string,
  env: RuntimeEnv,
) {
  const serverUrl = resolveOpenCodeServerUrl(env);
  const { stdout } = await execAgentFile(
    resolvedBin,
    ['models', '--server', serverUrl],
    {
      env,
      timeout: 15_000,
      maxBuffer: 8 * 1024 * 1024,
    },
  );
  return parseOpenCodeModels(String(stdout));
}

/**
 * OpenCode v2 network client. The local executable is only the transport
 * client; the configured server owns sessions, providers, tools and files.
 */
export const opencodeServerAgentDef = {
  id: 'opencode-server',
  name: 'OpenCode Server',
  bin: 'opencode-cli',
  fallbackBins: ['opencode'],
  versionArgs: ['--version'],
  fetchModels: fetchOpenCodeServerModels,
  fallbackModels: OPENCODE_FALLBACK_MODELS,
  buildArgs: (_prompt, _imagePaths, _extra, options = {}, runtimeContext = {}) => {
    const serverUrl = resolveOpenCodeServerUrl({
      ...process.env,
      ...(runtimeContext.configuredEnv ?? {}),
    });
    const args = ['run', '--server', serverUrl, '--format', 'json', '--auto'];
    const resumeSessionId = runtimeContext.resumeSessionId?.trim();
    if (resumeSessionId) args.push('-s', resumeSessionId);
    const model = selectedServerModel(options.model, options.reasoning);
    if (model) args.push('-m', model);
    return args;
  },
  promptViaStdin: true,
  resumesSessionViaCli: true,
  capturesSessionIdFromStream: true,
  streamFormat: 'json-event-stream',
  eventParser: 'opencode',
  supportsCustomModel: true,
  installUrl: 'https://opencode.ai/docs/cli/',
  docsUrl: 'https://opencode.ai/docs/cli/web/',
} satisfies RuntimeAgentDef;
