/**
 * Keeps sync within GitHub's request limits, using token buckets: a bucket
 * holds at most `capacity` requests and refills at `perHour` an hour; every
 * request takes one token. Short bursts go at once; long ones are spread out.
 *
 * Writes ("content-generating requests": 500 an hour and 80 a minute per
 * account): in any hour at most 30 + 400 (+ 15 debt) = 445, in any minute
 * about 37.
 *
 * Reads (5000 requests an hour in all, and about 900 a minute): downloads may
 * use 300 + 3000 an hour, leaving room for writes, checks for new changes and
 * pictures. An everyday sync needs a handful, so it is never held up; only
 * restoring a large library onto a new device is spread over time.
 */

export interface Limits {
  capacity: number
  perHour: number
  /**
   * Requests that may still be made when the bucket is empty, when it cannot
   * wait (the app is being put away, or the page on screen is missing); paid
   * back before anything else.
   */
  debt: number
}

export const WRITE_LIMITS: Limits = { capacity: 30, perHour: 400, debt: 15 }
export const READ_LIMITS: Limits = { capacity: 300, perHour: 3000, debt: 60 }

interface Bucket {
  tokens: number
  /** when `tokens` was last brought up to date */
  at: number
}

export class TokenBucket {
  private msPerToken: number

  constructor(
    private limits: Limits,
    private load: () => Bucket | null,
    private save: (b: Bucket) => void,
    private now: () => number = Date.now,
  ) {
    this.msPerToken = 3_600_000 / limits.perHour
  }

  private current(): Bucket {
    const t = this.now()
    const b = this.load()
    if (!b || !Number.isFinite(b.tokens) || !Number.isFinite(b.at) || b.at > t) return { tokens: this.limits.capacity, at: t }
    return { tokens: Math.min(this.limits.capacity, b.tokens + (t - b.at) / this.msPerToken), at: t }
  }

  /** Milliseconds until `n` requests may be made (0 = now). `urgent` allows going into debt. */
  waitFor(n: number, urgent = false): number {
    const missing = n - (this.current().tokens + (urgent ? this.limits.debt : 0))
    return missing <= 0 ? 0 : Math.ceil(missing * this.msPerToken)
  }

  /** How many requests may be made now. */
  available(urgent = false): number {
    return Math.max(0, Math.floor(this.current().tokens + (urgent ? this.limits.debt : 0)))
  }

  /** Records `n` requests. */
  spend(n: number) {
    const b = this.current()
    this.save({ tokens: b.tokens - n, at: b.at })
  }
}

function stored(key: string): [() => Bucket | null, (b: Bucket) => void] {
  return [
    () => {
      try {
        return JSON.parse(localStorage.getItem(key) ?? 'null')
      } catch {
        return null
      }
    },
    (b) => localStorage.setItem(key, JSON.stringify(b)),
  ]
}

export const writeBudget = new TokenBucket(WRITE_LIMITS, ...stored('inkpad:write-budget'))
export const readBudget = new TokenBucket(READ_LIMITS, ...stored('inkpad:read-budget'))
