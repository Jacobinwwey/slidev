/**
 * vite-plugin-singlefile
 *
 * Transforms Vite's multi-file ES module build output into a single
 * self-contained HTML file that works under file:// protocol.
 *
 * Uses AST-based ESM → CJS transformation (acorn + acorn-walk + MagicString)
 * in the generateBundle hook. Operates on Vite's bundle object directly,
 * using viteMetadata.importedCss for CSS discovery. No regex parsing of
 * imports/exports, no eval/new Function.
 */

import type { Plugin, ResolvedConfig, OutputAsset, OutputChunk } from 'vite'
import MagicString from 'magic-string'
import { parse } from 'acorn'
import { simple as walkSimple, base as baseWalk } from 'acorn-walk'
import path from 'node:path'
import fs from 'node:fs/promises'
import http from 'node:http'
import https from 'node:https'

export interface SingleFileOptions {
  /** Delete original multi-file build output after inlining. @default true */
  deleteOriginalAssets?: boolean
  /** Max bytes for external images to inline as data URLs. @default 10MB */
  maxImageSize?: number
  /** Inject hash-based router polyfill for file:// protocol and basic HTTP servers. @default true */
  hashRouterPolyfill?: boolean
  /** Inline all CSS into the HTML file. @default true */
  inlineCSS?: boolean
  /** Download and inline external images as data URLs. @default true */
  inlineImages?: boolean
  /** localStorage/sessionStorage fallback for file://. @default true */
  storagePolyfill?: boolean
}

const DEFAULT_OPTIONS: Required<SingleFileOptions> = {
  deleteOriginalAssets: true,
  maxImageSize: 10000000,
  hashRouterPolyfill: true,
  inlineCSS: true,
  inlineImages: true,
  storagePolyfill: true,
}

export function viteSingleFile(userOptions: SingleFileOptions = {}): Plugin {
  const options = { ...DEFAULT_OPTIONS, ...userOptions }
  let resolvedConfig: ResolvedConfig

  return {
    name: 'vite-plugin-singlefile',
    apply: 'build',

    config(config, { command }) {
      if (command !== 'build') return

      // For standalone single-file output, we disable CSS code splitting so all
      // CSS lands in a single asset that we can inline. We do NOT set
      // codeSplitting:false or format:'iife' here because:
      // - codeSplitting:false breaks HTML entry resolution in Rolldown
      // - Vite's HTML pipeline doesn't support IIFE output natively
      // Instead, we let Vite produce normal ES module chunks and then
      // transform + inline them in the generateBundle hook (Strategy B).
      return {
        build: {
          cssCodeSplit: false,
        },
      }
    },

    configResolved(config) {
      resolvedConfig = config
    },

    async generateBundle(this, outputOptions, bundle) {
      // Always use Strategy B: AST-based ESM → CJS transformation.
      const htmlFiles: string[] = []
      const jsChunks: OutputChunk[] = []
      const cssAssets: OutputAsset[] = []

      for (const [fileName, output] of Object.entries(bundle)) {
        if (fileName.endsWith('.html') && output.type === 'asset') {
          htmlFiles.push(fileName)
        }
        else if (output.type === 'chunk' && fileName.endsWith('.js')) {
          jsChunks.push(output as OutputChunk)
        }
        else if (fileName.endsWith('.css') && output.type === 'asset') {
          cssAssets.push(output as OutputAsset)
        }
      }

      if (htmlFiles.length === 0) {
        // Vite's HTML pipeline may emit HTML after generateBundle (during writeBundle
        // or via post-processing). This happens when the HTML transformation (injecting
        // script/link tags) occurs in a later phase. We need to use writeBundle instead.
        console.warn('[vite-plugin-singlefile] No HTML files in generateBundle. Will try writeBundle instead.')
        this._pendingJsChunks = jsChunks
        this._pendingCssAssets = cssAssets
        return
      }

      for (const htmlFileName of htmlFiles) {
        const htmlOutput = bundle[htmlFileName]
        if (htmlOutput.type !== 'asset') continue

        let html = asString(htmlOutput.source)

        // ── Inline JS chunks ────────────────────────────────────────
        for (const chunk of jsChunks) {
          let jsCode = chunk.code

          // AST-based ESM → CJS transformation
          jsCode = transformESMViaAST(jsCode, chunk.fileName)

          // Replace <script type="module" src="...chunk.js"> with inline <script>
          const escapedName = escapeRegExp(chunk.fileName)
          html = html.replace(
            new RegExp(`<script[^>]*\\bsrc\\s*=\\s*["'][^"']*${escapedName}["'][^>]*>\\s*</script>`, 'gi'),
            `<script>\n${jsCode}\n</script>`,
          )

          // Remove modulepreload links for this chunk
          html = html.replace(
            new RegExp(`<link[^>]*\\brel\\s*=\\s*["']modulepreload["'][^>]*\\bhref\\s*=\\s*["'][^"']*${escapedName}["'][^>]*/?>`, 'gi'),
            '',
          )

          if (options.deleteOriginalAssets) {
            delete bundle[chunk.fileName]
          }
        }

        // ── Inline CSS ──────────────────────────────────────────────
        if (options.inlineCSS) {
          // Use viteMetadata.importedCss from the entry chunk for structured CSS discovery
          const entryChunk = jsChunks.find(c => c.isEntry) || jsChunks[0]
          const cssFromMetadata = new Set<string>()
          if (entryChunk && entryChunk.viteMetadata && entryChunk.viteMetadata.importedCss) {
            for (const cssFile of entryChunk.viteMetadata.importedCss) {
              cssFromMetadata.add(cssFile)
            }
          }

          // Also collect CSS from all other chunks' viteMetadata
          for (const chunk of jsChunks) {
            if (chunk.viteMetadata && chunk.viteMetadata.importedCss) {
              for (const cssFile of chunk.viteMetadata.importedCss) {
                cssFromMetadata.add(cssFile)
              }
            }
          }

          // Inline CSS found via viteMetadata (structured, no regex)
          for (const cssFileName of cssFromMetadata) {
            const cssOutput = bundle[cssFileName]
            if (!cssOutput || cssOutput.type !== 'asset') continue

            const cssContent = asString(cssOutput.source)
            html = html.replace(
              new RegExp(`<link[^>]*\\bhref\\s*=\\s*["'][^"']*${escapeRegExp(cssFileName)}["'][^>]*>`, 'gi'),
              `<style>\n${cssContent}\n</style>`,
            )
            if (options.deleteOriginalAssets) {
              delete bundle[cssFileName]
            }
          }

          // Inline any remaining CSS assets not covered by viteMetadata
          for (const cssAsset of cssAssets) {
            if (bundle[cssAsset.fileName]) {
              const cssContent = asString(cssAsset.source)
              html = html.replace(
                new RegExp(`<link[^>]*\\bhref\\s*=\\s*["'][^"']*${escapeRegExp(cssAsset.fileName)}["'][^>]*>`, 'gi'),
                `<style>\n${cssContent}\n</style>`,
              )
              if (options.deleteOriginalAssets) {
                delete bundle[cssAsset.fileName]
              }
            }
          }
        }

        // ── Remove remaining modulepreload links ────────────────────
        html = html.replace(/<link[^>]*\brel\s*=\s*["']modulepreload["'][^>]*\/?>/gi, '')

        // ── Remove script type="module" (no longer needed) ──────────
        html = html.replace(/<script(\s[^>]*)\btype\s*=\s*["']module["']/g, '<script$1')

        // ── Remove external preload links ───────────────────────────
        html = html.replace(/<link[^>]*\brel\s*=\s*["']preload["'][^>]*\bhref\s*=\s*["']https?:\/\/[^"']*["'][^>]*\/?>/gi, '')

        // ── Inject polyfills (BEFORE JS scripts, right after <head>) ──
        // Inject after the real <head> tag (indexOf, not lastIndexOf) so
        // polyfills execute before any inline JS scripts.
        // Detect vue-router for conditional polyfill injection
        const gbVueRouterChunk = jsChunks.find(c =>
          c.code.includes('`pushState`') && c.code.includes('history.go'),
        )
        const gbHasVueRouterPatch = !!(gbVueRouterChunk && options.hashRouterPolyfill)

        if (options.hashRouterPolyfill && !gbHasVueRouterPatch) {
          html = injectAfterHead(html, buildHashRouterPolyfill())
        }
        if (options.storagePolyfill) {
          html = injectAfterHead(html, buildStoragePolyfill())
        }
        html = injectAfterHead(html, buildURLPolyfill())
        html = injectAfterHead(html, buildMonacoEventPolyfill())

        // ── Bundle marker ───────────────────────────────────────────
        html = html.replace(
          '<head>',
          '<head>\n  <meta name="slidev-bundle-mode" content="single-file-inline">',
        )

        htmlOutput.source = html
      }

      // Clean up remaining non-HTML assets
      if (options.deleteOriginalAssets) {
        for (const fileName of Object.keys(bundle)) {
          if (!fileName.endsWith('.html')) {
            delete bundle[fileName]
          }
        }
      }
    },

    // Post-build: inline JS/CSS/images into HTML and rewrite files on disk
    async writeBundle(this, outputOptions, bundle) {
      // In Vite 8 with Rolldown, HTML is NOT available in generateBundle —
      // it's emitted later by Vite's HTML post-processing pipeline. So we do
      // all our inlining work here in writeBundle, where HTML is available.
      const htmlFiles: string[] = []
      const jsChunks: OutputChunk[] = []
      const cssAssets: OutputAsset[] = []

      for (const [fileName, output] of Object.entries(bundle)) {
        if (fileName.endsWith('.html') && output.type === 'asset') {
          htmlFiles.push(fileName)
        }
        else if (output.type === 'chunk' && fileName.endsWith('.js')) {
          jsChunks.push(output as OutputChunk)
        }
        else if (fileName.endsWith('.css') && output.type === 'asset') {
          cssAssets.push(output as OutputAsset)
        }
      }

      // Only process HTML files that still reference external assets
      const needsInlining = htmlFiles.some(f => {
        const src = asString((bundle[f] as OutputAsset).source)
        return src.includes('type="module"') || (src.includes('/assets/') && (src.includes('.js') || src.includes('.css')))
      })

      if (!needsInlining) {
        // HTML was already inlined in generateBundle — just do image inlining
        if (options.inlineImages) {
          await inlineExternalImages(bundle, htmlFiles, resolvedConfig, options)
        }
        return
      }

      const outDir = resolvedConfig.build.outDir

      for (const htmlFileName of htmlFiles) {
        const htmlOutput = bundle[htmlFileName] as OutputAsset
        let html = asString(htmlOutput.source)

        // ── Inline ALL JS chunks via shared __modules registry ──────
        // Each chunk's ESM is transformed to CJS. Instead of wrapping each
        // in its own IIFE (which creates isolated __moduleCache scopes that
        // can't resolve cross-chunk requires), we register all modules in a
        // shared __modules object and wrap the entry point in a single IIFE
        // that uses that shared registry.

        // 1. Transform all chunks and register in __modules
        //    Escape </script in module bodies to prevent the HTML parser from
        //    prematurely closing the <script> block. <\/script is valid JS
        //    and invisible to the HTML5 parser's script content state machine.
        const moduleRegistrations: string[] = []
        const entryChunkFileNames: string[] = []
        const allChunkFileNames = new Set<string>()

        for (const chunk of jsChunks) {
          allChunkFileNames.add(chunk.fileName)
          const moduleBody = transformESMForBundle(chunk.code, chunk.fileName).replace(/<\/script/gi, '<\\/script')
          moduleRegistrations.push(
            `__modules["${chunk.fileName}"]=function(module,exports,__require){\n${moduleBody}\n};`,
          )
          if (chunk.isEntry) {
            entryChunkFileNames.push(chunk.fileName)
          }
        }

        // 2. Build polyfill scripts (must execute BEFORE the main IIFE)
        const polyfillScripts: string[] = []
        // Skip the pushState-intercepting hash polyfill when the vue-router
        // patch is active — the vue-router patch appends "#" to the base,
        // which makes the router itself use hash URLs via pushState. The
        // pushState polyfill would then double-convert those URLs, producing
        // broken URLs like "#/#/1" instead of "#/1".
        let vueRouterPatch = ''
        const vueRouterChunk = jsChunks.find(c =>
          c.code.includes('`pushState`') && c.code.includes('history.go'),
        )
        const hasVueRouterPatch = !!(vueRouterChunk && options.hashRouterPolyfill)

        if (options.hashRouterPolyfill && !hasVueRouterPatch) {
          polyfillScripts.push(buildHashRouterPolyfill())
        }
        if (options.storagePolyfill) {
          polyfillScripts.push(buildStoragePolyfill())
        }
        polyfillScripts.push(buildURLPolyfill())
        polyfillScripts.push(buildMonacoEventPolyfill())

        // 2b. Detect vue-router chunk and build a runtime patch that replaces
        //     createWebHistory with hash-based routing. Vue Router's
        //     createWebHistory(base) uses pushState with full-path URLs
        //     (e.g. /1), which fails under file:// and basic HTTP servers.
        //     Appending "#" to the base makes lt() switch to hash-based
        //     path extraction and pushState use hash fragments instead.
        if (hasVueRouterPatch) {
          // Build-time detection: scan ALL chunks for createWebHistory import.
          // At build time, chunks use ESM syntax like:
          //   import { B as le, A as ce, ... } from './modules/vue-PwzNmbSn.js'
          //   ... history: le('/') ...
          // The import path may be relative rather than using the full chunk
          // fileName, so we match by the basename portion.
          let exportKey = ''
          const vueRouterBaseName = vueRouterChunk.fileName.split('/').pop()!
          const escBase = escapeRegExp(vueRouterBaseName)
          for (const chunk of jsChunks) {
            const code = chunk.code
            if (!code.includes(vueRouterBaseName)) continue
            // Match: import { BINDINGS } from '...baseName'
            // BINDINGS can be multi: { A as ce, B as le, ... }
            const importRe = new RegExp(
              `import\\s*\\{([^}]+)\\}\\s*from\\s*['"\`][^'"\`]*${escBase}['"\`]`,
            )
            let m
            while ((m = importRe.exec(code)) !== null) {
              const bindingsStr = m[1]
              // Parse each binding: "KEY as VAR" or just "KEY"
              const bindings = bindingsStr.split(',').map((b: string) => {
                const parts = b.trim().split(/\s+as\s+/)
                return { key: parts[0].trim(), varName: (parts[1] || parts[0]).trim() }
              })
              for (const { key, varName } of bindings) {
                // Verify this variable is used as history:VARNAME(
                if (new RegExp(`history\\s*:\\s*${varName}\\s*\\(`).test(code)) {
                  exportKey = key
                  break
                }
              }
              if (exportKey) break
            }
            if (exportKey) break
          }
          if (exportKey) {
            vueRouterPatch = buildVueRouterPatch(vueRouterChunk.fileName, exportKey)
          }
          else {
            console.warn('[vite-plugin-singlefile] Could not detect createWebHistory export key; vue-router hash patch skipped')
          }
        }

        // 3. Build the shared module loader script
        //    All chunks (including entries) are registered in __modules so that
        //    cross-chunk imports work. Entry chunks are then invoked via __require().
        //    Polyfills are prepended so they execute before the main IIFE.
        //
        //    Entry requires are wrapped in DOMContentLoaded because the inline
        //    <script> is in <head> and blocks the HTML parser — the mount target
        //    (<div id="app">) is in <body> and hasn't been parsed yet when the
        //    script runs. Module registrations are OK synchronously (they just
        //    define __modules entries), but the entry code calls .mount('#app')
        //    which needs the DOM element to exist.
        const entryRequires = entryChunkFileNames.map(fn => `__require('${fn}');`).join('\n')
        const sharedLoader = polyfillScripts.join('\n') + `\n<script>
(function(){
"use strict";
var __modules={};
var __moduleCache={};
function __require(p){
  if(__moduleCache[p])return __moduleCache[p].exports;
  var m={exports:{}};
  __moduleCache[p]=m;
  if(__modules[p]){__modules[p](m,m.exports,__require);}
  else{console.warn("[singlefile] Module not found:",p);}
  return m.exports;
}
${moduleRegistrations.join('\n')}
${vueRouterPatch}
document.addEventListener('DOMContentLoaded',function(){
try{
${entryRequires}
}catch(e){console.error('[singlefile] Entry error:',e);throw e;}
});
})();
</script>`

        // 4. Replace entry script tags with the shared loader
        //    Use indexOf + substring instead of String.replace() because the
        //    sharedLoader may contain $ characters (e.g. regex patterns in
        //    bundled JS) which String.replace() interprets as capture-group
        //    references ($&, $1, etc.), corrupting the output.
        let inlinedCount = 0
        for (const entryFileName of entryChunkFileNames) {
          const escapedName = escapeRegExp(entryFileName)
          const scriptRegex = new RegExp(`<script[^>]*\\bsrc\\s*=\\s*["'][^"']*${escapedName}["'][^>]*>\\s*</script>`, 'gi')
          const match = scriptRegex.exec(html)
          if (match) {
            const idx = html.indexOf(match[0])
            html = html.substring(0, idx) + sharedLoader + html.substring(idx + match[0].length)
            inlinedCount++
          }
          else {
            console.warn(`[vite-plugin-singlefile] Entry script tag NOT found for ${entryFileName}`)
          }
        }

        // If no entry script tag was found (unusual), inject before </head>
        if (inlinedCount === 0 && entryChunkFileNames.length > 0) {
          const headIdx = html.indexOf('</head>')
          html = html.substring(0, headIdx) + sharedLoader + '\n' + html.substring(headIdx)
          inlinedCount = jsChunks.length
        }
        else {
          inlinedCount = jsChunks.length
        }

        // 5. Remove ALL remaining script tags referencing /assets/ (e.g. slide-per-slide
        //    <script> tags generated by Vite's HTML pipeline for each slide route)
        html = html.replace(/<script[^>]*\bsrc\s*=\s*["']\/assets\/[^"']*["'][^>]*>\s*<\/script>/gi, '')

        // Remove ALL modulepreload links
        html = html.replace(/<link[^>]*\brel\s*=\s*["']modulepreload["'][^>]*\/?>/gi, '')

        // ── Inline CSS ────────────────────────────────────────────
        if (options.inlineCSS) {
          const entryChunk = jsChunks.find(c => c.isEntry) || jsChunks[0]
          const cssFromMetadata = new Set<string>()
          if (entryChunk && entryChunk.viteMetadata && entryChunk.viteMetadata.importedCss) {
            for (const cssFile of entryChunk.viteMetadata.importedCss)
              cssFromMetadata.add(cssFile)
          }
          for (const chunk of jsChunks) {
            if (chunk.viteMetadata && chunk.viteMetadata.importedCss) {
              for (const cssFile of chunk.viteMetadata.importedCss)
                cssFromMetadata.add(cssFile)
            }
          }

          for (const cssFileName of cssFromMetadata) {
            const cssOutput = bundle[cssFileName]
            if (!cssOutput || cssOutput.type !== 'asset') continue

            const cssContent = asString(cssOutput.source)
            html = html.replace(
              new RegExp(`<link[^>]*\\bhref\\s*=\\s*["'][^"']*${escapeRegExp(cssFileName)}["'][^>]*>`, 'gi'),
              `<style>\n${cssContent}\n</style>`,
            )
          }

          for (const cssAsset of cssAssets) {
            if (bundle[cssAsset.fileName]) {
              const cssContent = asString(cssAsset.source)
              html = html.replace(
                new RegExp(`<link[^>]*\\bhref\\s*=\\s*["'][^"']*${escapeRegExp(cssAsset.fileName)}["'][^>]*>`, 'gi'),
                `<style>\n${cssContent}\n</style>`,
              )
            }
          }

          // Inline font files from CSS as data URLs
          html = await inlineFontsInCSS(html, bundle, resolvedConfig)
        }

        // ── Remove remaining modulepreload links ────────────────────
        html = html.replace(/<link[^>]*\brel\s*=\s*["']modulepreload["'][^>]*\/?>/gi, '')

        // ── Remove script type="module" ──────────────────────────
        html = html.replace(/<script(\s[^>]*)\btype\s*=\s*["']module["']/g, '<script$1')

        // ── Remove external preload links ─────────────────────────
        html = html.replace(/<link[^>]*\brel\s*=\s*["']preload["'][^>]*\bhref\s*=\s*["']https?:\/\/[^"']*["'][^>]*\/?>/gi, '')

        // ── Bundle marker ─────────────────────────────────────────
        // Use indexOf (not lastIndexOf) to find the REAL <head> tag at the
        // start of the document, not a <head> inside a JS template literal.
        const headOpenIdx = html.indexOf('<head>')
        if (headOpenIdx !== -1) {
          html = html.substring(0, headOpenIdx + 6) + '\n  <meta name="slidev-bundle-mode" content="single-file-inline">' + html.substring(headOpenIdx + 6)
        }

        // Update bundle AND rewrite file on disk
        htmlOutput.source = html
        const outPath = path.resolve(resolvedConfig.root, outDir, htmlFileName)
        await fs.writeFile(outPath, html, 'utf-8')

        console.log(`[vite-plugin-singlefile] Inlined ${inlinedCount} JS chunks into ${htmlFileName} (${(html.length / 1024 / 1024).toFixed(1)} MB)`)
      }

      // Clean up non-HTML assets (remove JS/CSS/font files from disk)
      if (options.deleteOriginalAssets) {
        const absOutDir = path.resolve(resolvedConfig.root, outDir)
        for (const fileName of Object.keys(bundle)) {
          if (!fileName.endsWith('.html')) {
            const filePath = path.resolve(absOutDir, fileName)
            try {
              await fs.unlink(filePath)
            }
            catch (_e) {}
          }
        }
        // Remove empty asset subdirectories
        try {
          const assetDir = path.resolve(absOutDir, 'assets')
          const entries = await fs.readdir(assetDir)
          for (const entry of entries) {
            const entryPath = path.resolve(assetDir, entry)
            const stat = await fs.stat(entryPath)
            if (stat.isDirectory()) {
              const subEntries = await fs.readdir(entryPath)
              if (subEntries.length === 0) {
                await fs.rmdir(entryPath)
              }
            }
          }
          // Check if assets dir is now empty and remove it
          const remaining = await fs.readdir(assetDir)
          if (remaining.length === 0) {
            await fs.rmdir(assetDir)
          }
        }
        catch (_e) {}
      }

      // ── Inline external images ────────────────────────────────────
      if (options.inlineImages) {
        await inlineExternalImages(bundle, htmlFiles, resolvedConfig, options)
      }
    },
  }
}

// ─── AST-based ESM → CJS transformation ────────────────────────────────────
//
// This is the Strategy B fallback. It uses acorn to parse ES module syntax
// and MagicString to surgically rewrite imports/exports to CJS require/exports.
// This is fundamentally more reliable than regex because:
// - No false positives in strings/comments
// - Handles all import/export patterns (namespace, re-export, mixed)
// - Preserves source positions for sourcemap generation

export function transformESMViaAST(code: string, fileName: string): string {
  // Resolve relative import paths to match __modules registry keys (e.g. './foo.js' → 'assets/foo.js')
  function resolveSource(source: string): string {
    if (source.startsWith('./') || source.startsWith('../')) {
      return path.posix.normalize(path.posix.join(path.posix.dirname(fileName), source))
    }
    return source
  }

  // Resolve relative path patterns inside template literals and expressions
  // e.g. `./foo.js` → `assets/foo.js` when fileName is `assets/bar.js`
  // Handles both ./ and ../ patterns by replacing the whole relative prefix
  // with the resolved directory, not just ./ with dir + /
  function resolveTemplateLiteralPaths(sourceCode: string, fromFileName: string): string {
    // Match ./ or ../ followed by a path-like character
    return sourceCode.replace(/(\.{1,2}\/)+/g, (match) => {
      const resolved = path.posix.normalize(path.posix.join(path.posix.dirname(fromFileName), match))
      // Ensure it ends with / since the match was a path prefix
      return resolved.endsWith('/') ? resolved : resolved + '/'
    })
  }

  let ast
  try {
    ast = parse(code, {
      sourceType: 'module',
      ecmaVersion: 'latest',
    })
  }
  catch (err: any) {
    console.warn(`[vite-plugin-singlefile] Failed to parse ${fileName}: ${err.message}`)
    console.warn('[vite-plugin-singlefile] Falling back to passthrough — output may not work under file://')
    return code
  }

  const s = new MagicString(code)

  // Build a custom walker base that ignores unknown node types
  const extendedBase = Object.create(baseWalk)
  // acorn-walk throws on unknown node types; we must handle all possible types
  const allNodeTypes = new Set<string>()
  function collectNodeTypes(node: any): void {
    if (!node || typeof node !== 'object') return
    if (node.type) allNodeTypes.add(node.type)
    for (const key of Object.keys(node)) {
      if (key === 'type' || key === 'start' || key === 'end' || key === 'loc' || key === 'range') continue
      const val = node[key]
      if (Array.isArray(val)) val.forEach(collectNodeTypes)
      else if (val && typeof val === 'object' && val.type) collectNodeTypes(val)
    }
  }
  collectNodeTypes(ast)
  for (const type of allNodeTypes) {
    if (!extendedBase[type]) {
      extendedBase[type] = () => {}
    }
  }

  // Process nodes in reverse order so position offsets don't corrupt later edits
  const edits: Array<{ start: number, end: number, replacement: string }> = []

  // Track which nodes have been consumed by higher-level handlers
  // to avoid double-transforming (e.g. import() inside __vitePreload)
  const consumed = new Set<number>()

  walkSimple(ast, {
    ImportDeclaration(node: any) {
      const rawSource = node.source.value as string
      const source = resolveSource(rawSource)

      if (node.specifiers.length === 0) {
        // Side-effect import: import './mod'
        edits.push({ start: node.start, end: node.end, replacement: `__require('${source}');` })
      }
      else {
        const parts: string[] = []
        for (const spec of node.specifiers) {
          if (spec.type === 'ImportDefaultSpecifier') {
            const local = spec.local.name
            parts.push(`const ${local}=(()=>{const m=__require('${source}');return m.default!==undefined?m.default:m})()`)
          }
          else if (spec.type === 'ImportNamespaceSpecifier') {
            const local = spec.local.name
            parts.push(`const ${local}=__require('${source}')`)
          }
          else if (spec.type === 'ImportSpecifier') {
            const imported = spec.imported.type === 'Identifier' ? spec.imported.name : spec.imported.value
            const local = spec.local.name
            parts.push(`const ${local}=__require('${source}').${imported}`)
          }
        }
        edits.push({ start: node.start, end: node.end, replacement: parts.join(';') + ';' })
      }
    },

    ExportAllDeclaration(node: any) {
      const rawSource = node.source.value as string
      const source = resolveSource(rawSource)
      edits.push({
        start: node.start,
        end: node.end,
        replacement: `Object.assign(module.exports,__require('${source}'));`,
      })
    },

    ExportDefaultDeclaration(node: any) {
      if (node.declaration.type === 'Identifier') {
        const name = node.declaration.name
        edits.push({ start: node.start, end: node.end, replacement: `module.exports.default=module.exports=${name};` })
      }
      else if (
        node.declaration.type === 'FunctionDeclaration' ||
        node.declaration.type === 'ClassDeclaration'
      ) {
        const declName = node.declaration.id ? node.declaration.id.name : `__default_${node.start}`
        const declCode = code.slice(node.declaration.start, node.declaration.end)
        edits.push({
          start: node.start,
          end: node.end,
          replacement: `${declCode};module.exports.default=module.exports=${declName};`,
        })
      }
      else {
        // export default <expression>
        const declCode = code.slice(node.declaration.start, node.declaration.end)
        edits.push({ start: node.start, end: node.end, replacement: `module.exports.default=module.exports=${declCode};` })
      }
    },

    ExportNamedDeclaration(node: any) {
      if (node.source) {
        // Re-export: export { X } from './mod'
        const source = node.source.value as string
        if (node.specifiers.length > 0) {
          const parts = node.specifiers.map((spec: any) => {
            const imported = spec.local.type === 'Identifier' ? spec.local.name : spec.local.value
            const exported = spec.exported.type === 'Identifier' ? spec.exported.name : spec.exported.value
            if (exported === 'default') {
              return `module.exports.default=module.exports=__require('${source}').${imported};`
            }
            return `module.exports.${exported}=__require('${source}').${imported};`
          })
          edits.push({ start: node.start, end: node.end, replacement: parts.join('') })
        }
      }
      else if (node.declaration) {
        if (node.declaration.type === 'VariableDeclaration') {
          const names = node.declaration.declarations.map((d: any) => d.id.name)
          const declCode = code.slice(node.declaration.start, node.declaration.end)
          const exports = names.map((n: string) => `module.exports.${n}=${n}`).join(';')
          edits.push({
            start: node.start,
            end: node.end,
            replacement: `${declCode};${exports};`,
          })
        }
        else if (
          node.declaration.type === 'FunctionDeclaration' ||
          node.declaration.type === 'ClassDeclaration'
        ) {
          const name = node.declaration.id.name
          const declCode = code.slice(node.declaration.start, node.declaration.end)
          edits.push({
            start: node.start,
            end: node.end,
            replacement: `${declCode};module.exports.${name}=${name};`,
          })
        }
      }
      else if (node.specifiers.length > 0) {
        // export { X, Y as Z }
        const parts = node.specifiers.map((spec: any) => {
          const local = spec.local.type === 'Identifier' ? spec.local.name : spec.local.value
          const exported = spec.exported.type === 'Identifier' ? spec.exported.name : spec.exported.value
          if (exported === 'default') {
            return `module.exports.default=module.exports=${local};`
          }
          return `module.exports.${exported}=${local};`
        })
        edits.push({ start: node.start, end: node.end, replacement: parts.join('') })
      }
    },

    CallExpression(node: any) {
      // Handle __vitePreload(() => import('./chunk'), __vite__mapDeps([0,1]))
      if (node.callee.type === 'Identifier' && node.callee.name === '__vitePreload') {
        const arrowFn = node.arguments[0]
        if (arrowFn && (arrowFn.type === 'ArrowFunctionExpression' || arrowFn.type === 'FunctionExpression')) {
          const body = arrowFn.body.type === 'BlockStatement' ? (arrowFn.body.body[0] && arrowFn.body.body[0].expression) : arrowFn.body
          if (body && body.type === 'ImportExpression') {
            consumed.add(body.start)
            let importPath: string
            if (body.source.type === 'Literal' && typeof body.source.value === 'string') {
              importPath = `'${resolveSource(body.source.value)}'`
            }
            else {
              importPath = code.slice(body.source.start, body.source.end)
            }
            edits.push({
              start: node.start,
              end: node.end,
              replacement: `Promise.resolve(__require(${importPath}))`,
            })
          }
        }
      }
      // Strip __vite__mapDeps calls
      if (node.callee.type === 'Identifier' && node.callee.name === '__vite__mapDeps') {
        edits.push({ start: node.start, end: node.end, replacement: '[]' })
      }
    },

    ImportExpression(node: any) {
      if (consumed.has(node.start)) return
      if (node.source.type === 'Literal' && typeof node.source.value === 'string') {
        const importPath = resolveSource(node.source.value as string)
        edits.push({
          start: node.start,
          end: node.end,
          replacement: `Promise.resolve(__require('${importPath}'))`,
        })
      }
      else {
        // Dynamic import with template literal or expression
        const sourceCode = code.slice(node.source.start, node.source.end)
        // Resolve relative path patterns inside template literals
        const resolvedCode = resolveTemplateLiteralPaths(sourceCode, fileName)
        edits.push({
          start: node.start,
          end: node.end,
          replacement: `Promise.resolve(__require(${resolvedCode}))`,
        })
      }
    },

    MemberExpression(node: any) {
      // Handle import.meta.url / import.meta.env etc.
      // acorn parses `import.meta.url` as MemberExpression { object: MetaProperty, property: Identifier }
      if (node.object && node.object.type === 'MetaProperty') {
        const propName = node.property.name || node.property.value
        if (propName === 'url') {
          edits.push({
            start: node.start,
            end: node.end,
            replacement: '(document.currentScript&&document.currentScript.src||location.href)',
          })
        }
        else if (propName === 'env') {
          edits.push({ start: node.start, end: node.end, replacement: '({})' })
        }
        else {
          edits.push({ start: node.start, end: node.end, replacement: '({})' })
        }
        consumed.add(node.object.start)
      }
    },

    MetaProperty(node: any) {
      // Bare import.meta (not as part of a MemberExpression, e.g. passed as argument)
      if (consumed.has(node.start)) return
      const metaCode = code.slice(node.start, node.end)
      if (metaCode.startsWith('import.meta.glob')) {
        const callEnd = findMatchingParen(code, node.end)
        if (callEnd !== -1) {
          edits.push({ start: node.start, end: callEnd + 1, replacement: '({})' })
        }
      }
      else {
        edits.push({ start: node.start, end: node.end, replacement: '({})' })
      }
    },
  }, extendedBase)

  // Apply edits in reverse order to preserve positions
  edits.sort((a, b) => b.start - a.start)
  for (const edit of edits) {
    s.overwrite(edit.start, edit.end, edit.replacement)
  }

  let result = s.toString()

  // ── Strip Vite-specific constructs ────────────────────────────────

  // Strip __vitePreload variable declarations and function definitions
  result = result.replace(/(?:const|var|let)\s+__vitePreload\s*=[^;]*;?/g, '')
  result = result.replace(/function\s+__vitePreload\s*\([^)]*\)\s*\{[^}]*\}/g, '')

  // Remove remaining __vitePreload calls (if AST didn't catch them)
  result = result.replace(
    /__vitePreload\(\s*\(\)\s*=>\s*__require\(([^)]+)\)\s*(?:,\s*[^)]+)?\)/g,
    'Promise.resolve(__require($1))',
  )
  result = result.replace(
    /__vitePreload\(\s*\(\)\s*=>\s*import\s*\(([^)]+)\)\s*,\s*__vite__mapDeps\(\[[^\]]*\]\)\s*\)/g,
    'Promise.resolve(__require($1))',
  )
  result = result.replace(
    /__vitePreload\(\s*\(\)\s*=>\s*import\s*\(([^)]+)\)\s*(?:,\s*[^)]+)?\)/g,
    'Promise.resolve(__require($1))',
  )

  // Strip __vite__mapDeps definitions
  result = result.replace(/(?:const|var|let)\s+__vite__mapDeps\s*=[^;]*;?/g, '')

  // Strip Vite modulepreload polyfill
  result = result.replace(
    /\(function\(\)\{let e=document\.createElement\(`link`\)\.relList[\s\S]*?fetch\(e\.href,n\)\}\}\)\(\);?/,
    '',
  )

  // Remove CSS require calls (CSS is inlined in HTML)
  result = result.replace(/__require\(['"][^'"]+\.css['"]\)\s*;?/g, '')

  // ── Wrap in IIFE with __require loader ────────────────────────────
  result = wrapIIFE(result)

  return result
}

// ─── IIFE wrapper ────────────────────────────────────────────────────────────

function wrapIIFE(code: string): string {
  return `(function(){\n"use strict";\nvar __moduleCache={};\nfunction __require(p){if(__moduleCache[p])return __moduleCache[p].exports;var m={exports:{}};__moduleCache[p]=m;if(typeof __modules!=='undefined'&&__modules[p]){__modules[p](m,m.exports,__require);}return m.exports;}\ntry{\n${code}\n}catch(e){console.error('[singlefile] Module error:',e);throw e;}\n})();`
}

// Transform ESM to CJS for single-file bundle mode — returns raw module body
// (no IIFE wrapper) for registration in the shared __modules registry.
export function transformESMForBundle(code: string, fileName: string): string {
  const transformed = transformESMViaAST(code, fileName)
  // Strip the IIFE wrapper — we only want the inner module body
  // The IIFE pattern is: (function(){...})();
  const prefix = '(function(){\n"use strict";\nvar __moduleCache={};\nfunction __require(p){if(__moduleCache[p])return __moduleCache[p].exports;var m={exports:{}};__moduleCache[p]=m;if(typeof __modules!==\'undefined\'&&__modules[p]){__modules[p](m,m.exports,__require);}return m.exports;}\ntry{\n'
  const suffix = '\n}catch(e){console.error(\'[singlefile] Module error:\',e);throw e;}\n})();'
  if (transformed.startsWith(prefix) && transformed.endsWith(suffix)) {
    return transformed.slice(prefix.length, transformed.length - suffix.length)
  }
  // Fallback: return as-is
  return transformed
}

// ─── Polyfill builders ────────────────────────────────────────────────────────

// Build polyfill scripts as strings (not injected into HTML yet).
// Used in two places: (1) prepended to sharedLoader in writeBundle,
// (2) injected after <head> in generateBundle.

function buildHashRouterPolyfill(): string {
  return `<script>
(function(){
  var _ps=history.pushState,_rs=history.replaceState;
  history.pushState=function(s,t,u){
    if(typeof u==='string'&&u.charAt(0)==='/'){
      u='#'+u;_ps.call(history,s,t,u);
    }else{_ps.apply(history,arguments);}
  };
  history.replaceState=function(s,t,u){
    if(typeof u==='string'&&u.charAt(0)==='/'){
      u='#'+u;_rs.call(history,s,t,u);
    }else{_rs.apply(history,arguments);}
  };
  if(!location.hash&&location.pathname!=='/'){
    location.hash=location.pathname;_rs.call(history,{},'','/');
  }
})();
</script>`
}

function buildStoragePolyfill(): string {
  return `<script>
(function(){
  function safeStorage(orig){
    var _m={};var _f=false;
    return{
      getItem:function(k){if(_f)return _m[k]||null;try{return orig.getItem(k);}catch(e){_f=true;return _m[k]||null;}},
      setItem:function(k,v){if(_f){_m[k]=String(v);return;}try{orig.setItem(k,v);}catch(e){_f=true;_m[k]=String(v);}},
      removeItem:function(k){if(_f){delete _m[k];return;}try{orig.removeItem(k);}catch(e){_f=true;delete _m[k];}},
      clear:function(){if(_f){_m={};return;}try{orig.clear();}catch(e){_f=true;_m={};}},
      key:function(i){if(_f)return Object.keys(_m)[i]||null;try{return orig.key(i);}catch(e){_f=true;return Object.keys(_m)[i]||null;}},
      get length(){if(_f)return Object.keys(_m).length;try{return orig.length;}catch(e){_f=true;return Object.keys(_m).length;}}
    };
  }
  try{
    var _ls=window.localStorage,_ss=window.sessionStorage;
    Object.defineProperty(window,'localStorage',{get:function(){return safeStorage(_ls);},configurable:true});
    Object.defineProperty(window,'sessionStorage',{get:function(){return safeStorage(_ss);},configurable:true});
  }catch(e){}
})();
</script>`
}

function buildURLPolyfill(): string {
  return `<script>
(function(){
  var _U=window.URL;
  window.URL=function(u,b){if(!b||b==='')b=window.location.href;return new _U(u,b);};
  window.URL.prototype=_U.prototype;
  window.URL.createObjectURL=_U.createObjectURL;
  window.URL.revokeObjectURL=_U.revokeObjectURL;
})();
</script>`
}

// Monaco Editor's error handler throws raw Event objects via setTimeout,
// causing uncaught exceptions that can prevent the page from loading.
// This polyfill wraps setTimeout to catch and suppress non-Error throws.
function buildMonacoEventPolyfill(): string {
  return `<script>
(function(){
  var _st=window.setTimeout;
  window.setTimeout=function(fn,ms){
    var args=Array.prototype.slice.call(arguments,2);
    return _st.call(window,function(){
      try{return fn.apply(this,args)}
      catch(e){if(e instanceof Error)throw e}
    },ms);
  };
})();
</script>`
}

// Inject content right after the real <head> tag (indexOf, not lastIndexOf,
// to avoid matching <head> inside JS template literals).
function injectAfterHead(html: string, content: string): string {
  const idx = html.indexOf('<head>')
  if (idx === -1) return html
  return html.substring(0, idx + 6) + '\n' + content + html.substring(idx + 6)
}

// ─── Vue Router hash-mode patch ──────────────────────────────────────────────
// Vue Router's createWebHistory uses pushState with full-path URLs (e.g. /1),
// which fails under file:// and basic HTTP servers that can't serve SPA routes.
// Appending "#" to the base switches lt() to hash-based path extraction and
// makes pushState use hash fragments (#/1) instead of path navigation.

function buildVueRouterPatch(moduleFileName: string, exportKey: string): string {
  // This code runs INSIDE the IIFE where __modules is in scope.
  // We use string concatenation (not template literals) to avoid
  // ${} being interpreted as JS template interpolation.
  // exportKey is the minified export name for createWebHistory,
  // detected at build time from the entry chunk.
  return '(function(){\n' +
    'var _orig=__modules["' + moduleFileName + '"];\n' +
    '__modules["' + moduleFileName + '"]=function(module,exports,__require){\n' +
    '_orig(module,exports,__require);\n' +
    'var _origFn=exports.' + exportKey + ';\n' +
    'if(typeof _origFn==="function"){\n' +
    'exports.' + exportKey + '=function(base){if(typeof base==="string"&&base.indexOf("#")===-1)base+="#";return _origFn(base)};\n' +
    '}\n' +
    '};\n' +
    '})();'
}

// ─── Image inlining ─────────────────────────────────────────────────────────

// ─── Image inlining helper ────────────────────────────────────────────────────

async function inlineExternalImages(
  bundle: Record<string, any>,
  htmlFiles: string[],
  resolvedConfig: ResolvedConfig,
  options: Required<SingleFileOptions>,
) {
  for (const fileName of htmlFiles) {
    const output = bundle[fileName]
    if (!output || output.type !== 'asset') continue

    let html = asString(output.source)
    const imageURLs = findExternalImageURLs(html)
    if (imageURLs.size === 0) continue

    console.log(`[vite-plugin-singlefile] Found ${imageURLs.size} external image(s), downloading...`)

    const urlMap = new Map<string, string>()
    for (const url of imageURLs) {
      const dataURL = await downloadImageAsDataURL(url, options.maxImageSize)
      if (dataURL) {
        urlMap.set(url, dataURL)
        console.log(`[vite-plugin-singlefile] Inlined: ${url.substring(0, 80)}...`)
      }
    }

    if (urlMap.size > 0) {
      html = replaceImageURLs(html, urlMap)
      output.source = html
      const outDir = resolvedConfig.build.outDir
      const outPath = path.resolve(resolvedConfig.root, outDir, fileName)
      await fs.writeFile(outPath, html, 'utf-8')
    }
  }
}

// ─── Font inlining ──────────────────────────────────────────────────────────

async function inlineFontsInCSS(
  html: string,
  bundle: Record<string, any>,
  resolvedConfig: ResolvedConfig,
): Promise<string> {
  // Find font file references in inline CSS: url(/assets/...) or url(./assets/...)
  const fontPattern = /url\(\s*["']?(?:\.\/)?(\/assets\/[^)"'?\s]+(?:\.woff2?|\.ttf|\.eot|\.otf))["']?\s*\)/gi
  const fontRefs = new Map<string, string[]>() // fontPath -> [originalMatch, ...]
  const fontPattern2 = /url\(\s*["']?(?:\.\/)?(\/assets\/[^)"'?\s]+(?:\.woff2?|\.ttf|\.eot|\.otf))["']?\s*\)/gi
  let fontMatch: RegExpExecArray | null
  while ((fontMatch = fontPattern2.exec(html)) !== null) {
    const fontPath = fontMatch[1]
    if (!fontRefs.has(fontPath)) fontRefs.set(fontPath, [])
    fontRefs.get(fontPath)!.push(fontMatch[0])
  }

  if (fontRefs.size === 0) return html

  const absOutDir = path.resolve(resolvedConfig.root, resolvedConfig.build.outDir)
  console.log(`[vite-plugin-singlefile] Inlining ${fontRefs.size} font file(s) from CSS`)

  for (const [fontPath, matches] of fontRefs) {
    const filePath = path.resolve(absOutDir, fontPath.replace(/^\//, ''))
    try {
      const buffer = await fs.readFile(filePath)
      const ext = path.extname(fontPath).toLowerCase()
      const mime = ext === '.woff2' ? 'font/woff2'
        : ext === '.woff' ? 'font/woff'
        : ext === '.ttf' ? 'font/ttf'
        : ext === '.otf' ? 'font/otf'
        : 'application/octet-stream'
      const dataURL = `data:${mime};base64,${buffer.toString('base64')}`
      for (const original of matches) {
        const replacement = original.replace(/url\(\s*["']?(?:\.\/)?\/assets\/[^)"'?\s]+["']?\s*\)/i, `url('${dataURL}')`)
        html = html.replace(original, replacement)
      }
    }
    catch (_e) {
      console.warn(`[vite-plugin-singlefile] Font not found: ${fontPath}`)
    }
  }

  return html
}

function findExternalImageURLs(html: string): Set<string> {
  const urls = new Set<string>()
  for (const m of html.matchAll(/<img[^>]*\bsrc\s*=\s*["'](https?:\/\/[^"']+)["']/gi)) urls.add(m[1])
  for (const m of html.matchAll(/background(?:-image)?\s*:\s*[^;}]*url\(\s*["']?(https?:\/\/[^"')]+)["']?\s*\)/gi)) urls.add(m[1])
  for (const m of html.matchAll(/style\s*=\s*["']([^"']*background[^"']*)["']/gi)) {
    for (const u of m[1].matchAll(/url\(\s*["']?(https?:\/\/[^"')]+)["']?\s*\)/gi)) urls.add(u[1])
  }
  for (const m of html.matchAll(/background\s*:\s*`?(https?:\/\/[^`'")\s\n,}]+)/gi)) urls.add(m[1])
  return urls
}

async function downloadImageAsDataURL(url: string, maxSize: number): Promise<string | null> {
  return new Promise((resolve) => {
    const client = url.startsWith('https:') ? https : http
    const request = client.get(url, (response) => {
      if ([301, 302, 307, 308].includes(response.statusCode!) && response.headers.location) {
        downloadImageAsDataURL(response.headers.location, maxSize).then(resolve)
        return
      }
      if (response.statusCode !== 200) { resolve(null); return }
      const chunks: Buffer[] = []
      let size = 0
      response.on('data', (chunk: Buffer) => {
        size += chunk.length
        if (size > maxSize) { request.destroy(); resolve(null); return }
        chunks.push(chunk)
      })
      response.on('end', () => {
        const buffer = Buffer.concat(chunks)
        const contentType = response.headers['content-type'] || 'image/jpeg'
        resolve(`data:${contentType};base64,${buffer.toString('base64')}`)
      })
      response.on('error', () => resolve(null))
    })
    request.on('error', () => resolve(null))
    request.setTimeout(30000, () => { request.destroy(); resolve(null) })
  })
}

function replaceImageURLs(html: string, urlMap: Map<string, string>): string {
  let result = html
  for (const [originalURL, dataURL] of urlMap.entries()) {
    const esc = originalURL.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    result = result.replace(new RegExp(`(background\\s*:\\s*[\`'"])${esc}([\`'"])`, 'gi'), `$1${dataURL}$2`)
    result = result.replace(new RegExp(`(<img[^>]*\\bsrc\\s*=\\s*["'])${esc}(["'])`, 'gi'), `$1${dataURL}$2`)
    result = result.replace(new RegExp(`(url\\(\\s*["'])${esc}(["']\\s*\\))`, 'gi'), `$1${dataURL}$2`)
    result = result.replace(new RegExp(`(url\\(\\s*)${esc}(\\s*\\))`, 'gi'), `$1${dataURL}$2`)
  }
  return result
}

// ─── Utilities ───────────────────────────────────────────────────────────────

function asString(source: string | Uint8Array): string {
  return typeof source === 'string' ? source : Buffer.from(source).toString('utf-8')
}

function escapeRegExp(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function findMatchingParen(code: string, startSearch: number): number {
  let depth = 0
  for (let i = startSearch; i < code.length; i++) {
    if (code[i] === '(') depth++
    else if (code[i] === ')') {
      depth--
      if (depth === 0) return i
    }
  }
  return -1
}
