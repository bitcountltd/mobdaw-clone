// Drag-and-drop between studio views (browser → lanes, track headers, the dock's rack, the mixer).
// The payload travels as JSON under DND_MIME. During dragover only the type list is readable, so use `hasPayload`.
import { DEVICES, MASTER_TRACK, addAudioClip, addDevice, getSamples, getTracks, type TrackKind } from '@mobdaw/shared'
import { addDrumKit, addEffectPreset, addInstrument, drumKit, effectPreset, instrumentPreset } from '../content/presets'
import type { Studio } from './studio'

export const DND_MIME = 'application/x-mobdaw'
export type DropPayload =
  | { kind: 'instrument'; id: string } // an INSTRUMENT_PRESETS id
  | { kind: 'kit'; id: string } // a DRUM_KITS id
  | { kind: 'effect'; type: number } // a single device type from DEVICES
  | { kind: 'chain'; id: string } // an EFFECT_PRESETS id
  | { kind: 'sample'; hash: string } // project audio (samples map)

/** Where a payload lands: a track (or the master), optionally at a timeline sample. No track: a new one is made when it makes sense. */
export type DropTarget = { trackId?: string | null; at?: number }

export function setDragPayload(e: DragEvent, p: DropPayload) {
  e.dataTransfer?.setData(DND_MIME, JSON.stringify(p))
  e.dataTransfer?.setData('text/plain', p.kind)
  if (e.dataTransfer) e.dataTransfer.effectAllowed = 'copy'
}
export const hasPayload = (e: DragEvent) => !!e.dataTransfer?.types.includes(DND_MIME)
export function readDragPayload(e: DragEvent): DropPayload | null {
  try {
    const raw = e.dataTransfer?.getData(DND_MIME)
    return raw ? (JSON.parse(raw) as DropPayload) : null
  } catch {
    return null
  }
}

/** The track kind a payload needs (null: any). */
export function payloadTrackKind(p: DropPayload): TrackKind | null {
  if (p.kind === 'instrument' || p.kind === 'kit') return 'midi'
  if (p.kind === 'sample') return 'audio'
  return null
}

/** Whether the payload can go on that track (or the master). */
export function canDrop(st: Studio, p: DropPayload, trackId: string | null | undefined): boolean {
  if (st.readOnly) return false
  if (!trackId) return true
  if (trackId === MASTER_TRACK) return p.kind === 'effect' || p.kind === 'chain'
  const t = getTracks(st.doc).find((x) => x.id === trackId)
  if (!t) return false
  const need = payloadTrackKind(p)
  return !need || need === t.kind
}

/**
 * Apply a payload. A target track of the wrong kind (or none) gets a new track of the right kind, named after what was
 * dropped. Returns the track id it landed on, or null. One undo step.
 */
export function applyDrop(st: Studio, p: DropPayload, target: DropTarget = {}): string | null {
  if (st.readOnly) return null
  const doc = st.doc
  let trackId = target.trackId ?? null
  if (trackId && !canDrop(st, p, trackId)) trackId = null
  let landed: string | null = null
  doc.transact(() => {
    const need = payloadTrackKind(p)
    const make = (name: string) => (trackId ??= st.addTrack(need ?? 'audio', name))
    switch (p.kind) {
      case 'instrument': {
        const pre = instrumentPreset(p.id)
        if (!pre) return
        addInstrument(doc, make(pre.name.toLowerCase()), pre)
        break
      }
      case 'kit': {
        const kit = drumKit(p.id)
        if (!kit) return
        addDrumKit(doc, make('drums'), kit)
        break
      }
      case 'effect': {
        if (!DEVICES[p.type] || DEVICES[p.type].instrument) return
        addDevice(doc, trackId ?? make(DEVICES[p.type].name), p.type)
        break
      }
      case 'chain': {
        const pre = effectPreset(p.id)
        if (!pre) return
        addEffectPreset(doc, trackId ?? make(pre.name.toLowerCase()), pre)
        break
      }
      case 'sample': {
        const meta = getSamples(doc)[p.hash]
        if (!meta) return
        const id = make(meta.name.replace(/\.[^.]+$/, ''))
        const length = Math.max(1, Math.round(meta.duration * st.rate))
        addAudioClip(doc, { trackId: id, sourceHash: p.hash, start: st.snap(target.at ?? 0), length })
        break
      }
    }
    landed = trackId
  })
  if (landed) st.focus(landed)
  return landed
}
