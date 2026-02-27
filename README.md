# llmake

A content-addressed, declarative, LLM-powered build system for derived files.

> `make` where the compiler is an LLM.

```bash
llmake              # run tasks with changes
llmake readme       # run specific task
llmake --status     # see what's stale
llmake --force      # ignore hashes, run anyway
```

## What It Does

1. Hash your source files (SHA-256)
2. Compare against `.llmake.lock`
3. If changed: assemble prompt -> run your LLM CLI -> update lock
4. If unchanged: skip

No more regenerating docs when nothing changed. No more forgetting to update generated files when sources change.

## Quick Start

```bash
# Install
npx llmake --init

# Edit llmake.jsonc to define your tasks
# Then run
npx llmake
```

Or install globally:

```bash
npm i -g llmake
llmake
```

## Installation

### Global install

```bash
npm i -g llmake    # npm
bun add -g llmake  # bun
pnpm add -g llmake # pnpm
```

### Run without installing

```bash
npx llmake         # npm
bunx llmake        # bun
pnpx llmake        # pnpm
```

### From source

```bash
git clone https://github.com/CyrusNuevoDia/llmake
cd llmake
bun install
bun run build:bin  # Creates bin/llmake
```

## CLI Reference

```
llmake                     Run all tasks with changes
llmake <task>              Run specific task if changed
llmake --force [task]      Run regardless of hash state
llmake --dry-run [task]    Show what would run
llmake --status            Show per-task change status
llmake --init              Create starter llmake.jsonc
llmake --config <path>     Use specific config file
llmake --help              Print help
llmake --version           Print version
```

### Flags

| Flag | Short | Description |
|------|-------|-------------|
| `--help` | `-h` | Print help message and exit |
| `--version` | `-v` | Print version number and exit |
| `--force` | `-f` | Run task(s) regardless of hash state |
| `--dry-run` | `-n` | Show what would run without executing |
| `--status` | `-s` | Show per-task change status |
| `--init` | | Create a starter `llmake.jsonc` in the current directory |
| `--config <path>` | `-c` | Use a specific config file instead of auto-discovery |

### Examples

```bash
# Run all tasks that have changes
llmake

# Run only the "readme" task (if changed)
llmake readme

# Force run the "readme" task even if nothing changed
llmake --force readme
llmake -f readme

# See what would run without actually running
llmake --dry-run
llmake -n

# Check which tasks have pending changes
llmake --status
llmake -s

# Use a specific config file
llmake --config ./config/llmake.jsonc
llmake -c ./config/llmake.jsonc

# Initialize a new project
llmake --init
```

## Configuration

llmake looks for config files in this order:

1. `llmake.ts` (TypeScript, for dynamic configs)
2. `llmake.jsonc` (JSON with comments)
3. `llmake.json` (plain JSON)
4. `llmake.toml` (TOML)

### Config Structure

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `runner` | string | Yes | Default command to execute. Must contain `{prompt}` placeholder. |
| `tasks` | object | Yes | Map of task names to task configurations |

### Task Structure

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `prompt` | string | Yes | The prompt/instruction for the LLM |
| `sources` | string[] | Yes | Glob patterns for source files to watch |
| `exclude` | string[] | No | Glob patterns for files to exclude |
| `runner` | string | No | Override the default runner for this task |

### JSONC Example

```jsonc
{
  // Default runner command - {prompt} will be replaced with the assembled prompt
  "runner": "claude --allowed-tools Read,Write,Edit --print {prompt}",
  "tasks": {
    "readme": {
      "prompt": "Update README.md based on the current codebase. Keep it concise.",
      "sources": ["src/**/*.ts"],
      "exclude": ["src/**/*.test.ts", "src/**/*.spec.ts"]
    },
    "api-docs": {
      "prompt": "Generate API documentation for the public exports.",
      "sources": ["src/index.ts", "src/types.ts"],
      // Override runner for this specific task
      "runner": "llm -m gpt-4o {prompt}"
    },
    "changelog": {
      "prompt": "Update CHANGELOG.md with recent changes.",
      "sources": ["src/**/*.ts", "package.json"]
    }
  }
}
```

### JSON Example

```json
{
  "runner": "claude --print {prompt}",
  "tasks": {
    "readme": {
      "prompt": "Update README.md based on the codebase.",
      "sources": ["src/**/*.ts"],
      "exclude": ["src/**/*.test.ts"]
    }
  }
}
```

### TOML Example

```toml
runner = "claude --print {prompt}"

[tasks.readme]
prompt = "Update README.md based on the codebase."
sources = ["src/**/*.ts"]
exclude = ["src/**/*.test.ts"]

[tasks.api-docs]
prompt = "Generate API documentation."
sources = ["src/index.ts", "src/types.ts"]
runner = "llm -m gpt-4o {prompt}"
```

### TypeScript Example

Use `llmake.ts` for dynamic configuration:

```typescript
// llmake.ts
import type { LlmakeConfig } from "llmake";

export default async (): Promise<LlmakeConfig> => {
  const pkg = await Bun.file("package.json").json();

  return {
    runner: `claude --allowed-tools Read,Write,Edit --print {prompt}`,
    tasks: {
      readme: {
        prompt: `Update README.md for ${pkg.name}@${pkg.version}.
                 Include installation instructions and API reference.`,
        sources: ["src/**/*.ts"],
        exclude: ["src/**/*.test.ts"],
      },
      changelog: {
        prompt: `Update CHANGELOG.md. Current version is ${pkg.version}.`,
        sources: ["src/**/*.ts", "package.json"],
      },
    },
  };
};
```

You can also export a static object:

```typescript
// llmake.ts
export default {
  runner: "claude --print {prompt}",
  tasks: {
    readme: {
      prompt: "Update the README.",
      sources: ["src/**/*.ts"],
    },
  },
};
```

## How It Works

### Content Addressing

llmake uses SHA-256 hashes to track file changes:

- **Per-file hashes**: Each source file is hashed individually using streaming to handle large files
- **Merkle root**: A combined hash of all files for fast "anything changed?" checks
- **Incremental updates**: Only changed files trigger regeneration

### Prompt Assembly

When a task runs, llmake assembles a prompt in XML format:

```xml
<prompt>Your task prompt here</prompt>
<changed-files>src/foo.ts, src/bar.ts</changed-files>
```

This tells your LLM what to do and which files changed, so it can focus on relevant updates.

### Shell Execution

Runners are executed in a login shell (`-l -i -c`) to ensure your PATH and environment are properly loaded from your shell config (`.zshrc`, `.bashrc`, etc.).

The `{prompt}` placeholder is safely shell-escaped before substitution.

## The Lockfile

`.llmake.lock` tracks the state of your last run:

```json
{
  "version": 1,
  "tasks": {
    "readme": {
      "last_run": "2024-01-15T10:30:00.000Z",
      "sources_hash": "sha256:abc123...",
      "files": {
        "src/index.ts": "sha256:def456...",
        "src/config.ts": "sha256:789abc..."
      }
    }
  }
}
```

**Commit this file.** It enables:

- Incremental builds in CI
- Team-wide consistency
- Audit trail of when files were last regenerated

## Runner Examples

llmake is runner-agnostic. Use any CLI that accepts a prompt:

```jsonc
{
  // Claude Code
  "runner": "claude --allowed-tools Read,Write,Edit --print {prompt}",

  // OpenAI via llm CLI
  "runner": "llm -m gpt-4o {prompt}",

  // Anthropic via llm CLI
  "runner": "llm -m claude-3-opus {prompt}",

  // Local models via Ollama
  "runner": "ollama run llama3 {prompt}",

  // Custom script
  "runner": "./scripts/generate.sh {prompt}"
}
```

### Task-Level Runners

Override the default runner per task:

```jsonc
{
  "runner": "claude --print {prompt}",
  "tasks": {
    "readme": {
      "prompt": "Update README.md",
      "sources": ["src/**/*.ts"]
      // Uses default runner: claude
    },
    "quick-task": {
      "prompt": "Fix typos in comments",
      "sources": ["src/**/*.ts"],
      "runner": "llm -m gpt-4o-mini {prompt}"  // Faster, cheaper model
    }
  }
}
```

## Glob Patterns

Source patterns follow standard glob syntax:

| Pattern | Matches |
|---------|---------|
| `src/**/*.ts` | All `.ts` files in `src/` recursively |
| `*.md` | All `.md` files in root |
| `src/*.ts` | `.ts` files directly in `src/` (not nested) |
| `{src,lib}/**/*.ts` | `.ts` files in both `src/` and `lib/` |

Exclude patterns remove files from the matched set:

```jsonc
{
  "sources": ["src/**/*.ts"],
  "exclude": [
    "src/**/*.test.ts",
    "src/**/*.spec.ts",
    "src/**/__tests__/**"
  ]
}
```

## Exit Codes

| Code | Meaning |
|------|---------|
| 0 | Success (all tasks completed or skipped) |
| 1 | Task execution failed or invalid arguments |
| 2 | No config file found |

## License

GPLv3
