import { access, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { parse as parseToml } from "smol-toml";
import stripJsonComments from "strip-json-comments";
import { z } from "zod";
import type { DeriveConfig } from "./types";

const CONFIG_FILES = [
  "derive.ts",
  "derive.jsonc",
  "derive.json",
  "derive.toml",
] as const;

const TaskConfigSchema = z
  .object({
    prompt: z.string().min(1, "prompt must not be empty"),
    sources: z.array(z.string()).min(1, "sources must not be empty"),
    exclude: z.array(z.string()).optional(),
    runner: z
      .string()
      .refine(
        (s) => s.includes("{prompt}"),
        "runner must contain {prompt} placeholder"
      )
      .optional(),
  })
  .passthrough();

const DeriveConfigSchema = z
  .object({
    runner: z
      .string()
      .min(1, "runner must not be empty")
      .refine(
        (s) => s.includes("{prompt}"),
        "runner must contain {prompt} placeholder"
      ),
    tasks: z
      .record(z.string(), TaskConfigSchema)
      .refine((t) => Object.keys(t).length > 0, "tasks must not be empty"),
  })
  .passthrough();

async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

export async function discoverConfig(cwd?: string): Promise<string | null> {
  const dir = cwd ?? process.cwd();

  for (const filename of CONFIG_FILES) {
    const filepath = resolve(dir, filename);
    if (await fileExists(filepath)) {
      return filepath;
    }
  }

  return null;
}

export async function loadConfig(path: string): Promise<DeriveConfig> {
  const ext = path.split(".").pop()?.toLowerCase();

  if (ext === "ts") {
    const module = await import(resolve(path));
    const raw =
      typeof module.default === "function"
        ? await module.default()
        : module.default;
    return validateConfig(raw);
  }

  const text = await readFile(path, "utf-8");

  if (ext === "json" || ext === "jsonc") {
    return validateConfig(JSON.parse(stripJsonComments(text)));
  }

  if (ext === "toml") {
    return validateConfig(parseToml(text));
  }

  throw new Error(`derive: unsupported config format: ${ext}`);
}

export function validateConfig(raw: unknown): DeriveConfig {
  const result = DeriveConfigSchema.safeParse(raw);

  if (!result.success) {
    const issue = result.error.issues[0];
    const path = issue.path.length > 0 ? ` in "${issue.path.join(".")}"` : "";
    throw new Error(`derive: config error${path}: ${issue.message}`);
  }

  return result.data;
}
