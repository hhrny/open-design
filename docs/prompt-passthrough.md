# Prompt passthrough mode

The daemon defaults to `OD_PROMPT_MODE=passthrough`. In this mode the model
receives only runtime facts, genuine prior conversation turns when required,
and the user's exact current input. Open Design system prompts, Skills, design
systems, plugins, OD Next bundles, research instructions, form protocols, title
markers, completion markers, next steps, and artifact-focus instructions are
not included.

Use the old prompt stack only as an explicit rollback:

```bash
OD_PROMPT_MODE=open-design pnpm tools-dev run web --daemon-port 17456 --web-port 17573
```

## Inspect the exact model payload

Prompt logging is opt-in because it contains user text. Start the development
runtime with:

```bash
OD_DEBUG_COMPOSED_PROMPT=1 pnpm tools-dev run web --daemon-port 17456 --web-port 17573
```

Send a chat turn, then inspect the daemon log:

```bash
pnpm tools-dev logs --json
```

Look for a `[prompt-debug]` record. Its `promptMode` must be `passthrough` and
`composedPrompt` is the exact text delivered to the selected agent runtime.
Unset `OD_DEBUG_COMPOSED_PROMPT` after debugging.

The expected payload is:

```text
<runtime-context>
{
  "working_directory": "/path/to/the/active/project",
  "selected_files": ["src/example.ts"]
}
</runtime-context>

The user's exact current input
```

When no runtime facts or prior turns exist, the payload is byte-for-byte equal
to the user's current input.
