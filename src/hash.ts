import { CryptoHasher, file, Glob } from "bun";

/**
 * Hash a file using SHA-256 streaming to avoid OOM on large files.
 * @param path - Path to the file to hash
 * @returns Promise resolving to "sha256:<hex>" format hash
 */
export async function hashFile(path: string): Promise<string> {
  const bunFile = file(path);
  const hasher = new CryptoHasher("sha256");
  const stream = bunFile.stream();
  for await (const chunk of stream) {
    hasher.update(chunk);
  }
  return `sha256:${hasher.digest("hex")}`;
}

/**
 * Compute Merkle root from file hashes.
 * Sorts paths lexicographically and hashes "path:hash\n" for each entry.
 * @param fileHashes - Record mapping file paths to their hashes
 * @returns Merkle root in "sha256:<hex>" format
 */
export function computeMerkleRoot(fileHashes: Record<string, string>): string {
  const hasher = new CryptoHasher("sha256");
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
  const matched = new Set<string>();

  for (const pattern of sources) {
    const glob = new Glob(pattern);
    for await (const path of glob.scan({ cwd: process.cwd(), dot: false })) {
      matched.add(path);
    }
  }

  for (const pattern of exclude) {
    const glob = new Glob(pattern);
    for await (const path of glob.scan({ cwd: process.cwd(), dot: false })) {
      matched.delete(path);
    }
  }

  return [...matched].sort();
}
