import { Shescape } from "shescape";

/**
 * Build an XML-formatted prompt combining user prompt and changed files.
 */
export function assemblePrompt(
  userPrompt: string,
  changedFiles: string[]
): string {
  return [
    `<prompt>${userPrompt}</prompt>`,
    `<changed-files>${changedFiles.join(", ")}</changed-files>`,
  ].join("\n");
}

/**
 * Execute a runner template as a login shell command.
 * Uses -l -i flags to ensure user's PATH is loaded from .zshrc/.bashrc.
 */
export async function executeRunner(
  runnerTemplate: string,
  prompt: string
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const shell = process.env.SHELL || "/bin/sh";
  const shescape = new Shescape({ shell });
  const quoted = shescape.quote(prompt);
  const command = runnerTemplate.replace("{prompt}", quoted);

  const proc = Bun.spawn([shell, "-l", "-i", "-c", command], {
    cwd: process.cwd(),
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
    env: {
      ...process.env,
      FORCE_COLOR: "1",
    },
  });

  const exitCode = await proc.exited;
  return { exitCode, stdout: "", stderr: "" };
}
