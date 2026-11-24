/**
 * What the NeatNotes Windows app (electron/preload.cjs) offers the page.
 * Undefined in the browser: the web app never touches local files.
 *
 * The page cannot reach the disk itself: it can only read and write files
 * inside two folders, by paths relative to them:
 * - 'notes':  the notes folder the user chose (only notes: safe to back up or share via OneDrive)
 * - 'device': this computer's own state (sync bookkeeping), in %AppData%\NeatNotes
 */
export type Root = 'notes' | 'device'

export interface DesktopApi {
  /** the app's version, e.g. "1.0.0" */
  version: string
  /** where the notes are kept (absolute path, for showing to the user) */
  notesFolder: string
  /** names of the files in a folder ([] if it does not exist) */
  list(root: Root, dir: string): Promise<string[]>
  /** a file's bytes, or null if it does not exist */
  read(root: Root, path: string): Promise<Uint8Array | null>
  /** writes a whole file safely (a new file is renamed into place, so it is never half written) */
  write(root: Root, path: string, data: Uint8Array): Promise<void>
  /** deletes a file (no error if it is already gone) */
  remove(root: Root, path: string): Promise<void>
  /** deletes a folder and everything in it */
  removeDir(root: Root, dir: string): Promise<void>
  /** files in the notes folder changed (written by this app, or by e.g. OneDrive); paths relative to it */
  onNotesChanged(fn: (paths: string[]) => void): () => void
  /** the window is closing: `fn` writes everything not written yet; the window closes when it is done */
  onFlushRequest(fn: () => Promise<void>): void
  /** a secret (the GitHub token), kept encrypted for this Windows user */
  secretGet(key: string): string | null
  secretSet(key: string, value: string | null): void
  /** opens a web address in the default browser */
  openExternal(url: string): void
  /** shows the notes folder in Explorer */
  revealNotesFolder(): void
  /**
   * Lets the user pick another notes folder (Windows dialogs) and moves the notes there, or combines
   * them with / switches to notes already there. The page reloads when the folder changed.
   */
  changeFolder(syncOn: boolean): Promise<'move' | 'combine' | 'switch' | 'cancelled' | 'failed'>
}

export const desktop: DesktopApi | undefined = (window as unknown as { neatnotes?: DesktopApi }).neatnotes
export const isDesktop = desktop !== undefined
