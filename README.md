# derive

A content-addressed, declarative, LLM-powered build system for derived files.

> `make` where the compiler is an LLM.

```bash
derive              # run tasks with changes
derive readme       # run specific task
derive --status     # see what's stale
derive --force      # ignore hashes, run anyway
```

## What It Does

1. Hash your source files (SHA-256)
2. Compare against `.derive.lock`
3. If changed: assemble prompt → run your LLM CLI → update lock
4. If unchanged: skip

No more regenerating docs when nothing changed. No more forgetting to update generated files when sources change.

## Quick Start

```bash
# Install
bun install -g derive

# Initialize config in your project
derive --init

# Edit derive.jsonc to define your tasks
# Then run
derive
```

## Installation

### From npm (via Bun)

```bash
bun install -g derive
```

### From source

```bash
git clone https://github.com/zenbase-ai/derive
cd derive
bun install
bun run build  # Creates bin/derive
```

## CLI Reference

```
derive                     Run all tasks with changes
derive <task>              Run specific task if changed
derive --force [task]      Run regardless of hash state
derive --dry-run [task]    Show what would run
derive --status            Show per-task change status
derive --init              Create starter derive.jsonc
derive --config <path>     Use specific config file
derive --help              Print help
derive --version           Print version
```

### Flags

| Flag | Short | Description |
|------|-------|-------------|
| `--help` | `-h` | Print help message and exit |
| `--version` | `-v` | Print version number and exit |
| `--force` | `-f` | Run task(s) regardless of hash state |
| `--dry-run` | `-n` | Show what would run without executing |
| `--status` | `-s` | Show per-task change status |
| `--init` | | Create a starter `derive.jsonc` in the current directory |
| `--config <path>` | `-c` | Use a specific config file instead of auto-discovery |

### Examples

```bash
# Run all tasks that have changes
derive

# Run only the "readme" task (if changed)
derive readme

# Force run the "readme" task even if nothing changed
derive --force readme
derive -f readme

# See what would run without actually running
derive --dry-run
derive -n

# Check which tasks have pending changes
derive --status
derive -s

# Use a specific config file
derive --config ./config/derive.jsonc
derive -c ./config/derive.jsonc

# Initialize a new project
derive --init
```

## Configuration

Derive looks for config files in this order:

1. `derive.ts` (TypeScript, for dynamic configs)
2. `derive.jsonc` (JSON with comments)
3. `derive.json` (plain JSON)
4. `derive.toml` (TOML)

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

Use `derive.ts` for dynamic configuration:

```typescript
// derive.ts
import type { DeriveConfig } from "derive";

export default async (): Promise<DeriveConfig> => {
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
// derive.ts
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

Derive uses SHA-256 hashes to track file changes:

- **Per-file hashes**: Each source file is hashed individually using streaming to handle large files
- **Merkle root**: A combined hash of all files for fast "anything changed?" checks
- **Incremental updates**: Only changed files trigger regeneration

### Prompt Assembly

When a task runs, derive assembles a prompt in XML format:

```xml
<prompt>Your task prompt here</prompt>
<changed-files>src/foo.ts, src/bar.ts</changed-files>
```

This tells your LLM what to do and which files changed, so it can focus on relevant updates.

### Shell Execution

Runners are executed in a login shell (`-l -i -c`) to ensure your PATH and environment are properly loaded from your shell config (`.zshrc`, `.bashrc`, etc.).

The `{prompt}` placeholder is safely shell-escaped before substitution.

## The Lockfile

`.derive.lock` tracks the state of your last run:

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

Derive is runner-agnostic. Use any CLI that accepts a prompt:

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
