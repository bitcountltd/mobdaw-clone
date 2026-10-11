import { describe, expect, it } from 'vitest'
import { Pedal, heardPosition, quantize, type Op } from '../src/audio/pedal'

const RATE = 1000 // 1 sample = 1 ms, so the 150 ms grace is 150 samples
const LATENCY = 40
const grid = { origin: 2000, period: 1000 }

describe('quantize', () => {
  it('takes the next boundary, with a grace window after one', () => {
    expect(quantize(2000, grid, 150)).toBe(2000)
    expect(quantize(2100, grid, 150)).toBe(2000) // just late: that boundary
    expect(quantize(2150, grid, 150)).toBe(2000) // (the window's edge)
    expect(quantize(2151, grid, 150)).toBe(3000)
    expect(quantize(2900, grid, 150)).toBe(3000)
    expect(quantize(5001, grid, 150)).toBe(5000)
    expect(quantize(5500, grid, 150)).toBe(6000)
  })
  it('snaps to the origin before it, and never reaches back further than a quarter period', () => {
    expect(quantize(10, grid, 150)).toBe(2000)
    expect(quantize(2200, { origin: 0, period: 400 }, 150)).toBe(2400) // grace capped at 100
    expect(quantize(2100, { origin: 0, period: 400 }, 150)).toBe(2000)
  })
})

describe('heardPosition', () => {
  it('maps a performance.now stamp through the output timestamp and the engine report', () => {
    // the engine stood at timeline 5000 when context frame 10000 was rendered; the speaker plays context time 9.95 s
    // (50 ms behind) at performance time 1000 ms, so a press at 1020 ms is at context time 9.97 s = frame 9970
    const heard = heardPosition({ pos: 5000, frame: 10000 }, { contextTime: 9.95, performanceTime: 1000 }, 1020, RATE)
    expect(heard).toBe(5000 + (9970 - 10000))
  })
  it('is exact at the timestamp itself and moves with time', () => {
    const r = { pos: 777, frame: 1234 }
    const ts = { contextTime: 1.234, performanceTime: 50 }
    expect(heardPosition(r, ts, 50, RATE)).toBe(777)
    expect(heardPosition(r, ts, 80, RATE)).toBe(807)
  })
})

/** A session with the take starting at timeline 0 (and a `latency` of 40 samples). */
const session = () => {
  const p = new Pedal(RATE, LATENCY)
  p.tookAt(0)
  return p
}
const kinds = (ops: Op[]) => ops.map((o) => o.op)

describe('first loop with no grid', () => {
  it('begins at the press, closes where it is pressed, and that defines the grid', () => {
    const p = session()
    expect(p.press('loop', 700, null)).toEqual([{ op: 'begin' }, { op: 'layer', id: 1, start: 700 }])
    const ops = p.press('loop', 2700, null)
    expect(ops).toEqual([{ op: 'add', loop: { id: 1, start: 2700, pass: 2000, offset: 700 + LATENCY, forever: true } }])
    // the grid is origin 700, period 2000: the next press snaps to it
    expect(p.grid(null)).toEqual({ origin: 700, period: 2000 })
    expect(p.press('loop', 4100, null)).toEqual([{ op: 'layer', id: 2, start: 4700 }])
  })
  it('ignores a closing press that is a bounce', () => {
    const p = session()
    p.press('loop', 700, null)
    expect(p.press('loop', 800, null)).toEqual([])
    expect(p.layer).toEqual({ id: 1, start: 700 })
  })
  it('measures the window from the real start of the take', () => {
    const p = new Pedal(RATE, LATENCY)
    p.press('loop', 700, null)
    p.tookAt(730) // the worklet began 30 samples after the press
    const [add] = p.press('loop', 2700, null)
    expect(add).toMatchObject({ op: 'add', loop: { offset: 700 - 730 + LATENCY } })
  })
  it('never reads before the take', () => {
    const p = session()
    p.tookAt(900)
    p.press('loop', 700, null) // the layer starts before the take (a late take start)
    const [add] = p.press('loop', 2700, null)
    expect(add).toMatchObject({ loop: { offset: 0 } })
  })
})

describe('with a click track grid', () => {
  it('starts on the next seam, with grace, and closes on a later one', () => {
    const p = session()
    expect(p.press('loop', 2900, grid)).toEqual([{ op: 'begin' }, { op: 'layer', id: 1, start: 3000 }])
    const ops = p.press('loop', 5080, grid) // 80 ms after the 5000 seam: still that one
    expect(ops).toEqual([{ op: 'add', loop: { id: 1, start: 5000, pass: 2000, offset: 3000 + LATENCY, forever: true } }])
  })
  it('a press just after the start boundary starts there (the past is in the continuous take)', () => {
    const p = session()
    expect(p.press('loop', 3100, grid)).toEqual([{ op: 'begin' }, { op: 'layer', id: 1, start: 3000 }])
  })
  it('closes no earlier than one pass', () => {
    const p = session()
    p.press('loop', 2900, grid) // layer at 3000
    const [add] = p.press('loop', 3050, grid) // closing in the grace window of its own start
    expect(add).toMatchObject({ loop: { start: 4000, pass: 1000 } })
  })
  it('does not learn a grid of its own: the click track stays in charge', () => {
    const p = session()
    p.press('loop', 2900, grid)
    p.press('loop', 3900, grid)
    expect(p.grid(null)).toBeNull()
  })
})

describe('layers', () => {
  it('are multiples of the period, each from a boundary to a boundary', () => {
    const p = session()
    p.press('loop', 100, null)
    p.press('loop', 1100, null) // grid: origin 100, period 1000; loop 1 sounds from 1100
    expect(p.press('loop', 3350, null)).toEqual([{ op: 'layer', id: 2, start: 4100 }]) // 3350 -> next boundary 4100
    const [add] = p.press('loop', 7090, null) // 10 ms before the 7100 boundary
    expect(add).toMatchObject({ op: 'add', loop: { id: 2, start: 7100, pass: 3000, offset: 4100 + LATENCY, forever: true } })
    expect(p.loops.map((l) => l.pass % 1000)).toEqual([0, 0])
    expect(p.looping()).toHaveLength(2)
  })
})

describe('stopping', () => {
  const setup = () => {
    const p = session()
    p.press('loop', 0, null)
    p.press('loop', 1000, null) // loop 1: 1000.., pass 1000
    p.press('loop', 1000, null)
    p.press('loop', 3000, null) // loop 2: 3000.., pass 2000
    return p
  }
  it('stop last ends the latest loop at the next boundary, then the one before', () => {
    const p = setup()
    expect(p.press('stopLast', 4300, null)).toEqual([{ op: 'stop', id: 2, at: 5000, length: 2000 }])
    expect(p.loops[1]).toMatchObject({ stopAt: 5000, forever: false })
    expect(p.press('stopLast', 4400, null)).toEqual([{ op: 'stop', id: 1, at: 5000, length: 4000 }])
    expect(p.press('stopLast', 4500, null)).toEqual([])
  })
  it('stop all stops every loop at the same boundary, and again with nothing looping ends the session', () => {
    const p = setup()
    expect(p.press('stopAll', 4990, null)).toEqual([
      { op: 'stop', id: 1, at: 5000, length: 4000 },
      { op: 'stop', id: 2, at: 5000, length: 2000 },
    ])
    expect(p.looping(5000)).toEqual([])
    expect(p.press('stopAll', 5200, null)).toEqual([{ op: 'end' }])
  })
  it('stop all with no loops at all ends the session', () => {
    const p = session()
    p.press('loop', 0, null) // only a layer, being recorded
    expect(p.press('stopAll', 100, null)).toEqual([{ op: 'end' }])
  })
  it('a stop before the loop has begun removes it', () => {
    const p = session()
    p.press('loop', 0, null)
    p.press('loop', 1000, null)
    p.press('loop', 1000, null)
    const ops = p.press('loop', 2500, null) // closes at 3000: 500 ms ahead of now
    expect(ops[0]).toMatchObject({ op: 'add', loop: { start: 3000 } })
    expect(p.press('stopLast', 2600, null)).toEqual([{ op: 'remove', id: 2 }]) // the boundary is its start
    expect(p.loops.map((l) => l.id)).toEqual([1])
  })
  it('does nothing before the session starts', () => {
    const p = session()
    expect(p.press('stopLast', 10, null)).toEqual([])
    expect(p.press('stopAll', 10, null)).toEqual([])
    expect(p.press('undo', 10, null)).toEqual([])
  })
  it('lists the stops still ahead, for rescheduling', () => {
    const p = setup()
    p.press('stopAll', 4990, null)
    expect(p.pendingStops(4000).map((o) => o.id)).toEqual([1, 2])
    expect(p.pendingStops(5000)).toEqual([])
  })
})

describe('undo', () => {
  it('cancels the layer being recorded first', () => {
    const p = session()
    p.press('loop', 0, null)
    p.press('loop', 1000, null)
    p.press('loop', 1000, null)
    expect(p.press('undo', 1500, null)).toEqual([{ op: 'cancel', id: 2 }])
    expect(p.loops).toHaveLength(1)
  })
  it('then removes the latest loop at once, and forgets the grid with the last one', () => {
    const p = session()
    p.press('loop', 0, null)
    p.press('loop', 1000, null)
    p.press('loop', 1000, null)
    p.press('loop', 3000, null)
    expect(p.press('undo', 3500, null)).toEqual([{ op: 'remove', id: 2 }])
    expect(p.grid(null)).not.toBeNull()
    expect(p.press('undo', 3600, null)).toEqual([{ op: 'remove', id: 1 }])
    expect(p.grid(null)).toBeNull()
    // the next first loop defines a new grid
    p.press('loop', 5000, null)
    p.press('loop', 5700, null)
    expect(p.grid(null)).toEqual({ origin: 5000, period: 700 })
  })
  it('removes a stopped loop too (it is still the latest layer)', () => {
    const p = session()
    p.press('loop', 0, null)
    p.press('loop', 1000, null)
    p.press('stopAll', 1500, null)
    expect(p.press('undo', 1600, null)).toEqual([{ op: 'remove', id: 1 }])
  })
})

describe('session end', () => {
  it('writes a loop that is still going as a forever clip of whole passes covering what was heard', () => {
    const p = session()
    p.press('loop', 100, null)
    p.press('loop', 1100, null)
    // ended at 4600: 3500 into a 1000 pass -> 4 passes
    expect(p.clips(4600)).toEqual([{ id: 1, start: 1100, length: 4000, sourceOffset: 100 + LATENCY, loopLength: 1000, forever: true }])
    // at least two passes, so it is a loop at all
    expect(p.clips(1200)[0]).toMatchObject({ length: 2000, forever: true })
  })
  it('writes a stopped loop with its extent and no forever', () => {
    const p = session()
    p.press('loop', 100, null)
    p.press('loop', 1100, null)
    p.press('stopLast', 3600, null) // next boundary 4100
    expect(p.clips(9000)).toEqual([{ id: 1, start: 1100, length: 3000, sourceOffset: 100 + LATENCY, loopLength: 1000 }])
  })
  it('a stopped loop of a single pass is a plain clip', () => {
    const p = session()
    p.press('loop', 100, null)
    p.press('loop', 1100, null)
    p.press('stopLast', 1200, null) // 1100 is within the grace window: the boundary is the loop's own start, so it never sounds
    expect(p.clips(5000)).toEqual([])
    const q = session()
    q.press('loop', 100, null)
    q.press('loop', 1100, null)
    q.press('stopLast', 1500, null) // next boundary 2100: one pass
    expect(q.clips(5000)).toEqual([{ id: 1, start: 1100, length: 1000, sourceOffset: 100 + LATENCY }])
  })
  it('leaves out loops that were undone and the layer being recorded', () => {
    const p = session()
    p.press('loop', 100, null)
    p.press('loop', 1100, null)
    p.press('loop', 1100, null)
    p.press('loop', 2100, null)
    p.press('undo', 2200, null)
    p.press('loop', 3100, null) // a layer in progress
    expect(p.clips(3500).map((c) => c.id)).toEqual([1])
  })
})
