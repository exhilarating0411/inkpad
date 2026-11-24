# Notes

A small OneNote-style notes app that runs in the browser and installs as an app on Windows, Mac, iPad and iPhone.

## Features (phase 1)

- Free canvas pages: scroll and zoom anywhere
- **Pen** and **highlighter**; the pen writes like a gel pen (even width, no pressure variation) and is drawn slightly ahead of the pencil tip to feel more direct. Lines stay round even when the device sends pen positions less often (gaps are filled along a curve), and sync waits for a pause in writing before doing its heavier work
- **Palm rejection**: once a pen is used, fingers scroll and pinch instead of drawing (toggle with the ✋ button)
- **Double-tap with a finger** to switch pen ⇄ eraser (Safari doesn't let web apps see the Apple Pencil's own double-tap)
- **Text boxes**: pick the **T** tool and click anywhere to type. Drag the grey bar on top to move a box. Pick a colour and size (small, medium or large) for each box.
- **Images**: paste (Ctrl/⌘+V or the clipboard button), insert from file or photos, or drag and drop. Move and resize them freely.
  The paste button reads the clipboard directly (Safari shows a small **Paste** bubble to tap). Only if that is refused, it opens a "Paste here" box: tap it and choose Paste.
- **Select tool**: draw a loop around handwriting to select it (a lasso; a straight drag selects a rectangle instead), or tap a line, picture or text box. Drag inside the selection to move it; resize pictures and text boxes with the round handle.
- **Copy, cut, paste, duplicate**: the bar above a selection (Copy · Cut · Duplicate · Delete), or Ctrl/⌘+C, X, V, D. Pasting into this app gives real ink again (also on another page, or another Apple device through Universal Clipboard); pasting into other apps (chat, Word, Notes…) gives a picture of the selection, plus any typed text.
- Undo and redo, multiple pages, and everything is saved on the device (IndexedDB), so it works offline
- **Paper**: the page button in the toolbar sets each handwriting page's colour (white, cream, yellow, green, blue, purple, pink, gray) and pattern (plain, dots, grid or lines). New pages use the paper picked last. PDF export keeps it.
- **Light / Dark / Auto** theme (the ◐ button, top right). Black ink and text turn white on dark paper; printing is always light.
- The **version** (build time · commit) is shown at the bottom of the page list. When a newer version is online it says so; close the app completely and open it again to update (on iPad, twice).

## Organising pages

Like OneNote: **notebooks → sections → pages → sub-pages**.

- **Notebooks**: the 📓 button at the top left switches notebooks and creates, renames, exports or deletes them.
- **Sections** are the small coloured tabs along the top (e.g. Probability, Calculus, Linear Algebra). **+** adds one. Tap the open tab again (or right-click any tab) to rename it, change its colour, move it left/right or to another notebook, export it, or delete it.
- **Pages** of the open section are listed on the left; the ▯ button at the top left hides the list while writing. On narrow screens the list slides over the page.
- **Sub-pages**, up to 3 levels. ▾ / ▸ collapses and expands a page's sub-pages (remembered on each device). Drag the ≡ handle up/down to reorder, sideways to nest or un-nest, or onto a section tab to move the page there. The ⋯ menu also has **Add sub-page**, **Make sub-page**, **Promote** and **Move to section…**.
- Deleting a page keeps its sub-pages (they move up one level). Deleting a section or notebook deletes its pages.
- **Search** (🔍 or Ctrl/⌘+K) looks in the open notebook; one tap widens it to all notebooks. It finds titles, typed text boxes and documents (not handwriting). With an empty search box it shows the recently edited pages.
- Older data with folders is converted automatically: each top-level folder becomes a section, a sub-folder becomes a page with its pages as sub-pages, and pages outside folders go to an “Unsorted” section.

## Export to PDF

Export a page (with its sub-pages), a section or a whole notebook from its menu. The PDF is made on the device and downloaded directly (on iPad: **Share / Save to Files**).

- Handwriting stays sharp vector ink; each handwriting page becomes one PDF page as big as its content, so nothing is cut.
- Documents are laid out like the preview (formulas, tables, pictures) on A4 pages, broken between paragraphs.
- Bookmarks follow notebook → section → page → sub-page.
- Typed text and documents are embedded as high-resolution images, so any language works but the text cannot be selected in the PDF.

## Documents (phase 2)

Tap **+** → **Document** for formal writing in Markdown:

- Write / Split / Preview views; the source itself shows headings, bold and italics
- Toolbar for headings, bold, italic, strikethrough, code, lists, checklists, quotes, links, tables, code blocks and dividers
- Math with KaTeX: `$E=mc^2$` inline, `$$ ... $$` as a block
- Pictures: picture button, paste or drag and drop (stored on the device as `inkpad-img:` links)
- Tick checkboxes directly in the preview
- Enter continues lists; Ctrl/⌘+B, I and K for bold, italic and link
- **⤓ .md** downloads the Markdown file; **Print / PDF** prints only the document (choose “Save as PDF”; the browser keeps the text selectable)

## Sync (phase 3)

Notes sync through a **private** GitHub repository; the app itself is published on GitHub Pages.

- Tap the sync line at the bottom of the page list → enter your GitHub user name, the notes repository and an access token.
- Every device keeps a full copy and works offline. Changes are uploaded about 1.5 s after you stop writing and when you switch away from the app; other devices look for changes every 5 s while open, so an edit usually shows up elsewhere within about 5 s.
- GitHub allows about 500 writes an hour. Each upload costs 3, and uploads are spaced to stay well below the limit: short pauses upload at once, long continuous writing uploads about every half minute. If GitHub still asks to slow down, the app waits as long as asked and continues by itself.
- Each upload is a new small file, so devices never overwrite each other; edits from different devices are merged (text written on two devices is kept from both).
- A page stays marked for upload until GitHub has really received it, so a sync cut off by closing the tab is redone next time. On every start the app also compares each page with what GitHub has and uploads anything missing.
- The sync line (and the dot at the top right) shows how many pages are **not uploaded yet**; the dot turns amber while anything is waiting.
- Many small files are merged into one snapshot automatically to keep the repository small.

Repository layout: `v2/workspace/` (page list), `v2/pages/<id>/` (page contents), `images/` (pictures). Older app versions wrote `workspace/` and `pages/`; those files are still read and are merged into `v2/` over time. Update every device: an older version does not see changes stored in `v2/`.

## Run it

```bash
npm install
npm run dev      # http://localhost:5173 , also prints a Network address for other devices on your Wi-Fi
npm run build    # production build in dist/
```

## Shortcuts

| Key | Action |
|---|---|
| V / P / H / E / T | Select / Pen / Highlighter / Eraser / Text |
| Ctrl/⌘+Z, Ctrl/⌘+Shift+Z | Undo / Redo |
| Ctrl/⌘+C, X, V, D | Copy / Cut / Paste / Duplicate |
| Arrow keys (Shift: 10×) | Nudge the selection |
| Delete | Delete selection |
| Space + drag, middle mouse, wheel | Scroll |
| Ctrl/⌘ + wheel, trackpad pinch | Zoom |

## Roadmap

1. ✅ Canvas, text, images, pen
2. ✅ Markdown documents
3. ✅ Sync between devices through a private GitHub repository, with the app hosted on GitHub Pages
