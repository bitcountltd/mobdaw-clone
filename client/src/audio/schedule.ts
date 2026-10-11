// Sample-accurate scheduled engine calls (docs/engine-api.md, "Host messages"). Pure logic, so tests drive the real
// engine through it exactly as the worklet does.

/** One engine call waiting for timeline sample `at`. */
export type Scheduled = { at: number; fn: string; args: number[] }

/** What the queue needs to know about the engine. */
export type Transport = { position(): number; playing(): boolean }

export class CallQueue {
  private q: Scheduled[] = []

  get size() {
    return this.q.length
  }

  /** Queue a call, ordered by `at`; calls with the same `at` run in the order they were added. */
  add(at: number, fn: string, args: number[]) {
    let i = this.q.length
    while (i > 0 && this.q[i - 1].at > at) i--
    this.q.splice(i, 0, { at, fn, args })
  }

  clear() {
    this.q.length = 0
  }

  /**
   * Before rendering up to `n` frames from the engine's position `p`: run every call that is due (`at <= p`, so a call
   * whose sample has passed, or a seek jumped over, runs at once), and return how many of the `n` frames can be rendered
   * before the next call falls due. That is `n` unless the transport is playing and a call lands inside the block; the
   * block is then cut so the call runs when the position is exactly `at`. The result is at least 1.
   */
  step(n: number, t: Transport, apply: (c: Scheduled) => void): number {
    for (;;) {
      const head = this.q[0]
      if (!head) return n
      const p = t.position()
      if (head.at <= p) {
        this.q.shift()
        apply(head) // may move the transport (play, seek): look again
      } else return t.playing() && head.at < p + n ? head.at - p : n
    }
  }
}
