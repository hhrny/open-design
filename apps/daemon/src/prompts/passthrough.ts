export type PromptMode = 'passthrough' | 'open-design';

export interface PassthroughWorkspaceItem {
  kind: string;
  label: string;
  path?: string;
  absolutePath?: string;
  url?: string;
  title?: string;
  tabId?: string;
}

export interface PassthroughPromptInput {
  userInput: string;
  priorTranscript?: string | null;
  workingDirectory?: string | null;
  selectedFiles?: readonly string[] | null;
  linkedDirectories?: readonly string[] | null;
  workspaceItems?: readonly PassthroughWorkspaceItem[] | null;
  selectedAnnotations?: readonly unknown[] | null;
  imageReferences?: readonly string[] | null;
}

function nonEmptyStrings(values: readonly string[] | null | undefined): string[] {
  const result: string[] = [];
  const seen = new Set<string>();
  for (const value of values ?? []) {
    if (typeof value !== 'string') continue;
    const normalized = value.trim();
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    result.push(normalized);
  }
  return result;
}

function cleanWorkspaceItems(
  items: readonly PassthroughWorkspaceItem[] | null | undefined,
): PassthroughWorkspaceItem[] {
  const result: PassthroughWorkspaceItem[] = [];
  const seen = new Set<string>();
  for (const item of items ?? []) {
    if (!item || typeof item !== 'object') continue;
    const kind = typeof item.kind === 'string' ? item.kind.trim() : '';
    const label = typeof item.label === 'string' ? item.label.trim() : '';
    if (!kind || !label) continue;
    const cleaned: PassthroughWorkspaceItem = { kind, label };
    for (const key of ['path', 'absolutePath', 'url', 'title', 'tabId'] as const) {
      const value = item[key];
      if (typeof value === 'string' && value.trim()) cleaned[key] = value.trim();
    }
    const identity = JSON.stringify(cleaned);
    if (seen.has(identity)) continue;
    seen.add(identity);
    result.push(cleaned);
  }
  return result;
}

/**
 * The fork defaults to transparent prompt delivery. The old prompt stack is
 * available only through an explicit process-level rollback switch.
 */
export function readPromptMode(env: NodeJS.ProcessEnv = process.env): PromptMode {
  return env.OD_PROMPT_MODE?.trim().toLowerCase() === 'open-design'
    ? 'open-design'
    : 'passthrough';
}

export function isPassthroughPromptMode(env: NodeJS.ProcessEnv = process.env): boolean {
  return readPromptMode(env) === 'passthrough';
}

/** Remove the web client's synthetic warning while preserving real turns. */
export function stripSyntheticTranscriptPreamble(transcript: string | null | undefined): string {
  if (typeof transcript !== 'string' || transcript.length === 0) return '';
  if (!transcript.startsWith('## context warning\n')) return transcript;
  const firstTurn = transcript.search(/(?:^|\n\n)## (?:user|assistant)\n/);
  if (firstTurn < 0) return '';
  return transcript.slice(firstTurn).replace(/^\n+/, '');
}

/**
 * Compose only runtime facts, genuine conversation history, and the user's
 * exact current input. No Open Design behavior or output protocol lives here.
 */
export function composePassthroughPrompt(input: PassthroughPromptInput): {
  composedPrompt: string;
  clientInstructionPrompt: '';
  instructionPrompt: '';
} {
  const workingDirectory = typeof input.workingDirectory === 'string'
    ? input.workingDirectory.trim()
    : '';
  const selectedFiles = nonEmptyStrings(input.selectedFiles);
  const linkedDirectories = nonEmptyStrings(input.linkedDirectories);
  const workspaceItems = cleanWorkspaceItems(input.workspaceItems);
  const imageReferences = nonEmptyStrings(input.imageReferences);
  const selectedAnnotations = Array.isArray(input.selectedAnnotations)
    ? input.selectedAnnotations.filter((value) => value !== null && value !== undefined)
    : [];

  const runtimeContext: Record<string, unknown> = {};
  if (workingDirectory) runtimeContext.working_directory = workingDirectory;
  if (selectedFiles.length > 0) runtimeContext.selected_files = selectedFiles;
  if (linkedDirectories.length > 0) runtimeContext.linked_directories = linkedDirectories;
  if (workspaceItems.length > 0) runtimeContext.selected_context = workspaceItems;
  if (selectedAnnotations.length > 0) runtimeContext.selected_annotations = selectedAnnotations;
  if (imageReferences.length > 0) runtimeContext.image_references = imageReferences;

  const parts: string[] = [];
  if (Object.keys(runtimeContext).length > 0) {
    parts.push(`<runtime-context>\n${JSON.stringify(runtimeContext, null, 2)}\n</runtime-context>`);
  }
  const priorTranscript = stripSyntheticTranscriptPreamble(input.priorTranscript);
  if (priorTranscript) {
    parts.push(`<conversation-history>\n${priorTranscript}\n</conversation-history>`);
  }
  if (input.userInput.length > 0) parts.push(input.userInput);

  return {
    composedPrompt: parts.join('\n\n'),
    clientInstructionPrompt: '',
    instructionPrompt: '',
  };
}

export function resolvePassthroughTurn(input: {
  message: unknown;
  currentPrompt: unknown;
  priorTranscript: unknown;
  skipTranscript: boolean;
}): { userInput: string; priorTranscript: string } {
  if (typeof input.currentPrompt === 'string') {
    return {
      userInput: input.currentPrompt,
      priorTranscript: input.skipTranscript || typeof input.priorTranscript !== 'string'
        ? ''
        : stripSyntheticTranscriptPreamble(input.priorTranscript),
    };
  }
  return {
    userInput: typeof input.message === 'string' ? input.message : '',
    priorTranscript: '',
  };
}
