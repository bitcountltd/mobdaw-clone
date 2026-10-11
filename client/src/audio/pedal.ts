// Loop pedal logic (docs/engine.md §9.2 and "Loop pedal principles"). Pure: times in, scheduled operations out, so the
// whole state machine is tested with fake times. `ui/pedalSession.ts` carries the operations out against the engine and the doc.

/** What a foot switch can do (the four actions, in the order they are numbered, learned and bound to 1..4). */
export type Action = 'loop' | 'stopLast' | 'stopAll' | 'undo'
export const ACTIONS: Action[] = ['loop', 'stopLast', 'stopAll', 'undo']

/** Boundaries at `origin + k * period` (samples), k >= 0. */
export type Grid = { origin: number; period: number }

/** A press just after a boundary still counts as that boundary (the stateless clips make applying it a few ms late harmless). */
export const GRACE_S = 0.15
/** A first loop with no grid to snap to is ignored if it is shorter than this: a bounced switch, not a loop. */
export const MIN_LOOP_S = 0.25

/**
 * The boundary a press at timeline sample `t` belongs to: the one just before it when the press is at most `grace` samples
 * late, else the next one. Before the grid's origin that is the origin. Always a boundary of the grid, so an integer.
 */
export function quantize(t: number, g: Grid, grace: number): number {
  if (t <= g.origin) return g.origin
  const k = Math.floor((t - g.origin) / g.period)
  const prev = g.origin + k * g.period
  return t - prev <= Math.min(grace, g.period / 4) ? prev : prev + g.period
}

/** A position report from the engine: at context frame `frame` the engine stood at timeline sample `pos`. */
export type PosReport = { pos: number; frame: number }
/** `AudioContext.getOutputTimestamp()`: the context time of the sample at the speaker at `performanceTime` (performance.now clock, ms). */
export type OutputTs = { contextTime: number; performanceTime: number }

/**
 * The timeline sample the performer *hears* at `perfTime` (performance.now clock, ms: a Web MIDI event's `timeStamp`). The
 * output timestamp already accounts for the output latency, so the heard context frame is that of the speaker at `perfTime`,
 * and the engine's report ties context frames to the timeline (the transport runs at one sample per frame, unless it jumped
 * since the report, which is rare and corrected by the next one).
 */
export function heardPosition(r: PosReport, ts: OutputTs, perfTime: number, rate: number): number {
  const heardFrame = (ts.contextTime + (perfTime - ts.performanceTime) / 1000) * rate
  return Math.round(r.pos + (heardFrame - r.frame))
}

/** A loop made from the session take: it starts sounding at `start` and repeats the take's window `[offset, offset + pass)`. */
export type Loop = {
  id: number
  start: number
  /** The pass in samples: a multiple of the grid period (the first loop defines it). */
  pass: number
  /** First source frame of the pass: the window start on the timeline, in take frames, latency-compensated and never negative. */
  offset: number
  forever: boolean
  /** Set once a stop is scheduled: the sample where it ends. */
  stopAt?: number
}

/** What the caller must do, in order. */
export type Op =
  | { op: 'begin' } // the first loop press: start the transport and the session take
  | { op: 'layer'; id: number; start: number } // a layer began recording at `start` (make its track `id`)
  | { op: 'cancel'; id: number } // the layer being recorded was cancelled
  | { op: 'add'; loop: Loop } // the layer closed: sound the loop now (its start is the closing boundary)
  | { op: 'stop'; id: number; at: number; length: number } // set the loop's extent to `length` at sample `at`: forever off
  | { op: 'remove'; id: number } // take the loop away now (undo, or a stop before it began)
  | { op: 'end' } // the session is over

/** A loop as an ordinary doc clip (positions in samples; same track / source / start / sourceOffset as the live clip). */
export type ClipSpec = {
  id: number; start: number; length: number; sourceOffset: number
  loopLength?: number; forever?: boolean
}

export class Pedal {
  /** Loops in creation order (the ones taken away are gone from here). */
  loops: Loop[] = []
  /** The layer being recorded: it began at `start` and closes at the next boundary. */
  layer: { id: number; start: number } | null = null
  private started = false
  private learned: Grid | null = null
  private n = 0
  /** Timeline sample of the take's first frame; the worklet reports the real one (`tookAt`). */
  private recstart = 0
  private known = false
  private grace: number

  /** `latency`: how late the input reaches the engine, in samples (the value the saved take uses too). */
  constructor(private rate: number, readonly latency: number) {
    this.grace = Math.round(GRACE_S * rate)
  }

  /** The take began: its first frame was captured at timeline sample `pos`. */
  tookAt(pos: number) {
    this.recstart = pos
    this.known = true
  }

  get began() { return this.started }
  /** Timeline sample of the session take's first frame. */
  get tookStart() { return this.recstart }
  /** Loops that are still going: not stopped, or stopped later than `now`. */
  looping(now = -Infinity) { return this.loops.filter((l) => l.stopAt == null || l.stopAt > now) }

  /** The grid in force: the click track's if there is one (`ext`), else the one the first loop defined. */
  grid(ext: Grid | null): Grid | null {
    return ext ?? this.learned
  }

  /** A press of `action` that the performer heard at timeline sample `heard`. `ext`: the click track's grid, if any. */
  press(action: Action, heard: number, ext: Grid | null): Op[] {
    const g = this.grid(ext)
    if (action === 'loop') return this.pressLoop(heard, g)
    if (!this.started) return []
    if (action === 'undo') return this.undo()
    if (action === 'stopLast') {
      const l = this.loops.findLast((x) => x.stopAt == null)
      return l && g ? this.stop(l, quantize(heard, g, this.grace)) : []
    }
    const live = this.loops.filter((x) => x.stopAt == null)
    if (!live.length) return [{ op: 'end' }]
    if (!g) return []
    const at = quantize(heard, g, this.grace)
    return live.flatMap((l) => this.stop(l, at))
  }

  private pressLoop(heard: number, g: Grid | null): Op[] {
    if (!this.layer) {
      const ops: Op[] = this.started ? [] : [{ op: 'begin' }]
      if (!this.started && !this.known) this.recstart = heard // until the worklet says where the take really began
      this.started = true
      const start = g ? quantize(heard, g, this.grace) : heard
      this.layer = { id: ++this.n, start }
      return [...ops, { op: 'layer', id: this.layer.id, start }]
    }
    const { id, start } = this.layer
    let end: number
    if (g) {
      end = quantize(heard, g, this.grace)
      if (end <= start) end = quantize(start + 1, g, 0) // at least one pass
    } else {
      end = heard // the first loop: its length is the pass, whatever it is
      if (end - start < MIN_LOOP_S * this.rate) return []
    }
    const loop: Loop = { id, start: end, pass: end - start, offset: Math.max(0, start - this.recstart + this.latency), forever: true }
    if (!g) this.learned = { origin: start, period: loop.pass }
    this.layer = null
    this.loops.push(loop)
    return [{ op: 'add', loop }]
  }

  private stop(l: Loop, at: number): Op[] {
    const length = at - l.start
    if (length <= 0) return this.take(l)
    l.stopAt = at
    l.forever = false
    return [{ op: 'stop', id: l.id, at, length }]
  }

  private take(l: Loop): Op[] {
    this.loops.splice(this.loops.indexOf(l), 1)
    if (!this.loops.length) this.learned = null // nothing left to keep the grid for: the next first loop defines it again
    return [{ op: 'remove', id: l.id }]
  }

  private undo(): Op[] {
    if (this.layer) {
      const { id } = this.layer
      this.layer = null
      return [{ op: 'cancel', id }]
    }
    const l = this.loops.at(-1)
    return l ? this.take(l) : []
  }

  /** The stops still ahead of `now` (to schedule again after the engine's queue was cleared). */
  pendingStops(now: number): Extract<Op, { op: 'stop' }>[] {
    return this.loops.flatMap((l) => (l.stopAt != null && l.stopAt > now ? [{ op: 'stop' as const, id: l.id, at: l.stopAt, length: l.stopAt - l.start }] : []))
  }

  /**
   * The surviving loops as doc clips, for a session that ends at timeline sample `endPos`. A loop still going keeps
   * `forever`, with a finite extent of whole passes that covers what was heard (at least two, so it is a loop at all).
   */
  clips(endPos: number): ClipSpec[] {
    return this.loops.map((l) => {
      if (l.stopAt != null) {
        const length = l.stopAt - l.start
        return { id: l.id, start: l.start, length, sourceOffset: l.offset, ...(length > l.pass ? { loopLength: l.pass } : {}) }
      }
      const passes = Math.max(2, Math.ceil((endPos - l.start) / l.pass))
      return { id: l.id, start: l.start, length: passes * l.pass, sourceOffset: l.offset, loopLength: l.pass, forever: true }
    })
  }
}
