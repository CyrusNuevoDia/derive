import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import fg from "fast-glob";

/**
 * Hash a file using SHA-256 streaming to avoid OOM on large files.
 * @param path - Path to the file to hash
 * @returns Promise resolving to "sha256:<hex>" format hash
 */
export async function hashFile(path: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hasher = createHash("sha256");
    const stream = createReadStream(path);
    stream.on("data", (chunk) => hasher.update(chunk));
    stream.on("end", () => resolve(`sha256:${hasher.digest("hex")}`));
    stream.on("error", reject);
  });
}

/**
 * Compute Merkle root from file hashes.
 * Sorts paths lexicographically and hashes "path:hash\n" for each entry.
 * @param fileHashes - Record mapping file paths to their hashes
 * @returns Merkle root in "sha256:<hex>" format
 */
export function computeMerkleRoot(fileHashes: Record<string, string>): string {
  const hasher = createHash("sha256");
  const sortedPaths = Object.keys(fileHashes).sort();
  for (const path of sortedPaths) {
    hasher.update(`${path}:${fileHashes[path]}\n`);
  }
  return `sha256:${hasher.digest("hex")}`;
}

/**
 * Resolve glob patterns to a list of files.
 * Applies exclusions and returns sorted, deduplicated file list.
 * @param sources - Array of glob patterns to match
 * @param exclude - Array of glob patterns to exclude
 * @returns Promise resolving to sorted array of unique file paths
 */
export async function resolveFiles(
  sources: string[],
  exclude: string[] = []
): Promise<string[]> {
  const files = await fg(sources, {
    cwd: process.cwd(),
    dot: false,
    ignore: exclude,
  });
  return [...new Set(files)].sort();
}
