import { describe, expect, it } from 'vitest'
import { CallQueue } from '../src/audio/schedule'

/** A fake transport that advances by whatever block it is told to render. */
const run = (q: CallQueue, pos: number, playing: boolean, n: number, log: string[]) => {
  const t = { p: pos }
  const k = q.step(n, { position: () => t.p, playing: () => playing }, (c) => log.push(`${c.fn}@${t.p}`))
  return k
}

describe('CallQueue', () => {
  it('cuts the block at the call, runs it when the position is there, and keeps order', () => {
    const q = new CallQueue()
    const log: string[] = []
    q.add(300, 'b', [])
    q.add(260, 'a', [])
    q.add(300, 'c', [])
    expect(run(q, 256, true, 128, log)).toBe(4) // a falls due at 260
    expect(run(q, 260, true, 124, log)).toBe(40) // then b at 300
    expect(log).toEqual(['a@260'])
    expect(run(q, 300, true, 84, log)).toBe(84)
    expect(log).toEqual(['a@260', 'b@300', 'c@300'])
    expect(q.size).toBe(0)
  })

  it('applies a past call at once, and waits while stopped', () => {
    const q = new CallQueue()
    const log: string[] = []
    q.add(10, 'past', [])
    q.add(500, 'later', [])
    expect(run(q, 100, false, 128, log)).toBe(128)
    expect(log).toEqual(['past@100'])
    expect(q.size).toBe(1) // stopped: no cut, and it keeps waiting
    q.clear()
    expect(q.size).toBe(0)
  })
})
