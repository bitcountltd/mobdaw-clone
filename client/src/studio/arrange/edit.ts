// Arrangement editing shortcuts (registered with keys.ts): clipboard, duplicate, select all / none, nudge, and mute / solo
// of the focused track. The doc work is in ../clipboard.ts; each edit is its own undo step.
//   ⌘C copy   ⌘X cut   ⌘V paste (at the playhead, on the focused track)   ⌘D duplicate   ⌘A select all   esc select none
//   ← → nudge by a grid step (⇧: a bar)   M mute the focused track   ⇧S solo it
import { MASTER_TRACK, clipsMap, getTracks, gridSamples, samplesPerBar, tracksMap, updateTrack } from '@mobdaw/shared'
import {
  clipboard, copyClips, cutClips, duplicateClips, nudgeClips, pasteClips, timelineClips,
} from '../clipboard'
import { registerKeys } from '../keys'
import type { Studio } from '../studio'

export function registerArrangeKeys(st: Studio) {
  const { doc } = st
  /** The selected clips that can be edited (not on a track someone else is recording on). */
  const editable = () => st.ui.selection.filter((id) => {
    const t = clipsMap(doc).get(id)?.get('trackId') as string | undefined
    return t != null && !st.locks.has(t)
  })
  /** One undo step per edit, even when edits follow each other quickly. */
  const step = <T>(f: () => T): T => {
    st.undo.stopCapturing()
    const r = f()
    st.undo.stopCapturing()
    return r
  }
  const focused = () => {
    const id = st.ui.focusTrack
    return id && id !== MASTER_TRACK && tracksMap(doc).has(id) ? id : null
  }
  const hasSel = () => st.ui.selection.length > 0
  const say = (n: number, what: string) => st.status(`${what} ${n} clip${n === 1 ? '' : 's'}`)

  function paste() {
    const data = clipboard.get()
    if (!data) return st.status('nothing to paste: copy some clips first')
    const ids = step(() => pasteClips(doc, data, { at: Math.round(st.position()), trackId: focused() }))
    if (!ids.length) return st.status('nothing could be pasted here (the audio is not in this project, or the tracks are gone)')
    st.select(ids)
    say(ids.length, 'pasted')
  }
  function nudge(dir: number, bar: boolean) {
    const t = st.tempo()
    const g = gridSamples(st.ui.grid, t, st.rate) || gridSamples(0.25, t, st.rate) // grid off: a 1/16
    step(() => nudgeClips(doc, editable(), dir * (bar ? samplesPerBar(t, st.rate) : g)))
  }
  function toggleTrack(field: 'muted' | 'soloed') {
    const id = focused()
    if (!id) return st.status('click a track header first')
    updateTrack(doc, id, { [field]: !tracksMap(doc).get(id)?.get(field) })
  }

  return registerKeys(st, [
    { key: 'c', mods: { mod: true }, when: hasSel, run: () => {
      const d = copyClips(doc, st.ui.selection)
      clipboard.set(d)
      if (d) say(d.items.length, 'copied')
    }, label: 'copy clips', group: 'Editing' },
    { key: 'x', mods: { mod: true }, when: hasSel, run: () => {
      const d = step(() => cutClips(doc, editable()))
      clipboard.set(d)
      st.select([])
      if (d) say(d.items.length, 'cut')
    }, label: 'cut clips', group: 'Editing' },
    { key: 'v', mods: { mod: true }, when: () => !!clipboard.get(), run: paste, label: 'paste clips at the playhead (on the selected track)', group: 'Editing' },
    { key: 'd', mods: { mod: true }, when: hasSel, run: () => {
      const ids = step(() => duplicateClips(doc, editable(), st.rate))
      if (ids.length) st.select(ids)
    }, label: 'duplicate clips', group: 'Editing' },
    { key: 'a', mods: { mod: true }, run: () => st.select(timelineClips(doc)), label: 'select all clips', group: 'Editing', readOnly: true },
    { key: 'escape', when: () => hasSel() && !(st.ui.editing || st.ui.looperArm || st.ui.pad || st.ui.note),
      run: () => st.select([]), label: 'select nothing', group: 'Editing', readOnly: true },
    { key: ['arrowleft', 'arrowright'], when: () => hasSel() && !st.ui.note, repeat: true,
      run: (e) => nudge(e.key === 'ArrowLeft' ? -1 : 1, false), label: 'nudge clips by a grid step', group: 'Editing', display: '← →' },
    { key: ['arrowleft', 'arrowright'], mods: { shift: true }, when: () => hasSel() && !st.ui.note, repeat: true,
      run: (e) => nudge(e.key === 'ArrowLeft' ? -1 : 1, true), label: 'nudge clips by a bar', group: 'Editing', display: '← →' },
    { key: 'm', run: () => toggleTrack('muted'), label: 'mute the selected track', group: 'Editing' },
    { key: 's', mods: { shift: true }, run: () => toggleTrack('soloed'), label: 'solo the selected track', group: 'Editing' },
  ])
}

/** Tracks in order, for code that needs the index of one (the lanes' row moves). */
export const trackIndex = (st: Studio) => new Map(getTracks(st.doc).map((t, i) => [t.id, i]))
