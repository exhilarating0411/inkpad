import { useEffect, useRef, useState } from 'react'
import * as Y from 'yjs'
import { EditorState } from '@codemirror/state'
import { EditorView, keymap, placeholder } from '@codemirror/view'
import { defaultKeymap, indentWithTab } from '@codemirror/commands'
import { markdown } from '@codemirror/lang-markdown'
import { HighlightStyle, syntaxHighlighting } from '@codemirror/language'
import { tags as t } from '@lezer/highlight'
import { yCollab, yUndoManagerKeymap } from 'y-codemirror.next'
import { openPage } from '../store/workspace'
import { imageUrl, storeImage } from '../store/images'
import { IMG_SCHEME, renderMarkdown, toggleTask } from './render'
import { md } from './commands'
import { Icons } from '../components/icons'

type Mode = 'edit' | 'split' | 'preview'

const isWide = () => window.matchMedia('(min-width: 900px)').matches

// Makes the source itself look like a document: big headings, bold, italics…
const docHighlight = HighlightStyle.define([
  { tag: t.heading1, fontSize: '1.6em', fontWeight: '700' },
  { tag: t.heading2, fontSize: '1.35em', fontWeight: '700' },
  { tag: t.heading3, fontSize: '1.15em', fontWeight: '700' },
  { tag: [t.heading4, t.heading5, t.heading6], fontWeight: '700' },
  { tag: t.strong, fontWeight: '700' },
  { tag: t.emphasis, fontStyle: 'italic' },
  { tag: t.strikethrough, textDecoration: 'line-through' },
  { tag: t.link, color: '#2563eb' },
  { tag: t.url, color: '#2563eb', opacity: '0.7' },
  { tag: t.monospace, fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace', color: '#b4235a' },
  { tag: t.quote, color: '#6b665c', fontStyle: 'italic' },
  { tag: [t.processingInstruction, t.meta, t.contentSeparator], color: '#a8a294' },
])

export default function MarkdownPage({ pageId, title }: { pageId: string; title: string }) {
  const page = openPage(pageId)
  const ytext = page.doc.getText('markdown')
  const hostRef = useRef<HTMLDivElement>(null)
  const viewRef = useRef<EditorView | null>(null)
  const undoRef = useRef<Y.UndoManager | null>(null)
  const previewRef = useRef<HTMLDivElement>(null)
  const fileRef = useRef<HTMLInputElement>(null)
  const insertImagesRef = useRef<(files: File[]) => void>(() => {})
  const [mode, setMode] = useState<Mode>(() => (localStorage.getItem('inkpad:mdmode') as Mode) ?? (isWide() ? 'split' : 'edit'))
  const [html, setHtml] = useState('')
  const [words, setWords] = useState(0)

  useEffect(() => localStorage.setItem('inkpad:mdmode', mode), [mode])

  // ---------- editor ----------
  useEffect(() => {
    const undoManager = new Y.UndoManager(ytext)
    undoRef.current = undoManager

    const insertImages = async (view: EditorView, files: File[]) => {
      let text = ''
      for (const f of files) {
        const img = await storeImage(f)
        text += `![](${IMG_SCHEME}${img.id})\n`
      }
      const { from, to } = view.state.selection.main
      const line = view.state.doc.lineAt(from)
      const lead = line.text.trim() && from > line.from ? '\n' : ''
      view.dispatch({ changes: { from, to, insert: lead + text }, selection: { anchor: from + lead.length + text.length } })
    }
    const imageFiles = (dt: DataTransfer | null) =>
      dt ? [...dt.files].filter((f) => f.type.startsWith('image/')) : []

    const view = new EditorView({
      parent: hostRef.current!,
      state: EditorState.create({
        doc: ytext.toString(),
        extensions: [
          keymap.of([
            ...yUndoManagerKeymap,
            { key: 'Mod-b', run: (v) => (md.bold(v), true) },
            { key: 'Mod-i', run: (v) => (md.italic(v), true) },
            { key: 'Mod-k', run: (v) => (md.link(v), true) },
            ...defaultKeymap,
            indentWithTab,
          ]),
          markdown(),
          syntaxHighlighting(docHighlight),
          EditorView.lineWrapping,
          placeholder('Start writing… Use # for headings, - for lists, $x^2$ for math.'),
          yCollab(ytext, null, { undoManager }),
          EditorView.domEventHandlers({
            paste(e, v) {
              const files = imageFiles(e.clipboardData)
              if (!files.length) return false
              e.preventDefault()
              void insertImages(v, files)
              return true
            },
            drop(e, v) {
              const files = imageFiles(e.dataTransfer)
              if (!files.length) return false
              e.preventDefault()
              const pos = v.posAtCoords({ x: e.clientX, y: e.clientY })
              if (pos !== null) v.dispatch({ selection: { anchor: pos } })
              void insertImages(v, files)
              return true
            },
          }),
        ],
      }),
    })
    viewRef.current = view
    insertImagesRef.current = (files) => void insertImages(view, files)
    return () => {
      view.destroy()
      undoManager.destroy()
      viewRef.current = null
    }
  }, [ytext])

  // ---------- preview ----------
  useEffect(() => {
    let timer = 0
    const update = () => {
      const src = ytext.toString()
      setHtml(renderMarkdown(src))
      setWords((src.match(/[\p{L}\p{N}]+/gu) ?? []).length)
    }
    const schedule = () => {
      clearTimeout(timer)
      timer = window.setTimeout(update, 120)
    }
    update()
    ytext.observe(schedule)
    page.ready.then(update)
    return () => {
      clearTimeout(timer)
      ytext.unobserve(schedule)
    }
  }, [ytext, page])

  // Fill in pictures stored on this device and make task checkboxes clickable.
  useEffect(() => {
    const root = previewRef.current
    if (!root) return
    root.querySelectorAll<HTMLImageElement>('img[data-inkpad-id]').forEach((img) => {
      imageUrl(img.dataset.inkpadId!).then((url) => {
        if (url) img.src = url
        else img.alt = 'image not available on this device yet'
      })
    })
    root.querySelectorAll<HTMLInputElement>('input[type=checkbox]').forEach((box, i) => {
      box.disabled = false
      box.dataset.task = String(i)
    })
    root.querySelectorAll<HTMLAnchorElement>('a[href^="http"]').forEach((a) => {
      a.target = '_blank'
      a.rel = 'noopener noreferrer'
    })
  }, [html, mode])

  const onPreviewClick = (e: React.MouseEvent) => {
    const box = e.target as HTMLInputElement
    if (box.tagName !== 'INPUT' || box.dataset.task === undefined) return
    const view = viewRef.current
    if (!view) return
    const change = toggleTask(view.state.doc.toString(), Number(box.dataset.task))
    if (change) view.dispatch({ changes: change })
  }

  // ---------- toolbar ----------
  const run = (fn: (v: EditorView) => void) => () => {
    const v = viewRef.current
    if (!v) return
    if (mode === 'preview') setMode(isWide() ? 'split' : 'edit')
    fn(v)
  }
  const keepFocus = { onMouseDown: (e: React.MouseEvent) => e.preventDefault() }
  const B = (p: { label: string; title: string; onClick(): void; className?: string; children?: React.ReactNode }) => (
    <button {...keepFocus} className={'mbtn ' + (p.className ?? '')} title={p.title} aria-label={p.title} onClick={p.onClick}>
      {p.children ?? p.label}
    </button>
  )

  const exportMd = () => {
    const blob = new Blob([ytext.toString()], { type: 'text/markdown' })
    const a = document.createElement('a')
    a.href = URL.createObjectURL(blob)
    a.download = `${(title || 'document').replace(/[\\/:*?"<>|]+/g, '_')}.md`
    a.click()
    setTimeout(() => URL.revokeObjectURL(a.href), 1000)
  }

  return (
    <div className={`md-page mode-${mode}`}>
      <div className="toolbar md-toolbar" role="toolbar">
        <div className="group seg">
          {(['edit', 'split', 'preview'] as const).map((m) => (
            <button key={m} className={'seg-btn' + (mode === m ? ' active' : '')} onClick={() => setMode(m)}>
              {m === 'edit' ? 'Write' : m === 'split' ? 'Split' : 'Preview'}
            </button>
          ))}
        </div>
        <div className="group">
          <B label="H1" title="Heading 1" onClick={run((v) => md.heading(v, 1))} />
          <B label="H2" title="Heading 2" onClick={run((v) => md.heading(v, 2))} />
          <B label="H3" title="Heading 3" onClick={run((v) => md.heading(v, 3))} />
        </div>
        <div className="group">
          <B label="B" title="Bold (Ctrl/⌘+B)" className="b" onClick={run(md.bold)} />
          <B label="I" title="Italic (Ctrl/⌘+I)" className="i" onClick={run(md.italic)} />
          <B label="S" title="Strikethrough" className="s" onClick={run(md.strike)} />
          <B label="</>" title="Inline code" className="mono" onClick={run(md.code)} />
        </div>
        <div className="group">
          <B label="•" title="Bullet list" onClick={run(md.bullet)} />
          <B label="1." title="Numbered list" onClick={run(md.numbered)} />
          <B label="☑" title="Checklist" onClick={run(md.task)} />
          <B label="❝" title="Quote" onClick={run(md.quote)} />
        </div>
        <div className="group">
          <B label="🔗" title="Link (Ctrl/⌘+K)" onClick={run(md.link)} />
          <B label="▦" title="Table" onClick={run(md.table)} />
          <B label="{ }" title="Code block" className="mono" onClick={run(md.codeBlock)} />
          <B label="∑" title="Math formula" onClick={run(md.math)} />
          <B label="∑∑" title="Math block" onClick={run(md.mathBlock)} />
          <B label="—" title="Divider" onClick={run(md.divider)} />
          <B label="" title="Insert picture" onClick={() => fileRef.current?.click()}>
            {Icons.image}
          </B>
          <input
            ref={fileRef}
            type="file"
            accept="image/*"
            multiple
            hidden
            onChange={(e) => {
              const files = [...(e.target.files ?? [])]
              e.target.value = ''
              if (files.length) insertImagesRef.current(files)
            }}
          />
        </div>
        <div className="group">
          <B label="" title="Undo" onClick={() => undoRef.current?.undo()}>
            {Icons.undo}
          </B>
          <B label="" title="Redo" onClick={() => undoRef.current?.redo()}>
            {Icons.redo}
          </B>
        </div>
        <div className="group">
          <B label="⤓ .md" title="Download as Markdown file" onClick={exportMd} />
          <B label="Print / PDF" title="Print or save as PDF" onClick={() => window.print()} />
        </div>
      </div>
      <div className="md-body">
        <div className="md-editor" ref={hostRef} />
        <article className="md-preview" ref={previewRef} onClick={onPreviewClick}>
          {title && <h1 className="print-title">{title}</h1>}
          <div dangerouslySetInnerHTML={{ __html: html }} />
        </article>
      </div>
      <div className="md-status">{words} words · saved on this device</div>
    </div>
  )
}
