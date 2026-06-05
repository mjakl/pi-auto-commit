# pi-auto-commit

`pi-auto-commit` is a Pi package that lets the coding agent mark coherent git commit checkpoints while the extension owns the deterministic git work: safety checks, staging, commit-message generation, and `git commit` execution.

The goal is to keep the main agent focused on implementation while avoiding automatic guesses about when to commit. Auto-commit does **not** mean committing after every turn, on idle, or before every user prompt. When enabled, the agent may call `auto_commit_checkpoint` after a coherent git-visible change is complete.

## Install

Install from a local checkout with Pi package management:

```bash
pi install /absolute/path/to/pi-auto-commit
```

For one-off testing without adding it to settings:

```bash
pi -e /absolute/path/to/pi-auto-commit
```

Pi loads the extension declared by this package's `pi.extensions` manifest.

## Use

Use the slash command to toggle auto-commit for the current session:

```text
/autocommit
```

There is no keyboard shortcut and no shortcut support in v1.

When enabled, the extension shows an `autocommit` status entry. When disabled, no status entry is shown.

## Configuration

Configuration is global and optional. Create this file under Pi's configured agent directory:

```text
${PI_CODING_AGENT_DIR:-~/.pi/agent}/extensions/pi-auto-commit.json
```

Example:

```json
{
  "defaultEnabled": false,
  "commitModel": {
    "provider": "openai-codex",
    "model": "gpt-5.4-mini",
    "thinking": "low"
  },
  "messageInstructions": [
    "Keep commit messages short.",
    "Use imperative mood.",
    "Start the subject with an uppercase letter, then sentence case.",
    "Do not use conventional commit prefixes like feat: or fix:.",
    "Write a body only when it adds useful context beyond the subject."
  ]
}
```

- `defaultEnabled`: when true, the extension tries to enable auto-commit on session start/reload/resume/fork.
- `commitModel`: optional model for commit-message generation. If omitted, the current main agent model and thinking level are used.
- `messageInstructions`: optional commit-message style instructions. Invalid or missing values fall back to the built-in defaults.

`defaultEnabled` is only a startup activation attempt. Runtime on/off state is session-local.

## Safety model

Auto-commit can only be enabled in a clean git repository. If the worktree has git-visible changes, enablement is rejected and you must commit, clean, stash, or ignore those files manually first. Ignored files do not block enablement and are not committed.

While auto-commit is enabled, anything git-visible may be committed, including manual edits. Put scratch files in `/tmp`, a `mktemp -d` directory, or a git-ignored path.

Checkpoint commits use `git add -A` semantics: staged changes, unstaged changes, untracked non-ignored files, and deletions are included. The extension never pushes.

## Agent tool

When enabled, the agent may call:

```ts
auto_commit_checkpoint({
  change_summary: string,
  change_reason?: string
})
```

The inputs describe intent in plain language. The extension generates the actual git commit message from those inputs plus bounded git status, stats, and diff excerpts.

Commit-message generation hard-errors without staging or committing if the configured model is invalid, auth is unavailable, or the model output cannot be repaired into the required JSON shape. There is no fallback commit message in v1.
