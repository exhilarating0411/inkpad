/**
 * Keeps uploads within GitHub's limit on writes ("content-generating
 * requests": 500 an hour and 80 a minute per account).
 *
 * A token bucket: it holds at most CAPACITY writes and refills at PER_HOUR
 * writes an hour. Every write request takes one token. So in any hour at most
 * CAPACITY + PER_HOUR (+ FLUSH_DEBT) writes are made: 30 + 400 + 15 = 445,
 * safely below 500; in any minute at most about 37, below 80.
 *
 * Short bursts (write, pause, write) are uploaded at once; long continuous
 * writing is uploaded about every half minute.
 */

export const CAPACITY = 30
export const PER_HOUR = 400
/**
 * When the app is put away, its changes are uploaded even if the bucket is
 * empty (the device may not run again for a while), going at most this far
 * into debt, which is paid back before anything else is uploaded.
 */
export const FLUSH_DEBT = 15

const MS_PER_TOKEN = 3_600_000 / PER_HOUR

interface Bucket {
  tokens: number
  /** when `tokens` was last brought up to date */
  at: number
}

export class WriteBudget {
  constructor(
    private load: () => Bucket | null,
    private save: (b: Bucket) => void,
    private now: () => number = Date.now,
  ) {}

  private current(): Bucket {
    const t = this.now()
    const b = this.load()
    if (!b || !Number.isFinite(b.tokens) || !Number.isFinite(b.at) || b.at > t) return { tokens: CAPACITY, at: t }
    return { tokens: Math.min(CAPACITY, b.tokens + (t - b.at) / MS_PER_TOKEN), at: t }
  }

  /** Milliseconds until `writes` may be made (0 = now). `flush` allows going into debt. */
  waitFor(writes: number, flush = false): number {
    const b = this.current()
    const floor = flush ? -FLUSH_DEBT : 0
    const missing = writes - (b.tokens - floor)
    return missing <= 0 ? 0 : Math.ceil(missing * MS_PER_TOKEN)
  }

  /** Records `writes` write requests. */
  spend(writes: number) {
    const b = this.current()
    this.save({ tokens: b.tokens - writes, at: b.at })
  }
}

const KEY = 'inkpad:write-budget'
export const writeBudget = new WriteBudget(
  () => {
    try {
      return JSON.parse(localStorage.getItem(KEY) ?? 'null')
    } catch {
      return null
    }
  },
  (b) => localStorage.setItem(KEY, JSON.stringify(b)),
)
