import { describe, expect, it } from 'vitest';

import {
  composePassthroughPrompt,
  readPromptMode,
  resolvePassthroughTurn,
  stripSyntheticTranscriptPreamble,
} from '../../src/prompts/passthrough.js';

const FORBIDDEN_PROMPT_MARKERS = [
  'OpenDesign',
  'OD Next',
  'Design Files',
  '# Instructions',
  '# User request',
  'question-form',
  'od-card',
  'od-done',
  'od-title',
  'od-focus',
  'TodoWrite',
  'Active skill',
  'Active design system',
] as const;

describe('passthrough prompt composition', () => {
  it('defaults to passthrough and requires an explicit rollback value', () => {
    expect(readPromptMode({})).toBe('passthrough');
    expect(readPromptMode({ OD_PROMPT_MODE: 'passthrough' })).toBe('passthrough');
    expect(readPromptMode({ OD_PROMPT_MODE: 'invalid' })).toBe('passthrough');
    expect(readPromptMode({ OD_PROMPT_MODE: 'open-design' })).toBe('open-design');
  });

  it('returns the exact user bytes when no runtime context exists', () => {
    const userInput = '  第一行\n\n第二行  ';
    expect(composePassthroughPrompt({ userInput }).composedPrompt).toBe(userInput);
  });

  it('adds facts without adding Open Design instructions', () => {
    const result = composePassthroughPrompt({
      userInput: '修改选中的文件',
      workingDirectory: '/work/project',
      selectedFiles: ['src/a.ts', 'src/a.ts', 'docs/spec.md'],
      linkedDirectories: ['/reference/code'],
      workspaceItems: [
        { kind: 'file', label: 'a.ts', path: 'src/a.ts' },
        { kind: 'browser', label: 'Docs', url: 'https://example.test/docs' },
      ],
      imageReferences: ['/uploads/ref.png'],
    }).composedPrompt;

    expect(result).toContain('"working_directory": "/work/project"');
    expect(result).toContain('"selected_files"');
    expect(result.match(/src\/a\.ts/g)).toHaveLength(2);
    expect(result.endsWith('修改选中的文件')).toBe(true);
    for (const marker of FORBIDDEN_PROMPT_MARKERS) expect(result).not.toContain(marker);
  });

  it('keeps genuine prior turns but removes the synthetic context warning', () => {
    const transcript = [
      '## context warning',
      'OpenDesign detected a previous large tool result.',
      'Keep this turn compact.',
      '',
      '## user',
      '先前请求',
      '',
      '## assistant',
      '先前回复',
    ].join('\n');
    expect(stripSyntheticTranscriptPreamble(transcript)).toBe(
      '## user\n先前请求\n\n## assistant\n先前回复',
    );

    const turn = resolvePassthroughTurn({
      message: 'flattened transcript',
      currentPrompt: '当前输入',
      priorTranscript: transcript,
      skipTranscript: false,
    });
    const result = composePassthroughPrompt(turn).composedPrompt;
    expect(result).toContain('先前请求');
    expect(result.endsWith('当前输入')).toBe(true);
    expect(result).not.toContain('OpenDesign detected');
  });

  it('sends only the current input when the runtime resumes its native session', () => {
    expect(resolvePassthroughTurn({
      message: 'full transcript',
      currentPrompt: '当前输入',
      priorTranscript: '## user\n旧输入',
      skipTranscript: true,
    })).toEqual({ userInput: '当前输入', priorTranscript: '' });
  });
});
