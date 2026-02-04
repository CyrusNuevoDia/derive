# derive — Bun Implementation Spec

## Overview

`derive` is a content-addressed, LLM-powered build system for derived files. It detects source file changes via SHA-256 hashing, assembles a prompt, and injects it into a configurable runner command (e.g. `claude`, `codex`, `llm`).

Built as a single TypeScript entrypoint, compiled to a standalone binary via `bun build --compile`.

---

## Project Structure

```
derive/
├── src/
│   ├── index.ts          # CLI entrypoint (argument parsing, orchestration)
│   ├── config.ts         # Config discovery, loading, validation
│   ├── hash.ts           # File hashing + Merkle root computation
│   ├── lock.ts           # Lockfile read/write/diff
│   ├── runner.ts         # Prompt assembly + shell execution
│   └── types.ts          # Shared type definitions
├── test/
│   ├── config.test.ts
│   ├── hash.test.ts
│   ├── lock.test.ts
│   ├── runner.test.ts
│   └── integration.test.ts
├── derive.jsonc          # Self-referential: derive uses derive
├── package.json
├── tsconfig.json
└── README.md
```

---

## Type Definitions (`types.ts`)

```typescript
/** The resolved, validated configuration shape. */
export type DeriveConfig = {
  runner: string;
  tasks: Record<string, TaskConfig>;
}

export type TaskConfig = {
  prompt: string;
  sources: string[];
  exclude?: string[];
  runner?: string;  // overrides top-level runner
}

/** The .derive.lock file shape. */
export type DeriveLock = {
  version: 1;
  tasks: Record<string, TaskLockEntry>;
}

export type TaskLockEntry = {
  last_run: string;           // ISO 8601
  sources_hash: string;       // "sha256:<hex>"
  files: Record<string, string>;  // path → "sha256:<hex>"
}

/** Result of diffing current state against lockfile. */
export type TaskDiff = {
  task: string;
  changed: boolean;
  changed_files: string[];    // paths that are new or modified
  removed_files: string[];    // paths that were in lock but no longer match globs
  all_files: string[];        // all currently matched files
}
```

---

## Config Discovery & Loading (`config.ts`)

### Discovery Order

When no explicit `--config` flag is provided, derive searches the current working directory for config files in this order:

1. `derive.ts`
2. `derive.jsonc`
3. `derive.json`
4. `derive.toml`

**First match wins.** If none are found, exit with code 2 and message:

```
derive: no config found (looked for derive.ts, derive.jsonc, derive.json, derive.toml)
```

### Loading by Format

#### `derive.json` / `derive.jsonc`

```typescript
const text = await Bun.file(path).text();
// Strip JSONC comments: // and /* */ style
const stripped = stripJsonComments(text);
const raw = JSON.parse(stripped);
return validate(raw);
```

JSONC comment stripping should handle:
- Single-line comments (`// ...`)
- Multi-line comments (`/* ... */`)
- Comments inside strings must NOT be stripped (e.g. `"url": "https://example.com"`)
- Trailing commas (JSON.parse in Bun handles these natively)

#### `derive.toml`

Use Bun's built-in TOML support or a lightweight parser.

#### `derive.ts`

Evaluated at runtime via dynamic import. The file must have a default export that is either:
- A `DeriveConfig` object, or
- An `async () => DeriveConfig` function

```typescript
const mod = await import(resolve(path));
const exported = mod.default;
const raw = typeof exported === "function" ? await exported() : exported;
return validate(raw);
```

This enables dynamic config:

```typescript
// derive.ts
import type { DeriveConfig } from "derive";

export default async (): Promise<DeriveConfig> => {
  const pkg = await Bun.file("package.json").json();
  return {
    runner: `claude --print --prompt "{prompt}"`,
    tasks: {
      readme: {
        prompt: `Update README.md for ${pkg.name}@${pkg.version}.`,
        sources: ["src/**/*.py"],
      },
    },
  };
};
```

### Validation

After loading, validate the config structurally. On failure, exit with code 2 and a clear message.

**Required checks:**
- `runner` is a non-empty string containing `{prompt}`
- `tasks` is a non-empty object
- Each task has a non-empty `prompt` string
- Each task has a non-empty `sources` array of strings
- If task-level `runner` is set, it must contain `{prompt}`
- `exclude`, if present, must be an array of strings

**Error messages should be specific:**

```
derive: config error in "api-docs": runner does not contain {prompt}
derive: config error in "skill": sources must be a non-empty array
```

---

## File Hashing (`hash.ts`)

### Per-File Hash

```typescript
export async function hashFile(path: string): Promise<string> {
  const file = Bun.file(path);
  const hasher = new Bun.CryptoHasher("sha256");
  // Stream the file to avoid loading large files into memory
  const stream = file.stream();
  for await (const chunk of stream) {
    hasher.update(chunk);
  }
  return `sha256:${hasher.digest("hex")}`;
}
```

### Merkle Root

The `sources_hash` is the SHA-256 of all per-file hashes, sorted lexicographically by file path:

```typescript
export function computeMerkleRoot(
  fileHashes: Record<string, string>
): string {
  const hasher = new Bun.CryptoHasher("sha256");
  const sortedPaths = Object.keys(fileHashes).sort();
  for (const path of sortedPaths) {
    hasher.update(`${path}:${fileHashes[path]}\n`);
  }
  return `sha256:${hasher.digest("hex")}`;
}
```

> **Why include the path in the root computation?** So that renaming a file (without changing its content) is detected as a change. The hash `a.py:sha256:abc` differs from `b.py:sha256:abc`.

### Glob Resolution

```typescript
import { Glob } from "bun";

export async function resolveFiles(
  sources: string[],
  exclude: string[] = []
): Promise<string[]> {
  const matched = new Set<string>();

  for (const pattern of sources) {
    const glob = new Glob(pattern);
    for await (const path of glob.scan({ cwd: process.cwd(), dot: false })) {
      matched.add(path);
    }
  }

  // Apply exclusions
  for (const pattern of exclude) {
    const glob = new Glob(pattern);
    for await (const path of glob.scan({ cwd: process.cwd(), dot: false })) {
      matched.delete(path);
    }
  }

  return [...matched].sort();
}
```

---

## Lockfile Management (`lock.ts`)

### Location

`.derive.lock` in the same directory as the config file. Always JSON (not JSONC — no comments needed, it's machine-managed).

### Reading

```typescript
export async function readLock(lockPath: string): Promise<DeriveLock> {
  const file = Bun.file(lockPath);
  if (!(await file.exists())) {
    return { version: 1, tasks: {} };
  }
  return await file.json();
}
```

### Writing

```typescript
export async function writeLock(
  lockPath: string,
  lock: DeriveLock
): Promise<void> {
  await Bun.write(lockPath, JSON.stringify(lock, null, 2) + "\n");
}
```

### Diffing

```typescript
export function diffTask(
  taskName: string,
  currentFiles: Record<string, string>,
  currentRoot: string,
  lockEntry: TaskLockEntry | undefined
): TaskDiff {
  const allFiles = Object.keys(currentFiles);

  // No lock entry → everything is new
  if (!lockEntry) {
    return {
      task: taskName,
      changed: true,
      changed_files: allFiles,
      removed_files: [],
      all_files: allFiles,
    };
  }

  // Quick check: Merkle root match → skip
  if (lockEntry.sources_hash === currentRoot) {
    return {
      task: taskName,
      changed: false,
      changed_files: [],
      removed_files: [],
      all_files: allFiles,
    };
  }

  // Slow path: per-file diff
  const changed: string[] = [];
  const removed: string[] = [];

  for (const [path, hash] of Object.entries(currentFiles)) {
    if (lockEntry.files[path] !== hash) {
      changed.push(path);
    }
  }

  for (const path of Object.keys(lockEntry.files)) {
    if (!(path in currentFiles)) {
      removed.push(path);
    }
  }

  return {
    task: taskName,
    changed: changed.length > 0 || removed.length > 0,
    changed_files: changed,
    removed_files: removed,
    all_files: allFiles,
  };
}
```

---

## Runner Execution (`runner.ts`)

### Login Shell Invocation

This is critical. LLM CLI tools like `claude`, `codex`, and `llm` are typically installed via `npm -g`, `pip`, `brew`, or similar — and their paths are configured in the user's shell profile (`.zshrc`, `.bashrc`, `.profile`). A naive `child_process.exec` won't load these profiles.

**derive must execute the runner as a login shell command:**

```typescript
import { $ } from "bun";

export async function executeRunner(
  runnerTemplate: string,
  prompt: string
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  // Interpolate {prompt} into the runner command
  // Escape the prompt for shell safety
  const assembled = runnerTemplate.replace("{prompt}", prompt);

  // Detect the user's shell
  const shell = process.env.SHELL || "/usr/bin/env bash";

  // Execute as interactive login shell to load .zshrc / .bashrc / .profile
  // -l = login shell (loads profile)
  // -i = interactive (loads rc file — needed for .zshrc on macOS)
  // -c = execute command string
  const proc = Bun.spawn([shell, "-l", "-i", "-c", assembled], {
    cwd: process.cwd(),
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
    env: {
      ...process.env,
      // Ensure color output passes through
      FORCE_COLOR: "1",
    },
  });

  const exitCode = await proc.exited;
  return { exitCode, stdout: "", stderr: "" };
}
```

> **Why `-l -i`?** On macOS with zsh (the default), `.zshrc` only loads for interactive shells, while `.zprofile` loads for login shells. Using both flags ensures we pick up PATH modifications regardless of where the user configured them. This is the same strategy used by VS Code's integrated terminal.

> **Why `stdin: "inherit"`?** Some runners (like `claude` in interactive mode) may need terminal input. Inheriting stdin keeps that working.

### Prompt Assembly

```typescript
export function assemblePrompt(
  userPrompt: string,
  changedFiles: string[]
): string {
  return [
    `<prompt>${userPrompt}</prompt>`,
    `<changed-files>${changedFiles.join(", ")}</changed-files>`,
  ].join("\n");
}
```

### Shell Escaping

The assembled prompt contains user text and file paths. It gets interpolated into a shell command. This is a shell injection vector.

**Strategy: write the prompt to a temp file and pass the path.**

No — that changes the runner contract. The runner expects `{prompt}` to be the literal prompt string.

**Strategy: escape for shell.**

The prompt is embedded in a double-quoted string in the runner template. We must escape:
- `"` → `\"`
- `$` → `\$`
- `` ` `` → `` \` ``
- `\` → `\\`
- `!` → `\!` (bash history expansion)

```typescript
export function shellEscape(s: string): string {
  return s
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/\$/g, "\\$")
    .replace(/`/g, "\\`")
    .replace(/!/g, "\\!");
}
```

The interpolation then becomes:

```typescript
const escaped = shellEscape(prompt);
const command = runnerTemplate.replace("{prompt}", escaped);
```

---

## CLI Entrypoint (`index.ts`)

### Argument Parsing

Keep it minimal. No framework needed — `process.argv` slicing is sufficient for this surface area.

```
derive                     # run all tasks with changes
derive <task>              # run specific task if changed
derive --force [task]      # run regardless of hash state
derive --dry-run [task]    # show what would run
derive --status            # show per-task change status
derive --init              # write a starter derive.jsonc
derive --config <path>     # use specific config file
derive --help              # print usage
derive --version           # print version
```

### Orchestration (main loop)

```
1. Parse CLI args
2. Discover + load config
3. Read .derive.lock
4. Determine which tasks to process (all or specified)
5. For each task:
   a. Resolve globs → file list
   b. Hash all files
   c. Compute Merkle root
   d. Diff against lockfile
   e. If --status: print status, continue
   f. If --dry-run: print what would execute, continue
   g. If no changes and not --force: skip, log "task: no changes"
   h. Assemble prompt XML
   i. Interpolate into runner
   j. Execute via login shell
   k. If exit 0: update lockfile entry, write .derive.lock
   l. If exit != 0: leave lockfile unchanged, log error
6. Exit with appropriate code
```

### Console Output

Minimal, structured. No spinners, no progress bars. This is a build tool, not a TUI.

```
derive: loaded derive.jsonc (3 tasks)
derive: skill — 3 files changed (src/cli.py, src/load.py, src/dedupe.py)
derive: skill — running: claude --print --prompt "..."
derive: skill — done (14.2s)
derive: readme — no changes
derive: api-docs — 1 file changed (src/api/routes.ts)
derive: api-docs — running: codex --prompt "..."
derive: api-docs — done (8.7s)
derive: updated .derive.lock
```

With `--status`:

```
derive: skill — changed (3 files)
derive: readme — up to date
derive: api-docs — changed (1 file)
```

With `--dry-run`:

```
derive: skill — would run: claude --print --prompt "<prompt>Update the Claude Code skill...</prompt>\n<changed-files>src/cli.py, src/load.py</changed-files>"
derive: readme — no changes, would skip
```

---

## `derive --init`

Creates a starter `derive.jsonc` in the current directory:

```jsonc
{
  // derive: content-addressed LLM generation
  // Docs: https://github.com/yourname/derive

  // Default runner. {prompt} is the only injected variable.
  "runner": "claude --print --prompt \"{prompt}\"",

  "tasks": {
    "example": {
      "prompt": "Describe what this task should do.",
      "sources": ["src/**/*.ts"],
      "exclude": ["src/**/*.test.ts"]
    }
  }
}
```

---

## Build & Distribution

### Development

```bash
bun run src/index.ts          # run directly
bun test                      # run test suite
```

### Compile

```bash
# Current platform
bun build src/index.ts --compile --outfile derive

# Cross-compile
bun build src/index.ts --compile --target=bun-darwin-arm64 --outfile derive-macos-arm64
bun build src/index.ts --compile --target=bun-linux-x64 --outfile derive-linux-x64
bun build src/index.ts --compile --target=bun-windows-x64 --outfile derive-windows-x64.exe
```

### package.json

```json
{
  "name": "derive",
  "version": "0.1.0",
  "type": "module",
  "bin": {
    "derive": "./src/index.ts"
  },
  "scripts": {
    "dev": "bun run src/index.ts",
    "build": "bun build src/index.ts --compile --outfile bin/derive",
    "test": "bun test"
  },
  "dependencies": {
    "smol-toml": "^1.3.0"
  },
  "devDependencies": {
    "@types/bun": "latest"
  }
}
```

---

## Test Cases

### `config.test.ts` — Config Discovery & Loading

```
✓ discovers derive.jsonc in cwd
✓ discovers derive.json when no .jsonc exists
✓ discovers derive.toml when no .json/.jsonc exists
✓ discovers derive.ts when no other configs exist
✓ respects priority order (derive.ts wins over derive.jsonc if both exist)
✓ --config flag overrides autodiscovery
✓ exits code 2 when no config found
✓ parses JSONC with single-line comments
✓ parses JSONC with multi-line comments
✓ parses JSONC with trailing commas
✓ does not strip comments inside strings (e.g. URLs with //)
✓ parses TOML config correctly
✓ evaluates derive.ts default export (object)
✓ evaluates derive.ts default export (async function)
✓ rejects derive.ts that exports neither object nor function
✓ rejects config missing runner field
✓ rejects config with runner missing {prompt}
✓ rejects config with empty tasks
✓ rejects task missing prompt
✓ rejects task missing sources
✓ rejects task with empty sources array
✓ accepts task without exclude (optional field)
✓ validates per-task runner contains {prompt}
✓ error messages include task name and field
```

### `hash.test.ts` — Hashing & Glob Resolution

```
✓ hashes a file to deterministic sha256
✓ same content in different files produces same hash
✓ single byte change produces different hash
✓ handles empty files (hash of empty string)
✓ handles binary files without error
✓ handles large files via streaming (doesn't OOM)
✓ Merkle root is deterministic for same file set
✓ Merkle root changes when any file content changes
✓ Merkle root changes when a file is renamed (same content)
✓ Merkle root is independent of glob evaluation order
✓ resolves basic glob pattern (src/*.py)
✓ resolves recursive glob (src/**/*.py)
✓ resolves multiple source patterns (union)
✓ applies exclude patterns correctly
✓ exclude pattern removes files matched by sources
✓ glob does not match dotfiles by default
✓ returns sorted, deduplicated file list
✓ returns empty array when no files match
```

### `lock.test.ts` — Lockfile Management

```
✓ returns empty lock when .derive.lock doesn't exist
✓ reads and parses existing .derive.lock
✓ writes .derive.lock with stable JSON formatting
✓ written lockfile is valid JSON and roundtrips cleanly
✓ diff detects no changes when Merkle root matches
✓ diff fast-paths on Merkle root match (skips per-file comparison)
✓ diff detects new files
✓ diff detects modified files
✓ diff detects removed files
✓ diff detects file renames (removed + added)
✓ diff treats missing lock entry as "everything changed"
✓ per-task independence: updating task A doesn't affect task B's hashes
✓ failed task does not update lock entry
✓ successful task updates only its own lock entry
```

### `runner.test.ts` — Prompt Assembly & Shell Execution

```
✓ assembles prompt XML with changed files
✓ assembles prompt XML with single changed file
✓ shell-escapes double quotes in prompt
✓ shell-escapes dollar signs in prompt
✓ shell-escapes backticks in prompt
✓ shell-escapes backslashes in prompt
✓ shell-escapes exclamation marks in prompt
✓ handles prompt with all special characters combined
✓ interpolates escaped prompt into runner template
✓ uses task-level runner when specified
✓ falls back to default runner when task has no runner
✓ executes command in a login shell (-l -i -c)
✓ detects user shell from $SHELL env var
✓ falls back to /bin/sh when $SHELL is unset
✓ inherits stdin for interactive runners
✓ inherits stdout/stderr for runner output passthrough
✓ returns exit code 0 on runner success
✓ returns non-zero exit code on runner failure
✓ passes FORCE_COLOR=1 in environment
✓ executes in current working directory
```

### `integration.test.ts` — End-to-End

These tests use a temporary directory with real files and a mock runner (a simple script that echoes its arguments and exits 0).

```
✓ full run: discovers config, hashes files, detects changes, invokes runner, writes lock
✓ second run with no file changes: skips all tasks
✓ second run after modifying one file: runs only affected task
✓ second run after adding a new file matching glob: detects and includes it
✓ second run after deleting a file: detects removal as a change
✓ --force flag runs task even when no changes detected
✓ --dry-run prints command but does not execute or update lock
✓ --status prints per-task change summary without executing
✓ runner failure (exit code 1) does not update lockfile
✓ runner failure for one task does not prevent other tasks from running
✓ per-task runner override is used when specified
✓ works with derive.jsonc config
✓ works with derive.json config
✓ works with derive.toml config
✓ works with derive.ts config (object export)
✓ works with derive.ts config (async function export)
✓ handles task with no matching source files (treats as "no changes")
✓ handles special characters in file paths
✓ creates .derive.lock on first run
✓ --init creates starter derive.jsonc
✓ --init refuses to overwrite existing config
```

### Mock Runner for Tests

Create a simple script at `test/fixtures/mock-runner.sh`:

```bash
#!/usr/bin/env bash
# Mock runner that logs invocation and exits successfully.
# Writes the received prompt to a file for assertion.
echo "$1" > /tmp/derive-test-prompt.txt
exit 0
```

And a failing variant:

```bash
#!/usr/bin/env bash
exit 1
```

Test configs use these as runners:

```jsonc
{
  "runner": "bash test/fixtures/mock-runner.sh \"{prompt}\"",
  "tasks": { ... }
}
```

---

## Edge Cases & Error Handling

### Config Errors
- Missing or invalid config → exit code 2, descriptive message
- Config file parse error (bad JSON, bad TOML) → exit code 2, include file name and parse error
- `derive.ts` that throws during evaluation → exit code 2, include the thrown error

### Filesystem Edge Cases
- Source glob matches zero files → task is treated as "no changes" (not an error)
- Source file is deleted between glob resolution and hashing → log warning, skip file
- `.derive.lock` is malformed → treat as empty lock (log warning), regenerate on next successful run
- Config file disappears mid-run → this can't happen (it's loaded once at startup)

### Runner Edge Cases
- Runner command not found (e.g. `claude` not in PATH) → the login shell will return exit code 127; derive reports this as a runner failure
- Runner hangs indefinitely → derive does not impose a timeout (the user can Ctrl+C; the signal propagates via inherited stdin)
- Runner prints to stdout/stderr → passed through directly since we inherit stdio

### Concurrency
- derive runs tasks in parallel and uses a lock around the lockfile to ensure atomicity. It always reads then writes.

---

## Future Considerations (Not in v0.1)

- **Watch mode** (`derive --watch`) — re-run on filesystem changes via `fs.watch`
- **Task dependencies** — `"after": ["skill"]` field for ordering
- **Prompt files** — `"prompt_file": "prompts/skill.md"` for long prompts
- **CI mode** — `--ci` flag that exits non-zero if any task has pending changes (for drift detection in CI)
- **Parallel execution** — run independent tasks concurrently
