// The top bar: logo, project name (settings), transport and time, click track, loop pedal, cpu, presence, zoom, export
// and the chat toggle. It reads the Studio and redraws on its events.
import { addClickTrack, clipsMap, getLoopers, getPoints, getTracks, metaMap, updateTrack, type Role } from '@mobdaw/shared'
import { renderProject } from '../audio/render'
import { h } from '../dom'
import { homeLink } from '../router'
import type { chatPanel } from '../ui/chat'
import { exportDialog } from '../ui/exportDialog'
import { projectMenu } from '../ui/projectMenu'
import { transportControls } from '../ui/transport'
import type { Studio } from './studio'
import './topbar.css'

export type Cloud = { projectId: string; me: string; role: Role; owner: boolean; locked: boolean; public: boolean; admin: boolean; demo: boolean }
export type TopbarOpts = {
  projectName: string
  renameProject?: (name: string) => Promise<unknown> | void
  cloud?: Cloud
  /** The chat panel the toggle shows and hides (absent for projects on this device). */
  chat?: ReturnType<typeof chatPanel>
}

const initials = (n: string) => n.split(/[\s@.]+/).filter(Boolean).slice(0, 2).map((w) => w[0]).join('').toUpperCase()
const glass = (sign: string) => `<svg viewBox="0 0 20 20" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><circle cx="8.5" cy="8.5" r="5.5"/><path d="M12.6 12.6 18 18M6 8.5h5${sign}"/></svg>`
const ZOOM_MIN = 10, ZOOM_MAX = 800

export function mountTopbar(st: Studio, opts: TopbarOpts) {
  const { s, doc, readOnly } = st
  let projectName = opts.projectName
  const { cloud, chat } = opts

  const transport = transportControls({
    title: 'play / pause (space)', onToggle: () => st.toggle(), onRewind: () => st.rewind(),
    record: readOnly ? undefined : { onToggle: () => void st.toggleRecord(), onMenu: (e) => st.rec.offsetMenu(e) },
  })

  /** Nothing is placed on a timeline yet (positions are in samples, so only then can the rate change). */
  const isBlank = () => !getTracks(doc).length && !getPoints(doc).length && !getLoopers(doc).length
  /** The project's name: a button that opens the project settings (rename, sharing, audio input, pedal). */
  const title = h('button', { className: 'project-name', title: 'project settings', onclick: () => {
    projectMenu(title, {
      name: projectName,
      rename: opts.renameProject,
      onRenamed: (n) => (title.textContent = projectName = n),
      cloud: cloud && { ...cloud, onPublic: (v) => (cloud.public = v), onDemo: (v) => (cloud.demo = v) },
      sampleRate: {
        value: st.rate,
        locked: readOnly ? 'readonly' : isBlank() ? null : 'tracks',
        set: (r) => isBlank() && metaMap(doc).set('sampleRate', r),
      },
      onInputChanged: () => void st.rec.reopenInput(),
      onPedalChanged: readOnly ? undefined : () => st.pedal.settingsChanged(),
    })
  } }, projectName)

  // The metronome is an ordinary MIDI track (role 'click'): the button makes it, and then mutes / unmutes it.
  const clickBtn = h('button', { className: 'metro', disabled: readOnly, title: 'metronome: add a click track, then mute / unmute it', onclick: () => {
    const t = getTracks(doc).find((x) => x.role === 'click')
    // switching it off closes its clip in the editor
    if (t && !t.muted && st.ui.editing && clipsMap(doc).get(st.ui.editing)?.get('trackId') === t.id) st.openClip(null)
    if (t) updateTrack(doc, t.id, { muted: !t.muted })
    else addClickTrack(doc)
  } })
  const pedalBtn = h('button', { className: 'pedal-btn', onclick: () => void st.pedal.set(!st.pedal.on) }, 'pedal')
  transport.el.append(clickBtn, pedalBtn) // sit right of the time readout

  const pedalText = h('span', { className: 'pedal-st', title: 'loop pedal: the number of loops going; red while a layer is recording' })
  const cpu = h('span', { className: 'cpu', title: 'audio engine load: share of the real-time budget used by DSP (peak call in the last half second)' })
  const presence = h('span', { className: 'presence' })
  const zoom = (f: number) => st.setUi({ pps: Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, st.ui.pps * f)) })
  const zoomOut = h('button', { className: 'bar-btn zoom', title: 'zoom out (ctrl + scroll)', onclick: () => zoom(1 / 1.5) })
  zoomOut.innerHTML = glass('')
  const zoomIn = h('button', { className: 'bar-btn zoom', title: 'zoom in (ctrl + scroll)', onclick: () => zoom(1.5) })
  zoomIn.innerHTML = glass('M8.5 6v5')
  const exportBtn = h('button', { className: 'bar-btn', title: 'render the whole project to a file', onclick: () => {
    if (!st.pb) return // (the project has not synced yet)
    exportDialog({ name: projectName, render: (o) => renderProject(doc, s.projectId, st.rate, s.userId, o) })
  } }, 'export')
  const chatBtn = chat && h('button', { className: 'chat-btn', title: 'chat', onclick: () => {
    chat.setOpen(!chat.open)
    chatBtn!.classList.toggle('on', chat.open)
    window.dispatchEvent(new Event('resize')) // the arrangement's width changed
  } }, 'chat')

  const el = h('header', { className: 'studio-top' },
    h('div', { className: 'bar-l' }, h('a', { ...homeLink, className: 'logo', title: 'all projects' }, 'mobdaw'), title,
      readOnly ? h('span', { className: 'dim' }, 'view only') : null,
      s.local ? h('span', { className: 'dim', title: 'saved in this browser, on this device' }, 'local') : null),
    transport.el,
    h('div', { className: 'bar-r' }, pedalText, cpu, presence, h('div', { className: 'bar-btns' }, zoomOut, zoomIn, exportBtn, chatBtn)))

  /** The pedal needs Web MIDI (not in Safari) and a chosen input; otherwise the button says why it is off. */
  function syncTransport() {
    const why = st.pedal.why()
    pedalBtn.disabled = !!why && !st.pedal.on
    pedalBtn.title = why || 'loop pedal: foot switches record, loop and overdub on the beat (keys 1-4 do the same). Learn the switches in the project settings'
    pedalBtn.classList.toggle('on', st.pedal.on)
    transport.setPlaying(st.playing)
    transport.setRecord(!!st.ui.armedTrack, !!st.rec.take)
    drawPedalText()
  }
  /** The text beside the CPU meter says what the pedal is doing. */
  function drawPedalText() {
    const v = st.pedal.view()
    const now = st.position()
    const n = (v?.loops ?? []).filter((l) => l.stopAt == null || l.stopAt > now).length
    const text = !st.pedal.on ? '' : v?.layer ? 'pedal · rec' : v ? `pedal · ${n ? `${n} loop${n > 1 ? 's' : ''}` : 'ready'}` : 'pedal · ready'
    if (pedalText.textContent !== text) pedalText.textContent = text
    pedalText.classList.toggle('rec', !!v?.layer)
  }
  function drawDoc() {
    clickBtn.classList.toggle('on', getTracks(doc).some((t) => t.role === 'click' && !t.muted)) // lit: a click track exists and is unmuted
    presence.replaceChildren(...[s.user, ...st.remote.map((r) => r.user)].map((u) =>
      h('span', { className: 'dot', title: u.username, style: `background:${u.color}` }, initials(u.username))))
    transport.setRecord(!!st.ui.armedTrack, !!st.rec.take)
  }
  const onStatus = ({ status }: { status: string }) => (el.dataset.status = status)
  s.provider?.on('status', onStatus)
  s.provider?.on('authenticationFailed', () => st.status('no access'))

  const offs = [
    st.on('transport', syncTransport),
    st.on('ui', (p) => { if ('armedTrack' in p) syncTransport() }),
    st.on('doc', drawDoc),
    st.on('tick', (p) => { transport.setTime(p / st.rate); drawPedalText() }),
    st.on('cpu', (m) => {
      cpu.textContent = `cpu ${Math.round(m.load * 100)}%`
      cpu.classList.toggle('hot', m.peak >= 0.8)
    }),
  ]
  syncTransport()
  drawDoc()
  return {
    el,
    /** The chat's unread count, on its toggle. */
    setUnread(n: number) { if (chatBtn) chatBtn.textContent = n ? `chat (${n})` : 'chat' },
    destroy() {
      offs.forEach((f) => f())
      s.provider?.off('status', onStatus)
    },
  }
}
