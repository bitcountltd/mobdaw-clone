// Keyboard shortcuts (the full set and the ? overlay come in Phase B):
//   space play / pause      shift+space record       ctrl/cmd+z undo (shift: redo)
//   s split the selection at the playhead           delete / backspace: the selected note, region or clips
//   escape close the editor / let go of an armed looper or a region      1-4 the loop pedal's actions (pedal mode)
//   b the browser      d the dock
import { clipsMap, deleteClip, deleteNote, deletePad, splitClip, tracksMap } from '@mobdaw/shared'
import { ACTIONS } from '../audio/pedal'
import type { Studio } from './studio'

export function mountKeys(st: Studio) {
  const { doc, undo } = st
  /** The clips not on a track someone is recording on. */
  const unlocked = (ids: string[]) => ids.filter((id) => !st.locks.has(String(clipsMap(doc).get(id)?.get('trackId'))))
  /** Source clips (on a soundscape's source lane) have their own time axis: the playhead means nothing there. */
  const onSource = (id: string) => tracksMap(doc).get(String(clipsMap(doc).get(id)?.get('trackId')))?.get('kind') === 'soundscape'

  const key = (e: KeyboardEvent) => {
    const target = e.target as HTMLElement
    const tag = target.tagName
    if (tag === 'SELECT' || tag === 'TEXTAREA' || target.isContentEditable || (tag === 'INPUT' && (target as HTMLInputElement).type !== 'range')) return
    const mod = e.metaKey || e.ctrlKey
    const k = e.key.toLowerCase()
    const { ui } = st
    if (e.code === 'Space') { e.preventDefault(); e.shiftKey ? void st.toggleRecord() : st.toggle() }
    else if (e.key === 'Escape' && (ui.editing || ui.looperArm || ui.pad || ui.note)) st.setUi({ editing: null, note: null, looperArm: null, pad: null })
    else if (st.pedal.on && !mod && !e.repeat && /^[1-4]$/.test(e.key)) { e.preventDefault(); st.pedal.press(ACTIONS[Number(e.key) - 1], e.timeStamp) } // the pedal's four actions, without a pedal
    else if (!mod && !e.altKey && k === 'b') st.setUi({ browserOpen: !ui.browserOpen })
    else if (!mod && !e.altKey && k === 'd') st.setUi({ dock: { ...ui.dock, open: !ui.dock.open } })
    else if (st.readOnly) return
    else if (mod && k === 'z') { e.preventDefault(); e.shiftKey ? undo.redo() : undo.undo() }
    else if (!mod && k === 's') {
      const at = Math.round(st.position())
      doc.transact(() => unlocked(ui.selection).filter((id) => !onSource(id)).forEach((id) => splitClip(doc, id, at)))
    } else if (e.key === 'Delete' || e.key === 'Backspace') {
      e.preventDefault()
      if (ui.note) {
        deleteNote(doc, ui.note)
        st.setUi({ note: null })
      } else if (ui.pad) {
        deletePad(doc, ui.pad)
        st.setUi({ pad: null })
      } else {
        doc.transact(() => unlocked(ui.selection).forEach((id) => deleteClip(doc, id)))
        st.select([])
      }
    }
  }
  addEventListener('keydown', key)
  return { destroy: () => removeEventListener('keydown', key) }
}
