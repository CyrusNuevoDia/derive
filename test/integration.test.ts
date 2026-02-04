import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const CLI_PATH = resolve(import.meta.dir, "../src/index.ts");
const VERSION_PATTERN = /^\d+\.\d+\.\d+\n?$/;
const SHA256_PATTERN = /^sha256:/;
const originalCwd = process.cwd();
let tempDir: string;

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "derive-integration-"));
  process.chdir(tempDir);
});

afterEach(async () => {
  process.chdir(originalCwd);
  await rm(tempDir, { recursive: true });
});

async function runCli(
  args: string[] = [],
  cwd?: string
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const proc = Bun.spawn(["bun", "run", CLI_PATH, ...args], {
    cwd: cwd ?? tempDir,
    stdout: "pipe",
    stderr: "pipe",
  });
  const exitCode = await proc.exited;
  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();
  return { exitCode, stdout, stderr };
}

async function writeConfig(filename: string, content: string): Promise<string> {
  const path = join(tempDir, filename);
  await writeFile(path, content);
  return path;
}

async function writeSourceFile(
  relativePath: string,
  content: string
): Promise<string> {
  const path = join(tempDir, relativePath);
  const dir = join(path, "..");
  await mkdir(dir, { recursive: true });
  await writeFile(path, content);
  return path;
}

async function readLockFile(): Promise<Record<string, unknown> | null> {
  try {
    const content = await readFile(join(tempDir, ".derive.lock"), "utf-8");
    return JSON.parse(content);
  } catch {
    return null;
  }
}

async function fileExists(relativePath: string): Promise<boolean> {
  try {
    await readFile(join(tempDir, relativePath));
    return true;
  } catch {
    return false;
  }
}

describe("derive CLI integration tests", () => {
  describe("basic workflow tests", () => {
    it("full run: discovers config, hashes files, detects changes, invokes runner, writes lock", async () => {
      await writeSourceFile("src/a.ts", 'export const a = "hello";');
      await writeSourceFile("src/b.ts", 'export const b = "world";');

      await writeConfig(
        "derive.jsonc",
        JSON.stringify({
          runner: 'echo "{prompt}" > output.txt',
          tasks: {
            test: {
              prompt: "Describe the code",
              sources: ["src/**/*.ts"],
            },
          },
        })
      );

      const { exitCode, stdout } = await runCli();

      expect(exitCode).toBe(0);
      expect(stdout).toContain("loaded derive.jsonc");
      expect(stdout).toContain("test");

      const lock = await readLockFile();
      expect(lock).not.toBeNull();
      expect(lock?.version).toBe(1);
      expect(lock?.tasks).toHaveProperty("test");

      const outputExists = await fileExists("output.txt");
      expect(outputExists).toBe(true);
    });

    it("second run with no file changes: skips all tasks", async () => {
      await writeSourceFile("src/a.ts", 'export const a = "hello";');

      await writeConfig(
        "derive.jsonc",
        JSON.stringify({
          runner: 'echo "{prompt}" > output.txt',
          tasks: {
            test: {
              prompt: "Describe the code",
              sources: ["src/**/*.ts"],
            },
          },
        })
      );

      // First run
      await runCli();

      // Remove output to verify runner does not re-execute
      await rm(join(tempDir, "output.txt"));

      // Second run
      const { exitCode, stdout } = await runCli();

      expect(exitCode).toBe(0);
      expect(stdout).toContain("no changes");

      // Output should not be recreated
      const outputExists = await fileExists("output.txt");
      expect(outputExists).toBe(false);
    });

    it("second run after modifying one file: runs affected task", async () => {
      await writeSourceFile("src/a.ts", 'export const a = "hello";');

      await writeConfig(
        "derive.jsonc",
        JSON.stringify({
          runner: 'echo "{prompt}" > output.txt',
          tasks: {
            test: {
              prompt: "Describe the code",
              sources: ["src/**/*.ts"],
            },
          },
        })
      );

      // First run
      await runCli();

      // Remove output to verify runner re-executes after modification
      await rm(join(tempDir, "output.txt"));

      // Modify file
      await writeSourceFile("src/a.ts", 'export const a = "modified";');

      // Second run
      const { exitCode, stdout } = await runCli();

      expect(exitCode).toBe(0);
      expect(stdout).toContain("1 files changed");
      expect(stdout).toContain("src/a.ts");

      const outputExists = await fileExists("output.txt");
      expect(outputExists).toBe(true);
    });
  });

  describe("flag tests", () => {
    it("--status prints per-task change summary without executing", async () => {
      await writeSourceFile("src/a.ts", 'export const a = "hello";');

      await writeConfig(
        "derive.jsonc",
        JSON.stringify({
          runner: 'echo "{prompt}" > output.txt',
          tasks: {
            test: {
              prompt: "Describe the code",
              sources: ["src/**/*.ts"],
            },
          },
        })
      );

      const { exitCode, stdout } = await runCli(["--status"]);

      expect(exitCode).toBe(0);
      expect(stdout).toContain("test");
      expect(stdout).toContain("changed");

      // Runner should not have executed
      const outputExists = await fileExists("output.txt");
      expect(outputExists).toBe(false);

      // Lock should not be created/updated
      const lock = await readLockFile();
      expect(lock).toBeNull();
    });

    it("--dry-run prints command but does not execute or update lock", async () => {
      await writeSourceFile("src/a.ts", 'export const a = "hello";');

      await writeConfig(
        "derive.jsonc",
        JSON.stringify({
          runner: 'echo "{prompt}" > output.txt',
          tasks: {
            test: {
              prompt: "Describe the code",
              sources: ["src/**/*.ts"],
            },
          },
        })
      );

      const { exitCode, stdout } = await runCli(["--dry-run"]);

      expect(exitCode).toBe(0);
      expect(stdout).toContain("would run");
      expect(stdout).toContain("echo");

      // Runner should not have executed
      const outputExists = await fileExists("output.txt");
      expect(outputExists).toBe(false);

      // Lock should not be created
      const lock = await readLockFile();
      expect(lock).toBeNull();
    });

    it("--force flag runs task even when no changes detected", async () => {
      await writeSourceFile("src/a.ts", 'export const a = "hello";');

      await writeConfig(
        "derive.jsonc",
        JSON.stringify({
          runner: 'echo "{prompt}" > output.txt',
          tasks: {
            test: {
              prompt: "Describe the code",
              sources: ["src/**/*.ts"],
            },
          },
        })
      );

      // First run to populate lock
      await runCli();

      // Remove output to verify runner re-executes with --force
      await rm(join(tempDir, "output.txt"));

      // Second run with --force
      const { exitCode, stdout } = await runCli(["--force"]);

      expect(exitCode).toBe(0);
      expect(stdout).toContain("forced run");

      const outputExists = await fileExists("output.txt");
      expect(outputExists).toBe(true);
    });

    it("--init creates starter derive.jsonc", async () => {
      const { exitCode, stdout } = await runCli(["--init"]);

      expect(exitCode).toBe(0);
      expect(stdout).toContain("created derive.jsonc");

      const configExists = await fileExists("derive.jsonc");
      expect(configExists).toBe(true);

      const content = await readFile(join(tempDir, "derive.jsonc"), "utf-8");
      expect(content).toContain("runner");
      expect(content).toContain("tasks");
      expect(content).toContain("{prompt}");
    });

    it("--init fails if config already exists", async () => {
      await writeConfig("derive.jsonc", "{}");

      const { exitCode, stderr } = await runCli(["--init"]);

      expect(exitCode).toBe(1);
      expect(stderr).toContain("already exists");
    });

    it("--help prints usage", async () => {
      const { exitCode, stdout } = await runCli(["--help"]);

      expect(exitCode).toBe(0);
      expect(stdout).toContain("Usage:");
      expect(stdout).toContain("derive");
      expect(stdout).toContain("--force");
      expect(stdout).toContain("--dry-run");
      expect(stdout).toContain("--status");
      expect(stdout).toContain("--init");
      expect(stdout).toContain("--config");
      expect(stdout).toContain("--version");
    });

    it("--version prints version", async () => {
      const { exitCode, stdout } = await runCli(["--version"]);

      expect(exitCode).toBe(0);
      expect(stdout).toMatch(VERSION_PATTERN);
    });
  });

  describe("config format tests", () => {
    it("works with derive.jsonc config", async () => {
      await writeSourceFile("src/a.ts", 'export const a = "hello";');

      await writeConfig(
        "derive.jsonc",
        `{
          // This is a comment
          "runner": "echo \\"{prompt}\\" > output.txt",
          "tasks": {
            "test": {
              "prompt": "Describe",
              "sources": ["src/**/*.ts"]
            }
          }
        }`
      );

      const { exitCode, stdout } = await runCli();

      expect(exitCode).toBe(0);
      expect(stdout).toContain("loaded derive.jsonc");
    });

    it("works with derive.json config", async () => {
      await writeSourceFile("src/a.ts", 'export const a = "hello";');

      await writeConfig(
        "derive.json",
        JSON.stringify({
          runner: 'echo "{prompt}" > output.txt',
          tasks: {
            test: {
              prompt: "Describe",
              sources: ["src/**/*.ts"],
            },
          },
        })
      );

      const { exitCode, stdout } = await runCli();

      expect(exitCode).toBe(0);
      expect(stdout).toContain("loaded derive.json");
    });

    it("works with derive.toml config", async () => {
      await writeSourceFile("src/a.ts", 'export const a = "hello";');

      await writeConfig(
        "derive.toml",
        `runner = 'echo "{prompt}" > output.txt'

[tasks.test]
prompt = "Describe"
sources = ["src/**/*.ts"]
`
      );

      const { exitCode, stdout } = await runCli();

      expect(exitCode).toBe(0);
      expect(stdout).toContain("loaded derive.toml");
    });
  });

  describe("error handling", () => {
    it("exits with error when no config file found", async () => {
      const { exitCode, stderr } = await runCli();

      expect(exitCode).toBe(2);
      expect(stderr).toContain("no config file found");
    });

    it("exits with error for unknown task name", async () => {
      await writeSourceFile("src/a.ts", 'export const a = "hello";');

      await writeConfig(
        "derive.jsonc",
        JSON.stringify({
          runner: 'echo "{prompt}"',
          tasks: {
            test: {
              prompt: "Describe",
              sources: ["src/**/*.ts"],
            },
          },
        })
      );

      const { exitCode, stderr } = await runCli(["nonexistent"]);

      expect(exitCode).toBe(1);
      expect(stderr).toContain("unknown task");
    });

    it("exits with error for unknown flag", async () => {
      const { exitCode, stderr } = await runCli(["--unknown-flag"]);

      expect(exitCode).toBe(1);
      expect(stderr).toContain("Unknown option");
    });

    it("handles runner failure gracefully", async () => {
      await writeSourceFile("src/a.ts", 'export const a = "hello";');

      await writeConfig(
        "derive.jsonc",
        JSON.stringify({
          runner: "exit 1 # {prompt}",
          tasks: {
            test: {
              prompt: "Describe",
              sources: ["src/**/*.ts"],
            },
          },
        })
      );

      const { exitCode, stderr } = await runCli();

      expect(exitCode).toBe(1);
      expect(stderr).toContain("failed");
    });
  });

  describe("task-specific execution", () => {
    it("runs only specified task when task name provided", async () => {
      await writeSourceFile("src/a.ts", 'export const a = "hello";');

      await writeConfig(
        "derive.jsonc",
        JSON.stringify({
          runner: 'echo "{prompt}" > output-$TASK.txt',
          tasks: {
            task1: {
              prompt: "Task 1",
              sources: ["src/**/*.ts"],
              runner: 'echo "task1 {prompt}" > output-task1.txt',
            },
            task2: {
              prompt: "Task 2",
              sources: ["src/**/*.ts"],
              runner: 'echo "task2 {prompt}" > output-task2.txt',
            },
          },
        })
      );

      const { exitCode, stdout } = await runCli(["task1"]);

      expect(exitCode).toBe(0);
      expect(stdout).toContain("task1");

      const task1Exists = await fileExists("output-task1.txt");
      const task2Exists = await fileExists("output-task2.txt");

      expect(task1Exists).toBe(true);
      expect(task2Exists).toBe(false);
    });
  });

  describe("custom config path", () => {
    it("--config uses specified config file", async () => {
      await writeSourceFile("src/a.ts", 'export const a = "hello";');

      const configDir = join(tempDir, "configs");
      await mkdir(configDir, { recursive: true });

      const customConfig = join(configDir, "custom.json");
      await writeFile(
        customConfig,
        JSON.stringify({
          runner: 'echo "{prompt}" > output.txt',
          tasks: {
            custom: {
              prompt: "Custom task",
              sources: ["src/**/*.ts"],
            },
          },
        })
      );

      const { exitCode, stdout } = await runCli(["--config", customConfig]);

      expect(exitCode).toBe(0);
      expect(stdout).toContain("custom.json");
      expect(stdout).toContain("custom");
    });
  });

  describe("lock file behavior", () => {
    it("creates lock file in same directory as config", async () => {
      await writeSourceFile("src/a.ts", 'export const a = "hello";');

      await writeConfig(
        "derive.jsonc",
        JSON.stringify({
          runner: 'echo "{prompt}" > output.txt',
          tasks: {
            test: {
              prompt: "Describe",
              sources: ["src/**/*.ts"],
            },
          },
        })
      );

      await runCli();

      const lock = await readLockFile();
      expect(lock).not.toBeNull();
      expect(lock?.version).toBe(1);
      expect(lock?.tasks).toBeDefined();

      const testTask = (lock?.tasks as Record<string, unknown>)?.test as Record<
        string,
        unknown
      >;
      expect(testTask).toBeDefined();
      expect(testTask?.last_run).toBeDefined();
      expect(testTask?.sources_hash).toMatch(SHA256_PATTERN);
      expect(testTask?.files).toBeDefined();
    });

    it("preserves lock entries for tasks not run", async () => {
      await writeSourceFile("src/a.ts", 'export const a = "hello";');

      await writeConfig(
        "derive.jsonc",
        JSON.stringify({
          runner: 'echo "{prompt}" > output.txt',
          tasks: {
            task1: {
              prompt: "Task 1",
              sources: ["src/**/*.ts"],
            },
            task2: {
              prompt: "Task 2",
              sources: ["src/**/*.ts"],
            },
          },
        })
      );

      // Run all tasks first
      await runCli();

      const lockAfterFirstRun = await readLockFile();
      const task2Entry = (lockAfterFirstRun?.tasks as Record<string, unknown>)
        ?.task2;

      // Run only task1 with force
      await runCli(["--force", "task1"]);

      const lockAfterSecondRun = await readLockFile();
      const task2EntryAfter = (
        lockAfterSecondRun?.tasks as Record<string, unknown>
      )?.task2;

      // task2 entry should be preserved
      expect(task2EntryAfter).toEqual(task2Entry);
    });
  });

  describe("glob patterns", () => {
    it("matches files using glob patterns", async () => {
      await writeSourceFile("src/a.ts", 'export const a = "a";');
      await writeSourceFile("src/nested/b.ts", 'export const b = "b";');
      await writeSourceFile("src/nested/deep/c.ts", 'export const c = "c";');
      await writeSourceFile("other/d.ts", 'export const d = "d";');

      await writeConfig(
        "derive.jsonc",
        JSON.stringify({
          runner: 'echo "{prompt}" > output.txt',
          tasks: {
            test: {
              prompt: "Describe",
              sources: ["src/**/*.ts"],
            },
          },
        })
      );

      const { exitCode, stdout } = await runCli(["--status"]);

      expect(exitCode).toBe(0);
      expect(stdout).toContain("changed");
      expect(stdout).toContain("3 files");
    });

    it("excludes files matching exclude patterns", async () => {
      await writeSourceFile("src/a.ts", 'export const a = "a";');
      await writeSourceFile("src/a.test.ts", "test");
      await writeSourceFile("src/b.ts", 'export const b = "b";');

      await writeConfig(
        "derive.jsonc",
        JSON.stringify({
          runner: 'echo "{prompt}" > output.txt',
          tasks: {
            test: {
              prompt: "Describe",
              sources: ["src/**/*.ts"],
              exclude: ["**/*.test.ts"],
            },
          },
        })
      );

      const { exitCode, stdout } = await runCli(["--status"]);

      expect(exitCode).toBe(0);
      expect(stdout).toContain("2 files");
    });
  });
});
