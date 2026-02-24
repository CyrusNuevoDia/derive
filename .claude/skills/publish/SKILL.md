# Publish to npm

Publish `make-derive` to npm.

## Prerequisites

- Logged in to npm (`npm whoami` to check)
- All tests pass (`bun test`)
- Code passes lint (`bun x ultracite check`)

## Steps

1. **Bump version** in `package.json` and update `VERSION` constant in `src/index.ts` to match
2. **Run checks**: `bun test && bun run typecheck && bun x ultracite check`
3. **Build**: `bun run build` (also runs automatically via `prepublishOnly`)
4. **Verify package contents**: `npm pack --dry-run` — should contain only `dist/derive.js`, `README.md`, `LICENSE`, `package.json`
5. **Test the built artifact**: `./dist/derive.js --version` should print the new version
6. **Publish**: `npm publish`
7. **Verify install**: `bun add -g make-derive@<version>` then `derive --version`

## How the build works

`bun build src/index.ts --outfile dist/derive.js --target node --minify` bundles all source files and all dependencies (`shescape`, `smol-toml`, `zod`, `fast-glob`, `strip-json-comments`) into a single minified JS file with `#!/usr/bin/env node` shebang. This means:

- No runtime `dependencies` needed — everything is inlined
- All deps are in `devDependencies` (needed only at build time)
- Works with Node.js, Bun, or any Node-compatible runtime
- Published package is ~90KB compressed
- Installable via `npm`, `bun`, or `pnpm`; runnable via `npx`, `bunx`, or `pnpx`

## Version checklist

When bumping versions, update both locations:

- `package.json` → `"version"`
- `src/index.ts` → `const VERSION`
