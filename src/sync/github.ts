/**
 * Minimal GitHub client for a private "notes" repository.
 * Uses the Git Data API so one sync = one commit, however many files change.
 * Small files are sent inside the tree request itself, so a commit costs only
 * three write requests (tree, commit, branch update) however many there are.
 */

export interface SyncConfig {
  owner: string
  repo: string
  branch: string
  token: string
  /** only for tests: a GitHub-compatible API at another address */
  apiBase?: string
}

export interface RemoteFile {
  path: string
  sha: string
}

/** A file to commit: `text` is sent inside the tree request, `data` is uploaded as a blob first. */
export type NewFile = { path: string; text: string } | { path: string; data: Uint8Array }

export class GitHubError extends Error {
  constructor(
    message: string,
    public status: number,
    /** GitHub asked us not to send anything before this time (ms since 1970) */
    public retryAt?: number,
  ) {
    super(message)
  }
}

/** When GitHub's rate limit lets us try again, or undefined if this is not a rate-limit answer. */
function retryTime(res: Response, message: string): number | undefined {
  const after = Number(res.headers.get('retry-after'))
  if (after > 0) return Date.now() + after * 1000
  if (res.headers.get('x-ratelimit-remaining') === '0') {
    const reset = Number(res.headers.get('x-ratelimit-reset'))
    if (reset > 0) return reset * 1000 + 1000
  }
  // secondary limit without a time given: GitHub asks to wait at least a minute
  if ((res.status === 403 || res.status === 429) && /rate limit/i.test(message)) return Date.now() + 60_000
  return undefined
}

export function toBase64(bytes: Uint8Array): string {
  let s = ''
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  return btoa(s)
}

export function fromBase64(b64: string): Uint8Array {
  const s = atob(b64.replace(/\s/g, ''))
  const out = new Uint8Array(s.length)
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i)
  return out
}

export class GitHub {
  private refEtag = ''
  private refSha = ''

  constructor(private cfg: SyncConfig) {}

  private get base() {
    return `${this.cfg.apiBase ?? 'https://api.github.com'}/repos/${encodeURIComponent(this.cfg.owner)}/${encodeURIComponent(this.cfg.repo)}`
  }

  private async req<T>(path: string, init: RequestInit & { raw?: boolean } = {}): Promise<{ status: number; data: T; res: Response }> {
    const res = await fetch(this.base + path, {
      ...init,
      cache: 'no-store',
      headers: {
        Accept: init.raw ? 'application/vnd.github.raw+json' : 'application/vnd.github+json',
        Authorization: `Bearer ${this.cfg.token}`,
        'X-GitHub-Api-Version': '2022-11-28',
        ...(init.body ? { 'Content-Type': 'application/json' } : {}),
        ...(init.headers ?? {}),
      },
    })
    if (res.status === 304) return { status: 304, data: undefined as T, res }
    if (!res.ok) {
      let msg = res.statusText
      try {
        msg = (await res.json()).message ?? msg
      } catch {
        /* not json */
      }
      throw new GitHubError(explain(res.status, msg), res.status, retryTime(res, msg))
    }
    const data = init.raw ? ((await res.arrayBuffer()) as T) : ((await res.json()) as T)
    return { status: res.status, data, res }
  }

  /** Checks token + repository; creates a first commit if the repository is empty. */
  async check(): Promise<void> {
    const { data } = await this.req<{ private: boolean; permissions?: { push?: boolean } }>('')
    if (data.permissions && !data.permissions.push) throw new GitHubError('This token cannot write to the repository. Give it “Contents: Read and write”.', 403)
    try {
      await this.head()
    } catch (e) {
      if (e instanceof GitHubError && (e.status === 409 || e.status === 404)) {
        // empty repository: the contents API can create the first commit
        await this.req(`/contents/README.md`, {
          method: 'PUT',
          body: JSON.stringify({
            message: 'Create InkPad notes repository',
            content: btoa('# InkPad notes\n\nSynced data of the InkPad app. Do not edit by hand.\n'),
            branch: this.cfg.branch,
          }),
        })
        this.refEtag = ''
      } else throw e
    }
  }

  /** Current commit of the branch. Cheap: unchanged answers (304) do not count against the rate limit. */
  async head(): Promise<string> {
    const r = await this.req<{ object: { sha: string } }>(`/git/ref/heads/${encodeURIComponent(this.cfg.branch)}`, {
      headers: this.refEtag ? { 'If-None-Match': this.refEtag } : {},
    })
    if (r.status === 304) return this.refSha
    this.refEtag = r.res.headers.get('ETag') ?? ''
    this.refSha = r.data.object.sha
    return this.refSha
  }

  /** All files of a commit, and the id of its tree (needed to build the next commit on top of it). */
  async listFiles(commitSha: string): Promise<{ files: RemoteFile[]; tree: string }> {
    const { data: commit } = await this.req<{ tree: { sha: string } }>(`/git/commits/${commitSha}`)
    const { data } = await this.req<{ tree: { path: string; sha: string; type: string }[]; truncated: boolean }>(
      `/git/trees/${commit.tree.sha}?recursive=1`,
    )
    if (data.truncated) console.warn('GitHub tree listing truncated; some files may sync late')
    return { files: data.tree.filter((e) => e.type === 'blob').map((e) => ({ path: e.path, sha: e.sha })), tree: commit.tree.sha }
  }

  async getBlob(sha: string): Promise<Uint8Array> {
    const { data } = await this.req<{ content: string; encoding: string }>(`/git/blobs/${sha}`)
    return fromBase64(data.content)
  }

  /** Downloads a file by path (used for pictures). */
  async getFile(path: string): Promise<Uint8Array | null> {
    try {
      const { data } = await this.req<ArrayBuffer>(`/contents/${path}?ref=${encodeURIComponent(this.cfg.branch)}`, { raw: true })
      return new Uint8Array(data)
    } catch (e) {
      if (e instanceof GitHubError && e.status === 404) return null
      throw e
    }
  }

  /** Write requests a commit of these files costs: one per blob, plus tree, commit and branch update. */
  static writesFor(add: NewFile[]): number {
    return add.filter((f) => 'data' in f).length + 3
  }

  /**
   * Adds/removes files in one commit on top of `parent`.
   * `parentTree` must be the tree of `parent` if given (saves a request).
   * Returns the new commit and its tree, or null if someone else pushed first (caller retries).
   */
  async commit(
    parent: string,
    message: string,
    add: NewFile[],
    remove: string[],
    parentTree?: string,
  ): Promise<{ commit: string; tree: string } | null> {
    // blobs first (pictures and very large files), at the same time
    const tree: { path: string; mode: string; type: string; sha?: string | null; content?: string }[] = await Promise.all(
      add.map(async (f) => {
        if ('text' in f) return { path: f.path, mode: '100644', type: 'blob', content: f.text }
        const { data } = await this.req<{ sha: string }>('/git/blobs', {
          method: 'POST',
          body: JSON.stringify({ content: toBase64(f.data), encoding: 'base64' }),
        })
        return { path: f.path, mode: '100644', type: 'blob', sha: data.sha }
      }),
    )
    for (const path of remove) tree.push({ path, mode: '100644', type: 'blob', sha: null })
    const baseTree = parentTree ?? (await this.req<{ tree: { sha: string } }>(`/git/commits/${parent}`)).data.tree.sha
    const { data: newTree } = await this.req<{ sha: string }>('/git/trees', {
      method: 'POST',
      body: JSON.stringify({ base_tree: baseTree, tree }),
    })
    const { data: commit } = await this.req<{ sha: string }>('/git/commits', {
      method: 'POST',
      body: JSON.stringify({ message, tree: newTree.sha, parents: [parent] }),
    })
    try {
      await this.req(`/git/refs/heads/${encodeURIComponent(this.cfg.branch)}`, {
        method: 'PATCH',
        body: JSON.stringify({ sha: commit.sha, force: false }),
      })
    } catch (e) {
      // 422 = not a fast-forward: another device pushed in between
      if (e instanceof GitHubError && (e.status === 422 || e.status === 409)) return null
      throw e
    }
    this.refSha = commit.sha
    this.refEtag = ''
    return { commit: commit.sha, tree: newTree.sha }
  }
}

function explain(status: number, msg: string): string {
  if (status === 401) return 'The token is wrong or has expired.'
  if ((status === 403 || status === 429) && /rate limit/i.test(msg)) return 'GitHub asked to slow down; sync continues automatically.'
  if (status === 403) return 'The token is not allowed to do this. Check its repository access and “Contents: Read and write”.'
  if (status === 404) return 'Repository not found. Check the owner and name, and that the token can access it.'
  return `GitHub error ${status}: ${msg}`
}
