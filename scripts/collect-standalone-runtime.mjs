#!/usr/bin/env node
/**
 * Collect the standalone service's runtime file closure into one directory.
 *
 * The standalone product (`packages/standalone`) is a plain Node program: it
 * imports from `src/` and `vendor/`, reads its own web assets, and runs a
 * channel worker. Nothing in it needs a build step, so the image does not need
 * one either — but a container that copies the whole repository would ship the
 * DSH plugin half, the desktop shell, the test suites and the documentation,
 * none of which the standalone service ever loads.
 *
 * So the image carries exactly the closure: the files the service actually
 * reads at runtime. This script computes that closure from the source instead
 * of from a hand-written list, because a hand-written list silently rots the
 * first time upstream adds a module — the image would then fail at runtime with
 * a module-not-found that no build step would have caught.
 *
 * The closure is computed from three sources of truth:
 *
 *   1. static and dynamic `import`/`export ... from` edges;
 *   2. `new URL('./x', import.meta.url)` references, which is how the service
 *      reaches its own web assets, its package.json and the channel pack's
 *      WASM module;
 *   3. the channel worker entry, which is loaded through `new Worker(new URL(...))`
 *      and therefore has no import edge to follow.
 *
 * Usage: node scripts/collect-standalone-runtime.mjs <output-directory>
 */
import fs from 'node:fs'
import path from 'node:path'
import { builtinModules } from 'node:module'
import { fileURLToPath } from 'node:url'

const repositoryRoot = fileURLToPath(new URL('..', import.meta.url))

/** Node's own modules, with and without the `node:` prefix. */
const BUILTINS = new Set(builtinModules)

/** The program's entry point. */
const ENTRY = 'packages/standalone/cli.mjs'

/**
 * Entry points that are reached by something other than an import edge.
 * The channel worker is spawned through `new Worker(new URL('./worker.mjs'))`,
 * which never appears in the module graph as a static import.
 */
const EXTRA_ROOTS = ['packages/standalone/channels/worker.mjs']

/**
 * Directories copied whole rather than followed file by file. The web assets
 * are addressed by a build-time manifest (`web/assets.json`) that the service
 * validates at startup, and the asset filenames carry content hashes, so a
 * stale extra file in the source tree is harmless — while a *missing* one is
 * not. Copying the directory keeps the manifest and the directory in step.
 */
const COPY_WHOLE = [
  'packages/standalone/web',
  'vendor/channel-pack',
]

/** Files copied whole even though they are reached through a URL reference. */
const COPY_WHOLE_FILES = ['LICENSE']

const exists = file => fs.existsSync(file) && fs.statSync(file).isFile()

/** Resolve a relative specifier to a file, the way Node's ESM resolver does. */
function resolveSpecifier(specifier, fromFile) {
  const base = path.resolve(path.dirname(fromFile), specifier)
  const candidates = [
    base,
    `${base}.js`,
    `${base}.mjs`,
    `${base}.cjs`,
    path.join(base, 'index.js'),
    path.join(base, 'index.mjs'),
  ]
  for (const candidate of candidates) if (exists(candidate)) return candidate
  return null
}

/**
 * Strip comments before scanning for specifiers.
 *
 * The channel pack is a generated bundle that carries the original
 * TypeScript's JSDoc annotations verbatim, and those annotations are full of
 * `import('./client.js')` type references to files that exist only in the
 * bundle's own sources. Following them would report a pile of missing files
 * and pull the bundle's TypeScript sources into the image. Comments cannot
 * hold a real import, so removing them is the honest way to read the file.
 */
function stripComments(text) {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1')
}

/**
 * Every specifier a module mentions, from imports and from URL references.
 *
 * The patterns are anchored to the start of a statement. A lazy pattern that
 * starts at any `import` word and scans forward to the next `from '...'` will
 * happily cross a string literal and report the tail of an error message as a
 * module specifier — which is how a generated bundle ends up with a phantom
 * dependency. Anchoring keeps each match inside one statement.
 */
function specifiersOf(source) {
  const found = new Set()
  const patterns = [
    // import ... from '...' / export ... from '...', possibly spanning lines.
    // The character class refuses quotes and semicolons, so a match cannot run
    // past the end of the statement it started in.
    { pattern: /^\s*(?:import|export)\b[^;'"]*?\bfrom\s*['"]([^'"]+)['"]/gm, group: 1 },
    // Side-effect import: import '...'
    { pattern: /^\s*import\s+['"]([^'"]+)['"]/gm, group: 1 },
    // Dynamic import: import('...')
    { pattern: /^\s*import\s*\(\s*['"]([^'"]+)['"]\s*\)/gm, group: 1 },
    // Asset reference relative to the module: new URL('./x', import.meta.url)
    { pattern: /new\s+URL\(\s*(['"])([^'"]+)\1\s*,\s*import\.meta\.url\s*\)/g, group: 2 },
  ]
  for (const { pattern, group } of patterns) {
    let match
    while ((match = pattern.exec(source)) !== null) found.add(match[group])
  }
  return [...found]
}

/**
 * Data files a module reads at runtime, relative to the module's own
 * directory. These are not imports — Node never sees them — but the service
 * cannot start without them, so the closure must carry them.
 *
 * `registry.json` is the aggregate lane's provider table: the registry
 * module resolves it next to itself and reads it with `readFileSync`, so a
 * closure built from import edges alone ships the module and not its table.
 */
const DATA_FILES = [
  { from: 'src/providers/index.js', file: 'registry.json' },
]

function collect() {
  const seen = new Set()
  const unresolved = []
  const queue = [path.join(repositoryRoot, ENTRY), ...EXTRA_ROOTS.map(file => path.join(repositoryRoot, file))]

  while (queue.length > 0) {
    const file = queue.pop()
    if (seen.has(file)) continue
    seen.add(file)
    if (!exists(file)) {
      unresolved.push(path.relative(repositoryRoot, file))
      continue
    }
    const text = stripComments(fs.readFileSync(file, 'utf8'))
    for (const specifier of specifiersOf(text)) {
      if (specifier.startsWith('node:')) continue
      if (!specifier.startsWith('.')) {
        // A bare specifier would be a third-party dependency. The standalone
        // service has none by design, so one appearing here means the service
        // grew a dependency and the image needs an install step — say so
        // instead of shipping an image that fails at runtime.
        if (BUILTINS.has(specifier)) continue
        unresolved.push(`bare specifier "${specifier}" in ${path.relative(repositoryRoot, file)}`)
        continue
      }
      const resolved = resolveSpecifier(specifier, file)
      if (resolved === null) {
        // Not every new URL() reference is a file: a URL built from a route
        // template is not. Only complain when the reference looks like a path.
        if (!/^[./]/.test(specifier) || !/\.[a-z0-9]+$/i.test(specifier.split('?')[0].split('#')[0])) continue
        unresolved.push(`${path.relative(repositoryRoot, file)} -> ${specifier}`)
        continue
      }
      queue.push(resolved)
    }
  }

  // Attach each data file to the module that reads it, so it travels with it.
  for (const { from, file } of DATA_FILES) {
    const owner = path.join(repositoryRoot, from)
    if (!exists(owner)) {
      unresolved.push(`data file owner missing: ${from}`)
      continue
    }
    const data = path.join(path.dirname(owner), file)
    if (!exists(data)) {
      unresolved.push(`data file missing: ${from} -> ${file}`)
      continue
    }
    seen.add(data)
  }

  return { files: [...seen].map(file => path.relative(repositoryRoot, file).replace(/\\/g, '/')).sort(), unresolved }
}

/** Copy one file, preserving its bytes exactly. */
function copyFile(relative, from, to) {
  const target = path.join(to, relative)
  fs.mkdirSync(path.dirname(target), { recursive: true })
  fs.copyFileSync(path.join(from, relative), target)
}

/** Copy a directory tree, skipping the parts that never ship. */
function copyTree(relative, from, to) {
  const source = path.join(from, relative)
  const target = path.join(to, relative)
  fs.mkdirSync(target, { recursive: true })
  for (const entry of fs.readdirSync(source, { withFileTypes: true })) {
    const child = `${relative}/${entry.name}`
    if (entry.isDirectory()) {
      // The channel pack's TypeScript sources are the *input* to the bundled
      // pack.js the service actually loads. Shipping both doubles the image
      // for no runtime gain.
      if (child === 'vendor/channel-pack/src' || child === 'vendor/channel-pack/scripts') continue
      copyTree(child, from, to)
    } else if (entry.isFile()) {
      copyFile(child, from, to)
    }
  }
}

function main() {
  const output = process.argv[2]
  if (!output) {
    process.stderr.write('usage: node scripts/collect-standalone-runtime.mjs <output-directory>\n')
    process.exitCode = 1
    return
  }
  const destination = path.resolve(output)
  fs.rmSync(destination, { recursive: true, force: true })
  fs.mkdirSync(destination, { recursive: true })

  const { files, unresolved } = collect()
  for (const relative of files) copyFile(relative, repositoryRoot, destination)
  for (const relative of COPY_WHOLE) copyTree(relative, repositoryRoot, destination)
  for (const relative of COPY_WHOLE_FILES) copyFile(relative, repositoryRoot, destination)

  // The service resolves its data directory from OFM_HOME and its own home
  // directory; neither is a source file, but the CLI reads the package version
  // from packages/standalone/package.json, which the closure already covers.
  const total = files.length
  process.stdout.write(`collected ${total} runtime files into ${destination}\n`)
  if (unresolved.length > 0) {
    // A bare specifier means a dependency appeared; a missing file means the
    // closure is wrong. Either way the image would break at runtime, so this
    // must fail the build rather than warn.
    process.stderr.write(`unresolved references:\n${unresolved.map(item => `  ${item}`).join('\n')}\n`)
    process.exitCode = 1
  }
}

main()
