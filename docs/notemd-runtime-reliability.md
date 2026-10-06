# NoteMD standalone runtime reliability

English | [简体中文](./notemd-runtime-reliability.zh-CN.md)

## Contract

NoteMD requires the Jacobinwwey Slidev fork. Package name, semver and help options alone do not identify it. A release must be tested as the actual npm-installable archive in a new consumer directory; a successful workspace build is insufficient. Previously published assets must not be replaced.

## Confirmed failure mechanisms

1. The release permitted UnoCSS `^66.7.0`, while its workspace lock selected 66.7.0. Fresh installs selected 66.10.5, whose Vite integration constructs MagicString 1.4.3. Uno directives modify that instance and then replace its original range during empty-rule cleanup; retained insertions produce invalid bare CSS declarations. Pinning the four UnoCSS catalog packages to the tested 66.7.0 cohort constrains the published manifest.
2. The standalone ESM transformer emitted `module.exports.default=module.exports=component`. This overwrote named exports declared earlier in the same chunk. A freshly installed Mermaid version shared layout functions with a slide component chunk, so its named layout function disappeared. Retaining `module.exports`, assigning its `.default`, and marking the namespace with `Symbol.toStringTag = 'Module'` preserves those exports and Vue async-component unwrapping. Regression tests execute transformed modules, including primitive defaults and re-exports.
3. Fresh installs selected Twoslash 4.5.0 / FloatingVue 5.4.0. Twoslash accesses `VMenu.components.Popper.extends`, which no longer matches that component shape. The tested pair is 4.2.0 / 5.2.2. Both are explicit CLI dependencies, and Vite resolves their runtime entrypoints from the CLI so a consumer's newer copies cannot override them. Upgrade this pair together after consumer rendering tests.

The namespace correction fixes module semantics; dependency constraints address separate tested compatibility boundaries. They are not interchangeable.

## Reproducible package gate

Build the CLI and create its final tarball with `pnpm pack`. Run:

```sh
node scripts/smoke-standalone-package.mjs /absolute/path/cli.tgz /absolute/path/new-consumer
```

The command refuses an existing consumer directory, installs the exact archive with npm, installs Chromium through that consumer's Playwright package, builds minified standalone HTML without a plugin-generated Vite config, and checks offline Chinese/code/Mermaid rendering. It writes `standalone-smoke.json` with the archive SHA-256 and browser errors. Use `PLAYWRIGHT_BROWSERS_PATH` and `npm_config_cache` to select caches. Run through npm, or provide `npm_execpath`, if npm is not adjacent to the active Node installation.

The fixture explicitly disables online fonts and wake lock. The default fixture separately showed offline font requests and wake-lock permission rejection; this gate does not claim those optional features work in an offline headless environment. Run the gate on Windows and Linux before release. No Linux pass is claimed by the local Windows acceptance.

## Local evidence and publication status

The old `notemd-standalone-v52.16.0-1` archive matched the installed NoteMD CLI byte-for-byte. The initial candidate built but failed FloatingVue and Mermaid rendering; the repaired candidate passed the explicit offline fixture with no errors or failed requests. The targeted transformer tests passed 33 cases. NoteMD's 36-slide architecture deck passed all five export formats against the original fork main checkout; the post-fix rerun is tracked in NoteMD's bilingual reliability record.

These are local changes. No replacement public asset or new release has been uploaded. The existing release workflow only matches `v*`; do not assume a `notemd-standalone-*` publication automatically ran this package gate.
