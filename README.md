# InkPad

A small OneNote-style notes app that runs in the browser and installs as an app on Windows, Mac, iPad and iPhone.

## Features (phase 1)

- Free canvas pages: scroll and zoom anywhere
- **Pen** and **highlighter**, pressure-sensitive with Apple Pencil and Surface Pen
- **Palm rejection**: once a pen is used, fingers scroll and pinch instead of drawing (toggle with the ✋ button)
- **Double-tap with a finger** to switch pen ⇄ eraser (Safari doesn't let web apps see the Apple Pencil's own double-tap)
- **Text boxes**: pick the **T** tool and click anywhere to type. Drag the grey bar on top to move a box. Pick a colour and size (small, medium or large) for each box.
- **Images**: paste (Ctrl/⌘+V or the clipboard button), insert from file or photos, or drag and drop. Move and resize them freely.
  The paste button opens a "Paste here" box when the browser can't read the clipboard directly (e.g. Safari over plain http): tap it and choose Paste.
- Select tool: click, or drag a rectangle to select. Move, delete, or resize with the round handle.
- Undo and redo, multiple pages, and everything is saved on the device (IndexedDB), so it works offline
- **Light / Dark / Auto** theme (the ◐ button, top right). Black ink and text turn white on dark paper; printing is always light.

## Organising pages

- **Folders inside folders**, as deep as you need (e.g. Mathematics › Linear algebra). Use the ⋯ next to a folder to add a sub-folder, rename, move up/down, move or delete it (deleting keeps its pages).
- **Two columns** on iPad and PC: folders on the left, the pages of the selected folder next to them. ☰ hides both while writing. On iPhone you step into folders like the Files app.
- Pages are listed **oldest first**; drag the ≡ handle to arrange them by hand. ⋯ → **Move to…** moves a page to another folder.
- **Recent** shows the last edited pages; **Search** (or Ctrl/⌘+K) looks through titles, typed text boxes and documents (not handwriting).
- The folder path is shown above the page title; tap it to jump to the folder.

## Documents (phase 2)

Tap **+** → **Document** for formal writing in Markdown:

- Write / Split / Preview views; the source itself shows headings, bold and italics
- Toolbar for headings, bold, italic, strikethrough, code, lists, checklists, quotes, links, tables, code blocks and dividers
- Math with KaTeX: `$E=mc^2$` inline, `$$ ... $$` as a block
- Pictures: picture button, paste or drag and drop (stored on the device as `inkpad-img:` links)
- Tick checkboxes directly in the preview
- Enter continues lists; Ctrl/⌘+B, I and K for bold, italic and link
- **⤓ .md** downloads the Markdown file; **Print / PDF** prints only the document (choose “Save as PDF”)

## Sync (phase 3)

Notes sync through a **private** GitHub repository; the app itself is published on GitHub Pages.

- Tap the sync line at the bottom of the page list → enter your GitHub user name, the notes repository and an access token.
- Every device keeps a full copy and works offline; changes are uploaded a few seconds after you stop editing, every 20 s while the app is open, and when you switch away from it.
- Each upload is a new small file, so devices never overwrite each other; edits from different devices are merged.
- Many small files are merged into one snapshot automatically to keep the repository small.

Repository layout: `workspace/` (page list), `pages/<id>/` (page contents), `images/` (pictures).

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
| Delete | Delete selection |
| Space + drag, middle mouse, wheel | Scroll |
| Ctrl/⌘ + wheel, trackpad pinch | Zoom |

## Roadmap

1. ✅ Canvas, text, images, pen
2. ✅ Markdown documents
3. ✅ Sync between devices through a private GitHub repository, with the app hosted on GitHub Pages
