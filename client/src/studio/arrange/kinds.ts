// What kind of track a track is, as people say it (D5): audio track, instrument track, drum track, soundscape, click
// track. A MIDI track is a drum track when every instrument on it is a drum (a one-note range) or every clip on it is a
// drum grid (a synth whose clips are all drum grids counts too). Pure: the headers, the lanes, the mixer, the dock and the drops share it.
import { DEVICES, getClips, getDevices, isDrum, type Clip, type Device, type Track } from '@mobdaw/shared'
import type * as Y from 'yjs'
import type { IconName } from '../../theme/icons'

export type KindName = 'audio' | 'instrument' | 'drums' | 'soundscape' | 'click'
export type Kind = { kind: KindName; icon: IconName; label: string }

const KINDS: Record<KindName, Kind> = {
  audio: { kind: 'audio', icon: 'wave', label: 'audio track' },
  instrument: { kind: 'instrument', icon: 'piano', label: 'instrument track' },
  drums: { kind: 'drums', icon: 'drum', label: 'drum track' },
  soundscape: { kind: 'soundscape', icon: 'loop', label: 'soundscape' },
  click: { kind: 'click', icon: 'metronome', label: 'click track' },
}

/** Whether MIDI track `trackId` is drums, from its devices and clips. */
export function isDrumTrack(trackId: string, devices: Pick<Device, 'trackId' | 'type' | 'keyLo' | 'keyHi'>[], clips: Pick<Clip, 'trackId' | 'kind'>[]): boolean {
  const inst = devices.filter((d) => d.trackId === trackId && DEVICES[d.type]?.instrument)
  if (inst.length && inst.every(isDrum)) return true
  const cs = clips.filter((c) => c.trackId === trackId)
  return cs.length > 0 && cs.every((c) => c.kind === 'midi' && (c as Clip & { kind: 'midi' }).view === 'drums')
}

/** Whether the track has an instrument that plays the whole keyboard (a synth, not a drum). */
export const hasFullRangeInstrument = (trackId: string, devices: Pick<Device, 'trackId' | 'type' | 'keyLo' | 'keyHi'>[]) =>
  devices.some((d) => d.trackId === trackId && DEVICES[d.type]?.instrument && !isDrum(d))

/** The kind of `t` (pass `devices` / `clips` to skip reading them from the doc again). */
export function kindOf(doc: Y.Doc, t: Pick<Track, 'id' | 'kind' | 'role'>, devices?: Device[], clips?: Clip[]): Kind {
  if (t.kind === 'audio') return KINDS.audio
  if (t.kind === 'soundscape') return KINDS.soundscape
  if (t.role === 'click') return KINDS.click
  return isDrumTrack(t.id, devices ?? getDevices(doc), clips ?? getClips(doc)) ? KINDS.drums : KINDS.instrument
}

/** The next name for a new track called `base` and numbered per kind: "drums 3" after "drums 1" and "drums 2". */
export function numberedName(names: string[], base: string): string {
  const esc = base.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const re = new RegExp(`^${esc}(?: (\\d+))?$`, 'i')
  let n = 0
  for (const name of names) {
    const m = re.exec(name.trim())
    if (m) n = Math.max(n, m[1] ? Number(m[1]) : 1)
  }
  return `${base} ${n + 1}`
}
