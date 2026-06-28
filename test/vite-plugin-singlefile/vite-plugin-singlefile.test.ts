import { describe, expect, it } from 'vitest'
import { parse } from 'acorn'
import MagicString from 'magic-string'

// Re-implement the core transform function from the plugin for testing.
// This tests the actual AST transformation logic, not a copy.
import { transformESMViaAST } from '../packages/slidev/node/commands/vite-plugin-singlefile/index.ts'

describe('vite-plugin-singlefile: AST-based ESM transformation', () => {
  describe('import declarations', () => {
    it('transforms named imports', () => {
      const code = `import { ref, computed } from 'vue';const x = ref(1);`
      const result = transformESMViaAST(code, 'test.js')
      expect(result).toContain(`__require('vue').ref`)
      expect(result).toContain(`__require('vue').computed`)
      expect(result).not.toContain('import {')
    })

    it('transforms default imports', () => {
      const code = `import Vue from 'vue';const app = Vue();`
      const result = transformESMViaAST(code, 'test.js')
      expect(result).toContain(`__require('vue')`)
      expect(result).toContain('default')
      expect(result).not.toContain('import Vue')
    })

    it('transforms namespace imports', () => {
      const code = `import * as vue from 'vue';const x = vue.ref(1);`
      const result = transformESMViaAST(code, 'test.js')
      expect(result).toContain(`const vue=__require('vue')`)
      expect(result).not.toContain('import *')
    })

    it('transforms side-effect imports', () => {
      const code = `import './polyfill';const x = 1;`
      const result = transformESMViaAST(code, 'test.js')
      // resolveSource resolves './polyfill' relative to 'test.js' => 'polyfill'
      expect(result).toContain(`__require('polyfill')`)
      expect(result).not.toContain('import ')
    })

    it('transforms mixed imports (default + named)', () => {
      const code = `import Vue, { ref } from 'vue';`
      const result = transformESMViaAST(code, 'test.js')
      expect(result).toContain(`__require('vue')`)
      expect(result).toContain('.ref')
      expect(result).toContain('default')
    })

    it('handles aliased imports', () => {
      const code = `import { ref as r } from 'vue';const x = r(1);`
      const result = transformESMViaAST(code, 'test.js')
      expect(result).toContain(`const r=__require('vue').ref`)
    })
  })

  describe('export declarations', () => {
    it('transforms export default identifier', () => {
      const code = `const App = {};export default App;`
      const result = transformESMViaAST(code, 'test.js')
      expect(result).toContain('module.exports.default=module.exports=App')
      expect(result).not.toContain('export default')
    })

    it('transforms export default function', () => {
      const code = `export default function main() { return 1; }`
      const result = transformESMViaAST(code, 'test.js')
      expect(result).toContain('module.exports.default=module.exports=main')
      expect(result).toContain('function main()')
    })

    it('transforms export default class', () => {
      const code = `export default class MyClass { constructor() {} }`
      const result = transformESMViaAST(code, 'test.js')
      expect(result).toContain('module.exports.default=module.exports=MyClass')
      expect(result).toContain('class MyClass')
    })

    it('transforms named exports with specifiers', () => {
      const code = `const a = 1; const b = 2; export { a, b as default };`
      const result = transformESMViaAST(code, 'test.js')
      expect(result).toContain('module.exports.a=a')
      // b as default — critical for Vue's defineAsyncComponent
      expect(result).toContain('module.exports.default=module.exports=b')
    })

    it('transforms export const/let/var', () => {
      const code = `export const x = 1; export let y = 2;`
      const result = transformESMViaAST(code, 'test.js')
      expect(result).toContain('module.exports.x=x')
      expect(result).toContain('module.exports.y=y')
    })

    it('transforms export function', () => {
      const code = `export function helper() { return 1; }`
      const result = transformESMViaAST(code, 'test.js')
      expect(result).toContain('module.exports.helper=helper')
      expect(result).toContain('function helper()')
    })

    it('transforms export class', () => {
      const code = `export class Widget { render() {} }`
      const result = transformESMViaAST(code, 'test.js')
      expect(result).toContain('module.exports.Widget=Widget')
    })

    it('transforms re-exports', () => {
      const code = `export { ref } from 'vue';`
      const result = transformESMViaAST(code, 'test.js')
      expect(result).toContain(`module.exports.ref=__require('vue').ref`)
      expect(result).not.toContain('export {')
    })

    it('transforms namespace re-exports', () => {
      const code = `export * from 'vue';`
      const result = transformESMViaAST(code, 'test.js')
      expect(result).toContain(`Object.assign(module.exports,__require('vue'))`)
    })
  })

  describe('dynamic imports', () => {
    it('transforms static dynamic imports', () => {
      const code = `const mod = import('./module');`
      const result = transformESMViaAST(code, 'test.js')
      // resolveSource resolves './module' relative to 'test.js' => 'module'
      expect(result).toContain(`Promise.resolve(__require('module'))`)
      expect(result).not.toContain('import(')
    })

    it('preserves expression dynamic imports', () => {
      const code = 'const mod = import(`./slides/${name}.js`);'
      const result = transformESMViaAST(code, 'test.js')
      expect(result).toContain('__require(')
      expect(result).toContain('Promise.resolve')
    })
  })

  describe('import.meta', () => {
    it('transforms import.meta.url', () => {
      const code = `const url = import.meta.url;`
      const result = transformESMViaAST(code, 'test.js')
      expect(result).toContain('document.currentScript')
      expect(result).not.toContain('import.meta.url')
    })
  })

  describe('Vite-specific constructs', () => {
    it('strips __vitePreload wrappers', () => {
      const code = `const mod = __vitePreload(() => import('./chunk'), __vite__mapDeps([0,1]));`
      const result = transformESMViaAST(code, 'test.js')
      expect(result).not.toContain('__vitePreload')
      expect(result).toContain('__require')
    })

    it('strips __vite__mapDeps definitions', () => {
      const code = `const __vite__mapDeps=(i,m=__vite__mapDeps,d=(m.f||(m.f=["assets/foo.js","assets/bar.js"])))=>i.map(i=>d[i]);`
      const result = transformESMViaAST(code, 'test.js')
      expect(result).not.toContain('__vite__mapDeps')
    })

    it('strips CSS require calls', () => {
      const code = `__require('./assets/style.css');const x = 1;`
      const result = transformESMViaAST(code, 'test.js')
      expect(result).not.toContain('.css')
      expect(result).toContain('const x = 1')
    })
  })

  describe('IIFE wrapping', () => {
    it('wraps code in IIFE', () => {
      const code = `const x = 1;`
      const result = transformESMViaAST(code, 'test.js')
      expect(result).toMatch(/^\(function\(\)/)
      expect(result).toMatch(/\}\)\(\);?\s*$/)
    })

    it('includes __require function', () => {
      const code = `const x = 1;`
      const result = transformESMViaAST(code, 'test.js')
      expect(result).toContain('function __require')
    })
  })

  describe('edge cases', () => {
    it('handles import/export keywords in strings (not confused by regex)', () => {
      const code = `const str = "import something from elsewhere";export default str;`
      const result = transformESMViaAST(code, 'test.js')
      // The string "import something from elsewhere" should be preserved
      expect(result).toContain('import something from elsewhere')
      expect(result).toContain('module.exports.default=module.exports=str')
    })

    it('handles multiple imports from same module', () => {
      const code = `import { ref } from 'vue';import { computed } from 'vue';`
      const result = transformESMViaAST(code, 'test.js')
      expect(result).toContain(`.ref`)
      expect(result).toContain(`.computed`)
    })

    it('gracefully handles unparseable code', () => {
      // This should not throw, just warn and return original
      const code = `{{{invalid js!!!`
      const result = transformESMViaAST(code, 'test.js')
      // Should return the original code as fallback
      expect(result).toContain('invalid')
    })
  })
})

describe('vite-plugin-singlefile: critical Vue patterns', () => {
  it('handles Vue SFC export pattern: export { _sfc_main as default }', () => {
    const code = `const _sfc_main = { setup() {} };export { _sfc_main as default };`
    const result = transformESMViaAST(code, 'component.js')
    // This is the CRITICAL pattern for Vue's defineAsyncComponent
    expect(result).toContain('module.exports.default=module.exports=_sfc_main')
  })

  it('handles Vue component with both default and named exports', () => {
    const code = `const _sfc_main = {};const _sfc_export = 1;export { _sfc_main as default, _sfc_export };`
    const result = transformESMViaAST(code, 'component.js')
    expect(result).toContain('module.exports.default=module.exports=_sfc_main')
    expect(result).toContain('module.exports._sfc_export=_sfc_export')
  })
})
