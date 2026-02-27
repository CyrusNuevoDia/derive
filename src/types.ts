/**
 * The resolved, validated configuration shape.
 * Represents the parsed and validated llmake configuration.
 */
export interface LlmakeConfig {
  /** The default runner command to execute for code generation tasks. */
  runner: string;
  /** Map of task names to their configurations. */
  tasks: Record<string, TaskConfig>;
}

/**
 * Configuration for a single llmake task.
 * Defines what files to process and how to generate code from them.
 */
export interface TaskConfig {
  /** The prompt template or instruction for the code generation. */
  prompt: string;
  /** Glob patterns for source files to include. */
  sources: string[];
  /** Optional glob patterns for files to exclude from sources. */
  exclude?: string[];
  /** Optional runner override for this specific task. */
  runner?: string;
}

/**
 * The .llmake.lock file shape.
 * Tracks the state of generated files for incremental builds.
 */
export interface LlmakeLock {
  /** Lock file format version for future compatibility. */
  version: 1;
  /** Map of task names to their lock entries. */
  tasks: Record<string, TaskLockEntry>;
}

/**
 * Lock entry for a single task.
 * Records when the task was last run and the state of its source files.
 */
export interface TaskLockEntry {
  /** ISO 8601 timestamp of when the task was last executed. */
  last_run: string;
  /** Combined hash of all source file contents in format "sha256:<hex>". */
  sources_hash: string;
  /** Map of file paths to their content hashes in format "sha256:<hex>". */
  files: Record<string, string>;
}

/**
 * Result of diffing current state against lockfile.
 * Used to determine which files need regeneration.
 */
export interface TaskDiff {
  /** The name of the task being diffed. */
  task: string;
  /** Whether any source files have changed since the last run. */
  changed: boolean;
  /** Paths to files that are new or have been modified. */
  changed_files: string[];
  /** Paths to files that were in the lock but no longer match globs. */
  removed_files: string[];
  /** All files currently matched by the task's source globs. */
  all_files: string[];
}
