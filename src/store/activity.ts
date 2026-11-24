/**
 * Whether the user is writing right now. Sync waits for a short pause before
 * doing its heavier work (reading and merging pages, preparing uploads), so
 * the device has its full attention for the pen while a line is being drawn.
 */
let down = false
let last = 0

/** Called by the canvas on every pen/eraser event; `isDown` false when the pen lifts. */
export function noteInk(isDown: boolean) {
  down = isDown
  last = performance.now()
}

/**
 * Resolves once nothing has been written for `quietMs`, or after `maxMs` at
 * the latest (so syncing still happens during very long writing sessions).
 */
export function whenInkIdle(quietMs = 700, maxMs = 15_000): Promise<void> {
  const until = performance.now() + maxMs
  return new Promise((resolve) => {
    const check = () => {
      const now = performance.now()
      if (now >= until || (!down && now - last >= quietMs)) return resolve()
      setTimeout(check, down ? 150 : Math.max(50, quietMs - (now - last)))
    }
    check()
  })
}
