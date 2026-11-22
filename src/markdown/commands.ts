import { EditorSelection } from '@codemirror/state'
import type { EditorView } from '@codemirror/view'

/** Wraps each selection in before/after, or unwraps it if it is already wrapped. */
export function wrap(view: EditorView, before: string, after = before, fallback = 'text') {
  const { state } = view
  view.dispatch(
    state.changeByRange((range) => {
      const pre = state.sliceDoc(range.from - before.length, range.from)
      const post = state.sliceDoc(range.to, range.to + after.length)
      if (!range.empty && pre === before && post === after) {
        return {
          changes: [
            { from: range.from - before.length, to: range.from, insert: '' },
            { from: range.to, to: range.to + after.length, insert: '' },
          ],
          range: EditorSelection.range(range.from - before.length, range.to - before.length),
        }
      }
      const inner = state.sliceDoc(range.from, range.to) || fallback
      return {
        changes: { from: range.from, to: range.to, insert: before + inner + after },
        range: EditorSelection.range(range.from + before.length, range.from + before.length + inner.length),
      }
    }),
  )
  view.focus()
}

const BLOCK_PREFIX = /^(#{1,6}[ \t]+|>[ \t]?|[-*+][ \t]+\[[ xX]\][ \t]+|[-*+][ \t]+|\d+[.)][ \t]+)/

/**
 * Gives every selected line the block prefix (heading, list, quote…).
 * If all lines already have exactly that kind of prefix it is removed instead.
 */
export function setLinePrefix(view: EditorView, prefix: string | ((i: number) => string), same: RegExp) {
  const { state } = view
  const lines = new Set<number>()
  for (const r of state.selection.ranges) {
    for (let n = state.doc.lineAt(r.from).number; n <= state.doc.lineAt(r.to).number; n++) lines.add(n)
  }
  const nums = [...lines].sort((a, b) => a - b)
  const allSame = nums.every((n) => same.test(state.doc.line(n).text))
  const changes = nums.map((n, i) => {
    const line = state.doc.line(n)
    const existing = line.text.match(BLOCK_PREFIX)?.[0] ?? ''
    const insert = allSame ? '' : typeof prefix === 'function' ? prefix(i) : prefix
    return { from: line.from, to: line.from + existing.length, insert }
  })
  view.dispatch({ changes })
  view.focus()
}

/** Inserts a block (table, code, math…) on its own lines; `cursor` is the caret offset inside `text`. */
export function insertBlock(view: EditorView, text: string, cursor = text.length) {
  const { state } = view
  const range = state.selection.main
  const line = state.doc.lineAt(range.from)
  const needBreakBefore = line.text.trim().length > 0 && range.from > line.from
  const lead = needBreakBefore ? '\n\n' : ''
  view.dispatch({
    changes: { from: range.from, to: range.to, insert: lead + text },
    selection: { anchor: range.from + lead.length + cursor },
  })
  view.focus()
}

export const md = {
  bold: (v: EditorView) => wrap(v, '**'),
  italic: (v: EditorView) => wrap(v, '*'),
  strike: (v: EditorView) => wrap(v, '~~'),
  code: (v: EditorView) => wrap(v, '`', '`', 'code'),
  math: (v: EditorView) => wrap(v, '$', '$', 'x^2'),
  link: (v: EditorView) => wrap(v, '[', '](https://)', 'link text'),
  heading: (v: EditorView, level: number) => setLinePrefix(v, '#'.repeat(level) + ' ', new RegExp(`^#{${level}}[ \\t]`)),
  bullet: (v: EditorView) => setLinePrefix(v, '- ', /^[-*+][ \t]+(?!\[[ xX]\])/),
  numbered: (v: EditorView) => setLinePrefix(v, (i) => `${i + 1}. `, /^\d+[.)][ \t]/),
  task: (v: EditorView) => setLinePrefix(v, '- [ ] ', /^[-*+][ \t]+\[[ xX]\]/),
  quote: (v: EditorView) => setLinePrefix(v, '> ', /^>/),
  codeBlock: (v: EditorView) => {
    const sel = v.state.sliceDoc(v.state.selection.main.from, v.state.selection.main.to)
    insertBlock(v, '```\n' + sel + '\n```\n', 4 + sel.length)
  },
  mathBlock: (v: EditorView) => insertBlock(v, '$$\n\n$$\n', 3),
  table: (v: EditorView) => insertBlock(v, '| Column 1 | Column 2 | Column 3 |\n| --- | --- | --- |\n|  |  |  |\n', 2),
  divider: (v: EditorView) => insertBlock(v, '\n---\n\n'),
}
