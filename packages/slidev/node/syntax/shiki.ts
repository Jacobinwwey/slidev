import type { ResolvedSlidevOptions } from '@slidev/types'
import type { ShikiTransformer } from 'shiki'
import { isTruthy } from '@antfu/utils'
import { fromAsyncCodeToHtml } from '@shikijs/markdown-it/async'

export default async function MarkdownItShiki({ data: { config }, mode, utils: { shiki, shikiOptions } }: ResolvedSlidevOptions) {
  async function getTwoslashTransformer() {
    const [, , { transformerTwoslash }] = await Promise.all([
      // trigger shiki to load the langs
      shiki.codeToHast('', { lang: 'js', ...shikiOptions }),
      shiki.codeToHast('', { lang: 'ts', ...shikiOptions }),

      import('@shikijs/vitepress-twoslash'),
    ])
    return transformerTwoslash({
      explicitTrigger: true,
      twoslashOptions: {
        compilerOptions: {
          ignoreDeprecations: '6.0',
        },
        handbookOptions: {
          noErrorValidation: true,
        },
      },
    })
  }

  const transformers = [
    ...shikiOptions.transformers || [],
    (config.twoslash === true || config.twoslash === mode) && await getTwoslashTransformer(),
    (config.twoslash === true || config.twoslash === mode) && transformerTwoslashConditional(),
    {
      pre(pre) {
        this.addClassToHast(pre, 'slidev-code')
        delete pre.properties.tabindex
      },
    } satisfies ShikiTransformer,
  ].filter(isTruthy) as ShikiTransformer[]

  // Wrap codeToHtml so a code fence using a language Shiki hasn't bundled
  // (e.g. `pseudo`, custom grammars) degrades to plain rendering instead of
  // failing the whole build with `ShikiError: Language '...' is not included
  // in this bundle`. On such a failure we re-render with `lang: 'text'` and
  // restore the original `language-<lang>` class so styling/CSS selectors
  // still apply. Known languages are unaffected.
  const rawCodeToHtml = shiki.codeToHtml.bind(shiki)
  const safeCodeToHtml: typeof shiki.codeToHtml = async (code, options) => {
    try {
      return await rawCodeToHtml(code, options as any)
    }
    catch (err: any) {
      const msg = String(err?.message || '')
      if (/is not included in this bundle|Language .* not .*load/i.test(msg)) {
        // Unknown/un-bundled grammar (e.g. `pseudo`, custom langs): re-render as
        // plain text and restore the original `language-<lang>` class so code
        // block styling & CSS selectors still apply.
        return (await rawCodeToHtml(code, { ...(options as any), lang: 'text' }))
          .replace('class="language-text', `class="language-${((options as any)?.lang) || 'text'}`)
      }
      throw err
    }
  }

  return fromAsyncCodeToHtml(safeCodeToHtml, {
    ...shikiOptions,
    transformers,
  })
}

// Fix #2202
function transformerTwoslashConditional(): ShikiTransformer {
  return {
    name: 'slidev:twoslash-conditional',
    code: function applyConditionalFlag(this: any, node) {
      if (node.tagName === 'v-menu') {
        if (node.properties[':shown'] === 'true')
          node.properties[':shown'] = '$nav.currentPage === $page'
      }
      else {
        for (const child of node.children) {
          if (child.type === 'element')
            applyConditionalFlag(child)
        }
      }
    },
  }
}
