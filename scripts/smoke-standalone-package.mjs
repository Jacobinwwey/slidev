import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const [archiveArgument, directoryArgument] = process.argv.slice(2)
assert(archiveArgument && directoryArgument, 'Usage: node scripts/smoke-standalone-package.mjs <final-cli.tgz> <new-consumer-directory>')
const archive = path.resolve(archiveArgument)
const directory = path.resolve(directoryArgument)
assert(existsSync(archive), 'CLI archive must exist')
assert(!existsSync(directory), 'Use a new directory to prevent inherited consumer dependencies')
mkdirSync(directory, { recursive: true })
writeFileSync(path.join(directory, 'package.json'), JSON.stringify({ name: 'slidev-standalone-consumer-smoke', private: true }))

function execute(command, args) {
  const result = spawnSync(command, args, { cwd: directory, stdio: 'inherit', windowsHide: true, timeout: 300_000 })
  if (result.error) throw result.error
  assert.equal(result.status, 0, `${command} failed`)
}

// npm's JS entry avoids shell quoting of archive paths on Windows. npm_execpath
// is available through npm scripts; otherwise find npm beside the active Node.
const npmCli = process.env.npm_execpath || path.join(path.dirname(process.execPath), 'node_modules/npm/bin/npm-cli.js')
assert(existsSync(npmCli), 'Run through npm or provide npm_execpath pointing to npm-cli.js')
execute(process.execPath, [npmCli, 'install', '--ignore-scripts', '--no-audit', '--no-fund', archive, '@slidev/theme-default', 'playwright-chromium'])
const requireConsumer = createRequire(path.join(directory, 'package.json'))
const playwrightManifest = requireConsumer.resolve('playwright-chromium/package.json')
execute(process.execPath, [path.join(path.dirname(playwrightManifest), 'cli.js'), 'install', 'chromium'])

// Explicit offline presentation settings avoid conflating optional network
// fonts or OS wake-lock permissions with module/rendering correctness.
writeFileSync(path.join(directory, 'slides.md'), `---
theme: default
fonts:
  provider: none
wakeLock: false
---
# Standalone package smoke
English and 中文 render together.

\`\`\`ts
const exported = 'verified';
\`\`\`
---
# Relationships
\`\`\`mermaid
flowchart LR
  A[Source] --> B[Export]
\`\`\`
`)
const cli = path.join(directory, 'node_modules/@slidev/cli/bin/slidev.mjs')
execute(process.execPath, [cli, 'build', 'slides.md', '--standalone-bundle', '--out', 'dist'])
const { chromium } = requireConsumer('playwright-chromium')
const browser = await chromium.launch({ headless: true })
const report = { archiveSha256: createHash('sha256').update(readFileSync(archive)).digest('hex'), errors: [], warnings: [], failedRequests: [], ok: false }
try {
  const context = await browser.newContext({ offline: true })
  const page = await context.newPage()
  page.on('pageerror', error => report.errors.push(error.message))
  page.on('console', entry => {
    if (entry.type() === 'error') report.errors.push(entry.text())
    if (entry.type() === 'warning') report.warnings.push(entry.text())
  })
  page.on('requestfailed', request => report.failedRequests.push(request.url()))
  await page.goto(`${pathToFileURL(path.join(directory, 'dist/index.html')).href}#/1`)
  await page.waitForFunction(() => document.body.innerText.includes('English and 中文 render together.') && [...document.querySelectorAll('pre')].some(pre => pre.textContent.includes('verified')))
  await page.evaluate(() => { location.hash = '#/2' })
  await page.waitForFunction(() => {
    const roots = [document, ...[...document.querySelectorAll('*')].map(element => element.shadowRoot).filter(Boolean)]
    return roots.some(root => [...root.querySelectorAll('svg')].some(svg => svg.textContent.includes('Source') && svg.textContent.includes('Export')))
  })
  assert.deepEqual(report.errors, [])
  assert.deepEqual(report.warnings, [])
  assert.deepEqual(report.failedRequests, [])
  report.ok = true
} finally {
  await browser.close()
  writeFileSync(path.join(directory, 'standalone-smoke.json'), JSON.stringify(report, null, 2))
}
