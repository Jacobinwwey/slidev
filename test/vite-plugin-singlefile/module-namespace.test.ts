import { runInNewContext } from 'node:vm'
import { describe, expect, it } from 'vitest'
import { transformESMForBundle } from '../../packages/slidev/node/commands/vite-plugin-singlefile/index'

function executeModule(source: string, dependencies: Record<string, unknown> = {}) {
  const module = { exports: {} as Record<string | symbol, any> }
  runInNewContext(transformESMForBundle(source, 'entry.js'), {
    module,
    exports: module.exports,
    __require: (name: string) => dependencies[name],
  })
  return module.exports
}

describe('standalone module namespaces', () => {
  it('retains named exports on both sides of a default component export', () => {
    const namespace = executeModule(`
      const layout = () => 'dagre'; const component = { name: 'Slide' }; const after = 7;
      export { layout, component as default, after };
    `)
    expect(namespace.layout()).toBe('dagre')
    expect(namespace.after).toBe(7)
    expect(namespace.default.name).toBe('Slide')
    expect(namespace[Symbol.toStringTag]).toBe('Module')
  })

  it.each(['0', 'false', 'null'])('preserves primitive default %s without replacing the namespace', (literal) => {
    const namespace = executeModule(`export const named = 1; export default ${literal};`)
    expect(namespace.named).toBe(1)
    expect(namespace.default).toBe(JSON.parse(literal))
  })

  it('keeps default re-exports alongside named bindings', () => {
    const namespace = executeModule(`export const named = 1; export { component as default } from 'dep';`, {
      dep: { component: { name: 'RemoteSlide' } },
    })
    expect(namespace.named).toBe(1)
    expect(namespace.default.name).toBe('RemoteSlide')
  })
})
