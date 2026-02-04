import type { DeriveLock, TaskDiff, TaskLockEntry } from "./types";

/**
 * Read the lockfile from disk.
 * Returns an empty lock structure if the file doesn't exist.
 */
export async function readLock(lockPath: string): Promise<DeriveLock> {
  const file = Bun.file(lockPath);
  if (!(await file.exists())) {
    return { version: 1, tasks: {} };
  }
  return await file.json();
}

/**
 * Write the lockfile to disk as formatted JSON with a trailing newline.
 */
export async function writeLock(
  lockPath: string,
  lock: DeriveLock
): Promise<void> {
  await Bun.write(lockPath, `${JSON.stringify(lock, null, 2)}\n`);
}

/**
 * Diff current task state against the lockfile entry.
 * Uses Merkle root for fast-path comparison, falls back to per-file diff.
 */
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
