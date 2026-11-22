import { Marked } from 'marked'
import markedKatex from 'marked-katex-extension'
import DOMPurify from 'dompurify'
import 'katex/dist/katex.min.css'

/** Pictures stored in the app are written as ![caption](inkpad-img:<id>) */
export const IMG_SCHEME = 'inkpad-img:'

const escapeAttr = (s: string) => s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;')

const md = new Marked({ gfm: true, breaks: true })
md.use(markedKatex({ throwOnError: false, nonStandard: true }))
md.use({
  renderer: {
    image({ href, title, text }) {
      if (href.startsWith(IMG_SCHEME)) {
        // the real src (a local blob URL) is filled in after rendering
        return `<img data-inkpad-id="${escapeAttr(href.slice(IMG_SCHEME.length))}" alt="${escapeAttr(text)}"${title ? ` title="${escapeAttr(title)}"` : ''}>`
      }
      return false // default rendering
    },
  },
})

export function renderMarkdown(source: string): string {
  const html = md.parse(source, { async: false }) as string
  return DOMPurify.sanitize(html, { ADD_ATTR: ['target'] })
}

/** Finds the n-th task list checkbox ("- [ ]" / "- [x]") in the source and flips it. */
export function toggleTask(source: string, index: number): { from: number; to: number; insert: string } | null {
  const re = /^[ \t]*(?:[-*+]|\d+[.)])[ \t]+\[([ xX])\]/gm
  let m: RegExpExecArray | null
  let i = 0
  while ((m = re.exec(source))) {
    if (i++ === index) {
      const pos = m.index + m[0].length - 2 // the character inside [ ]
      return { from: pos, to: pos + 1, insert: m[1] === ' ' ? 'x' : ' ' }
    }
  }
  return null
}
