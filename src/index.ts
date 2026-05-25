#!/usr/bin/env node

import { access, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { parseArgs } from "node:util";
import { discoverConfig, loadConfig } from "./config";
import { computeMerkleRoot, hashFile, resolveFiles } from "./hash";
import { diffTask, readLock, writeLock } from "./lock";
import { assemblePrompt, executeRunner } from "./runner";
import type {
  DeriveConfig,
  DeriveLock,
  TaskConfig,
  TaskDiff,
  TaskLockEntry,
} from "./types";

const VERSION = "0.1.1";

const HELP = `derive ${VERSION}

Usage:
  derive                     Run all tasks with changes
  derive <task>              Run specific task if changed
  derive --force [task]      Run regardless of hash state
  derive --dry-run [task]    Show what would run
  derive --status            Show per-task change status
  derive --init              Write starter derive.jsonc
  derive --config <path>     Use specific config file
  derive --help              Print this help
  derive --version           Print version
`;

const STARTER_CONFIG = `{
  // Default runner command - {prompt} will be replaced with the assembled prompt
  "runner": "claude --allowed-tools Read,Write,Edit --print {prompt}",
  "tasks": {
    "example": {
      "prompt": "Describe what this code does",
      "sources": ["src/**/*.ts"]
    }
  }
}
`;

interface Args {
  help: boolean;
  version: boolean;
  force: boolean;
  dryRun: boolean;
  status: boolean;
  init: boolean;
  configPath?: string;
  task?: string;
}

function parseCliArgs(): Args {
  const { values, positionals } = parseArgs({
    args: process.argv.slice(2),
    options: {
      help: { type: "boolean", short: "h", default: false },
      version: { type: "boolean", short: "v", default: false },
      force: { type: "boolean", short: "f", default: false },
      "dry-run": { type: "boolean", short: "n", default: false },
      status: { type: "boolean", short: "s", default: false },
      init: { type: "boolean", default: false },
      config: { type: "string", short: "c" },
    },
    allowPositionals: true,
    strict: true,
  });

  return {
    help: values.help ?? false,
    version: values.version ?? false,
    force: values.force ?? false,
    dryRun: values["dry-run"] ?? false,
    status: values.status ?? false,
    init: values.init ?? false,
    configPath: values.config,
    task: positionals[0],
  };
}

async function handleInit(): Promise<void> {
  const configPath = resolve(process.cwd(), "derive.jsonc");
  try {
    await access(configPath);
    console.error("derive: derive.jsonc already exists");
    process.exit(1);
  } catch {
    // File doesn't exist, proceed
  }
  await writeFile(configPath, STARTER_CONFIG);
  console.log("derive: created derive.jsonc");
}

async function loadAndValidateConfig(
  configPath?: string
): Promise<{ config: DeriveConfig; path: string }> {
  const resolvedPath = configPath
    ? resolve(configPath)
    : await discoverConfig();

  if (!resolvedPath) {
    console.error(
      "derive: no config file found (derive.ts, derive.jsonc, derive.json, derive.toml)"
    );
    process.exit(2);
  }

  try {
    return { config: await loadConfig(resolvedPath), path: resolvedPath };
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}

interface TaskContext {
  name: string;
  config: TaskConfig;
  runner: string;
  fileHashes: Record<string, string>;
  merkleRoot: string;
  diff: TaskDiff;
}

async function prepareTask(
  name: string,
  config: DeriveConfig,
  lock: DeriveLock
): Promise<TaskContext | null> {
  const taskConfig = config.tasks[name];
  const files = await resolveFiles(taskConfig.sources, taskConfig.exclude);

  if (files.length === 0) {
    console.log(`derive: ${name} — no files matched`);
    return null;
  }

  const fileHashes: Record<string, string> = {};
  for (const file of files) {
    fileHashes[file] = await hashFile(file);
  }

  const merkleRoot = computeMerkleRoot(fileHashes);
  const diff = diffTask(name, fileHashes, merkleRoot, lock.tasks[name]);

  return {
    name,
    config: taskConfig,
    runner: taskConfig.runner ?? config.runner,
    fileHashes,
    merkleRoot,
    diff,
  };
}

function handleStatus(ctx: TaskContext): void {
  if (ctx.diff.changed) {
    const count = ctx.diff.changed_files.length + ctx.diff.removed_files.length;
    console.log(`derive: ${ctx.name} — changed (${count} files)`);
  } else {
    console.log(`derive: ${ctx.name} — up to date`);
  }
}

function handleDryRun(ctx: TaskContext, force: boolean): void {
  if (ctx.diff.changed || force) {
    console.log(
      `derive: ${ctx.name} — would run: ${ctx.runner.replace("{prompt}", "...")}`
    );
  } else {
    console.log(`derive: ${ctx.name} — no changes, would skip`);
  }
}

async function runTask(
  ctx: TaskContext,
  force: boolean
): Promise<TaskLockEntry | null> {
  if (!(ctx.diff.changed || force)) {
    console.log(`derive: ${ctx.name} — no changes`);
    return null;
  }

  logChanges(ctx, force);

  console.log(
    `derive: ${ctx.name} — running: ${ctx.runner.replace("{prompt}", "...")}`
  );

  const prompt = assemblePrompt(ctx.config.prompt, ctx.diff.changed_files);
  const start = performance.now();
  const result = await executeRunner(ctx.runner, prompt);
  const elapsed = ((performance.now() - start) / 1000).toFixed(1);

  if (result.exitCode !== 0) {
    console.error(
      `derive: ${ctx.name} — failed (exit ${result.exitCode}, ${elapsed}s)`
    );
    return null;
  }

  console.log(`derive: ${ctx.name} — done (${elapsed}s)`);

  return {
    last_run: new Date().toISOString(),
    sources_hash: ctx.merkleRoot,
    files: ctx.fileHashes,
  };
}

function logChanges(ctx: TaskContext, force: boolean): void {
  if (ctx.diff.changed_files.length > 0) {
    const list = ctx.diff.changed_files.slice(0, 3).join(", ");
    const more =
      ctx.diff.changed_files.length > 3
        ? `, +${ctx.diff.changed_files.length - 3} more`
        : "";
    console.log(
      `derive: ${ctx.name} — ${ctx.diff.changed_files.length} files changed (${list}${more})`
    );
  } else if (force) {
    console.log(`derive: ${ctx.name} — forced run`);
  }
}

async function processTasks(
  taskNames: string[],
  config: DeriveConfig,
  lock: DeriveLock,
  args: Args
): Promise<{ updatedLock: DeriveLock; anyFailed: boolean }> {
  const updatedLock: DeriveLock = { version: 1, tasks: { ...lock.tasks } };
  let anyFailed = false;

  for (const taskName of taskNames) {
    const ctx = await prepareTask(taskName, config, lock);
    if (!ctx) {
      continue;
    }

    if (args.status) {
      handleStatus(ctx);
      continue;
    }

    if (args.dryRun) {
      handleDryRun(ctx, args.force);
      continue;
    }

    const lockEntry = await runTask(ctx, args.force);
    if (lockEntry) {
      updatedLock.tasks[taskName] = lockEntry;
    } else if (ctx.diff.changed || args.force) {
      anyFailed = true;
    }
  }

  return { updatedLock, anyFailed };
}

async function main(): Promise<void> {
  let args: Args;
  try {
    args = parseCliArgs();
  } catch (error) {
    console.error(
      `derive: ${error instanceof Error ? error.message : String(error)}`
    );
    process.exit(1);
  }

  if (args.help) {
    console.log(HELP);
    process.exit(0);
  }
  if (args.version) {
    console.log(VERSION);
    process.exit(0);
  }
  if (args.init) {
    await handleInit();
    process.exit(0);
  }

  const { config, path: configPath } = await loadAndValidateConfig(
    args.configPath
  );
  const taskNames = Object.keys(config.tasks);
  const lockPath = resolve(dirname(configPath), ".derive.lock");

  console.log(
    `derive: loaded ${configPath.split("/").pop()} (${taskNames.length} tasks)`
  );

  if (args.task && !(args.task in config.tasks)) {
    console.error(`derive: unknown task: ${args.task}`);
    process.exit(1);
  }

  const lock = await readLock(lockPath);
  const tasksToProcess = args.task ? [args.task] : taskNames;

  const { updatedLock, anyFailed } = await processTasks(
    tasksToProcess,
    config,
    lock,
    args
  );

  if (!(args.status || args.dryRun)) {
    await writeLock(lockPath, updatedLock);
  }

  process.exit(anyFailed ? 1 : 0);
}

main().catch((error) => {
  console.error(
    `derive: ${error instanceof Error ? error.message : String(error)}`
  );
  process.exit(1);
});
