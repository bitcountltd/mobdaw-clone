// The browser (left panel): instruments, drum kits, effects, effect chains and the project's audio, each a drag source
// (drops.ts). Double-click or Enter puts the item on the selected track. ↑ / ↓ move through the list, ← / → fold a
// section, and typing in the search field filters everything. The keyboard button in the header turns the computer
// keyboard instrument on and off (⇧K).
import { EFFECTS, MASTER_TRACK, getSamples, getTracks, type SampleMeta } from '@mobdaw/shared'
import { peaksFromBase64 } from '../../audio/probe'
import { DRUM_KITS, EFFECT_PRESETS, INSTRUMENT_PRESETS, type InstrumentCategory } from '../../content/presets'
import { h } from '../../dom'
import { iconButton, tooltip } from '../../theme/controls'
import { icon, type IconName } from '../../theme/icons'
import { applyDrop, canDrop, setDragPayload, type DropPayload } from '../drops'
import { connectMidi, midiOpen, qwertyOf } from '../qwerty'
import type { Studio } from '../studio'
import { midiSupported } from '../../midi'
import './browser.css'

type Item = {
  key: string
  name: string
  meta?: string
  icon: IconName
  /** CSS colour for the icon (a track colour token). */
  color: string
  payload: DropPayload
  /** A sub-heading inside the section (instrument categories). */
  sub?: string
  audition?: 'instrument' | 'kit'
  peaks?: string
  missing?: boolean
}
type Section = { id: string; title: string; items: () => Item[]; empty?: string }

const CATEGORY: Record<InstrumentCategory, { name: string; color: string }> = {
  keys: { name: 'Keys', color: 'var(--tc-4)' },
  bass: { name: 'Bass', color: 'var(--tc-1)' },
  lead: { name: 'Lead', color: 'var(--tc-6)' },
  pad: { name: 'Pads', color: 'var(--tc-2)' },
  pluck: { name: 'Plucks', color: 'var(--tc-0)' },
  fx: { name: 'Textures', color: 'var(--tc-3)' },
}
const CAT_ORDER: InstrumentCategory[] = ['keys', 'bass', 'lead', 'pad', 'pluck', 'fx']
const FOLD_KEY = 'mobdaw.browser.folded'

const audioFiles = (list: FileList | null | undefined) =>
  [...(list ?? [])].filter((f) => f.type.startsWith('audio/') || /\.(wav|mp3|ogg|flac|m4a|aac|aif|aiff)$/i.test(f.name))
const fmtDur = (s: number) => (s < 60 ? `${s.toFixed(s < 10 ? 1 : 0)}s` : `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, '0')}`)

/** A tiny waveform from a sample's stored peaks (0..255 per bucket). */
function miniWave(peaks: string | undefined): HTMLCanvasElement | null {
  if (!peaks) return null
  let p: Uint8Array
  try { p = peaksFromBase64(peaks) } catch { return null }
  const w = 40, hgt = 16, dpr = Math.min(2, globalThis.devicePixelRatio || 1)
  const c = h('canvas', { className: 'brow-wave', width: w * dpr, height: hgt * dpr })
  const g = c.getContext('2d')
  if (!g || !p.length) return c
  g.scale(dpr, dpr)
  g.fillStyle = getComputedStyle(document.documentElement).getPropertyValue('--tc-5').trim() || '#8db86b'
  const n = w / 2 // a bar every 2px
  for (let i = 0; i < n; i++) {
    let m = 0
    for (let j = Math.floor((i * p.length) / n), e = Math.floor(((i + 1) * p.length) / n); j < Math.max(e, j + 1) && j < p.length; j++) m = Math.max(m, p[j])
    const a = Math.max(1, (m / 255) * hgt)
    g.fillRect(i * 2, (hgt - a) / 2, 1.4, a)
  }
  return c
}

export function mountBrowser(st: Studio) {
  const { doc } = st
  let folded = new Set<string>()
  try { folded = new Set(JSON.parse(localStorage.getItem(FOLD_KEY) ?? '[]') as string[]) } catch { /* all open */ }
  const saveFolded = () => { try { localStorage.setItem(FOLD_KEY, JSON.stringify([...folded])) } catch { /* not remembered */ } }

  const sections: Section[] = [
    { id: 'inst', title: 'Instruments', items: () => CAT_ORDER.flatMap((cat) => INSTRUMENT_PRESETS.filter((p) => p.category === cat).map((p): Item => ({
      key: `i:${p.id}`, name: p.name, icon: cat === 'keys' ? 'piano' : 'synth', color: CATEGORY[cat].color, payload: { kind: 'instrument', id: p.id },
      sub: CATEGORY[cat].name, audition: 'instrument',
    }))) },
    { id: 'kits', title: 'Drum kits', items: () => DRUM_KITS.map((k): Item => ({
      key: `k:${k.id}`, name: k.name, meta: `${k.drums.length} drums`, icon: 'drum', color: 'var(--tc-5)', payload: { kind: 'kit', id: k.id }, audition: 'kit',
    })) },
    { id: 'fx', title: 'Effects', items: () => EFFECTS.map((d): Item => ({
      key: `e:${d.type}`, name: d.name.charAt(0).toUpperCase() + d.name.slice(1), icon: 'effect', color: 'var(--tc-7)', payload: { kind: 'effect', type: d.type },
    })) },
    { id: 'chains', title: 'Effect chains', items: () => EFFECT_PRESETS.map((p): Item => ({
      key: `c:${p.id}`, name: p.name, meta: p.devices.length > 1 ? `${p.devices.length} effects` : undefined, icon: 'duplicate', color: 'var(--tc-7)', payload: { kind: 'chain', id: p.id },
    })) },
    { id: 'audio', title: 'Project audio', empty: 'Recordings and imported files appear here.', items: () => Object.values(getSamples(doc) as Record<string, SampleMeta>)
      .filter((m) => m.status !== 'incoming')
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((m): Item => ({ key: `s:${m.hash}`, name: m.name.replace(/\.[^.]+$/, ''), meta: fmtDur(m.duration), icon: 'wave', color: 'var(--tc-5)', payload: { kind: 'sample', hash: m.hash }, peaks: m.peaks, missing: m.status === 'missing' })) },
  ]

  // --- header: search and the keyboard toggle
  const search = h('input', { className: 'browser-search', type: 'search', placeholder: 'Search sounds and effects', 'aria-label': 'search the browser', spellcheck: false })
  const kbBtn = h('button', { className: 'icon-btn browser-kb', type: 'button', onclick: () => qwertyOf(st)?.toggle() }, icon('keyboard'), h('span', { className: 'kb-range num' }))
  // (a drawer on narrow screens: it closes with this, a tap outside it, or esc)
  const closeBtn = iconButton('close', 'close the browser (B)', () => st.setUi({ browserOpen: false }), 'sm browser-close')
  const head = h('div', { className: 'browser-head' }, h('label', { className: 'browser-find' }, icon('search', 14), search), kbBtn, closeBtn)

  const list = h('div', { className: 'browser-list', role: 'tree', 'aria-label': 'sounds and effects' })

  // --- footer: import audio, connect MIDI
  const picker = h('input', { type: 'file', accept: 'audio/*', multiple: true, hidden: true })
  picker.onchange = () => {
    const files = audioFiles(picker.files)
    picker.value = ''
    if (files.length) void st.dropFiles(files, null, st.snap(st.position()))
  }
  const importBtn = h('button', { className: 'browser-act', type: 'button', disabled: st.readOnly, onclick: () => picker.click() }, icon('upload', 14), 'Import audio…')
  const midiBtn = h('button', { className: 'browser-act', type: 'button', title: 'let MIDI keyboards play the selected instrument track', onclick: () => void connectMidi(st) }, icon('piano', 14), 'Connect MIDI keyboard')
  const foot = h('div', { className: 'browser-foot' }, importBtn, midiBtn, picker)

  const el = h('div', { className: 'browser' }, head, list, foot)

  // --- rows
  let rows: { el: HTMLElement; item: Item; section: string }[] = []
  let active = -1 // index into rows (of the visible ones) that has the roving focus

  function focusTarget(p: DropPayload): string | null {
    const f = st.ui.focusTrack
    return f && canDrop(st, p, f) ? f : null
  }
  function use(item: Item) {
    if (st.readOnly) return
    const p = item.payload
    if ((p.kind === 'effect' || p.kind === 'chain') && !st.ui.focusTrack) return st.status('Click a track (or the master) first, then add effects to it.')
    if (p.kind === 'sample' && item.missing) return st.status('That recording is missing on this device.')
    st.undo.stopCapturing()
    const landed = applyDrop(st, p, { trackId: focusTarget(p), at: st.snap(st.position()) })
    st.undo.stopCapturing()
    if (landed) {
      const name = landed === MASTER_TRACK ? 'the master' : getTracks(doc).find((t) => t.id === landed)?.name ?? 'the track'
      st.status(`Added ${item.name} to ${name}.`)
    }
  }

  // Audition: hold ▶ on an instrument or kit. It is applied to the selected MIDI track (one undo step) and a short phrase plays.
  let auditionTimers: number[] = []
  let auditionNotes: { track: string; pitch: number }[] = []
  function stopAudition() {
    auditionTimers.forEach(clearTimeout)
    auditionTimers = []
    for (const n of auditionNotes) st.pb?.noteLive(n.track, n.pitch, 0, false)
    auditionNotes = []
  }
  function audition(item: Item) {
    stopAudition()
    const target = st.midi.target()
    if (!target) return st.status('Click an instrument track first to try sounds on it.')
    st.undo.stopCapturing()
    applyDrop(st, item.payload, { trackId: target })
    st.undo.stopCapturing()
    st.status(`Trying ${item.name} on ${getTracks(doc).find((t) => t.id === target)?.name ?? 'the track'}. Undo to go back.`)
    // [ms from start, pitch, length ms]
    const phrase: [number, number, number][] = item.audition === 'kit'
      ? [[0, 36, 120], [0, 42, 60], [250, 42, 60], [500, 38, 120], [500, 42, 60], [750, 42, 60], [1000, 36, 120], [1125, 36, 120], [1250, 42, 60], [1500, 38, 120], [1750, 46, 200]]
      : [[0, 60, 220], [240, 64, 220], [480, 67, 220], [720, 72, 600], [1400, 60, 900], [1400, 64, 900], [1400, 67, 900]]
    const pb = st.pb
    if (!pb) return
    for (const [t, pitch, len] of phrase) {
      auditionTimers.push(window.setTimeout(() => {
        pb.noteLive(target, pitch, 0.8, true)
        auditionNotes.push({ track: target, pitch })
      }, t))
      auditionTimers.push(window.setTimeout(() => {
        pb.noteLive(target, pitch, 0, false)
        auditionNotes = auditionNotes.filter((n) => !(n.track === target && n.pitch === pitch))
      }, t + len))
    }
  }

  function row(item: Item, section: string) {
    const ic = icon(item.icon, 16, 'brow-icon') // (dim: a colour here would read as a track's)
    const kids: (Node | null)[] = [ic, h('span', { className: 'brow-name' }, item.name)]
    if (item.peaks !== undefined || item.payload.kind === 'sample') kids.push(miniWave(item.peaks))
    if (item.meta) kids.push(h('span', { className: 'brow-meta num' }, item.meta))
    if (item.audition && !st.readOnly) {
      const play = h('button', { className: 'brow-play', type: 'button', tabIndex: -1, 'aria-label': `try ${item.name}` }, icon('play', 12))
      tooltip(play, `hold to try ${item.name} on the focused instrument track`)
      play.addEventListener('pointerdown', (e) => { e.stopPropagation(); e.preventDefault(); play.setPointerCapture(e.pointerId); play.classList.add('on'); audition(item) })
      const end = () => { play.classList.remove('on'); stopAudition() }
      play.addEventListener('pointerup', end)
      play.addEventListener('pointercancel', end)
      play.addEventListener('dblclick', (e) => e.stopPropagation())
      kids.push(play)
    }
    const r = h('div', {
      className: `brow${item.missing ? ' missing' : ''}`, role: 'treeitem', tabIndex: -1, draggable: !st.readOnly,
      title: `${item.name}: double-click to add to the selected track, or drag it onto a track`,
    }, ...kids)
    r.addEventListener('dragstart', (e) => {
      setDragPayload(e, item.payload)
      r.classList.add('dragging')
    })
    r.addEventListener('dragend', () => r.classList.remove('dragging'))
    r.addEventListener('dblclick', () => use(item))
    r.addEventListener('mousedown', () => setActive(rows.findIndex((x) => x.el === r), false))
    return r
  }

  function visibleRows() { return rows.filter((r) => !r.el.hidden && !r.el.closest('.bsec.folded')) }
  function setActive(i: number, focus = true) {
    rows.forEach((r) => (r.el.tabIndex = -1))
    active = i
    const r = rows[i]
    if (!r) return
    r.el.tabIndex = 0
    if (focus) {
      r.el.focus()
      r.el.scrollIntoView({ block: 'nearest' })
    }
  }
  function move(d: number) {
    const vis = visibleRows()
    if (!vis.length) return
    const cur = vis.findIndex((r) => r === rows[active])
    const next = vis[Math.min(vis.length - 1, Math.max(0, cur < 0 ? (d > 0 ? 0 : vis.length - 1) : cur + d))]
    setActive(rows.indexOf(next))
  }

  let sig = ''
  function render() {
    const q = search.value.trim().toLowerCase()
    const all = sections.map((s) => ({ s, items: s.items() }))
    // rebuild only when the items change (project audio comes and goes)
    const nextSig = all.map(({ items }) => items.map((i) => i.key + (i.peaks ? '~' : '') + (i.missing ? '!' : '')).join(',')).join('|')
    if (nextSig !== sig) {
      sig = nextSig
      const activeKey = rows[active]?.item.key
      rows = []
      list.replaceChildren(...all.map(({ s, items }) => {
        const body = h('div', { className: 'bsec-body', role: 'group' })
        let sub = ''
        for (const it of items) {
          if (it.sub && it.sub !== sub) body.append(h('div', { className: 'bsub', 'data-sub': (sub = it.sub) }, it.sub))
          const r = row(it, s.id)
          rows.push({ el: r, item: it, section: s.id })
          body.append(r)
        }
        if (!items.length && s.empty) body.append(h('p', { className: 'bsec-empty' }, s.empty))
        const chev = icon('chevron-down', 14, 'bsec-chev')
        const headBtn = h('button', { className: 'bsec-head', type: 'button', 'aria-expanded': String(!folded.has(s.id)), onclick: () => {
          if (folded.has(s.id)) folded.delete(s.id)
          else folded.add(s.id)
          saveFolded()
          sec.classList.toggle('folded', folded.has(s.id))
          headBtn.setAttribute('aria-expanded', String(!folded.has(s.id)))
        } }, chev, h('span', {}, s.title), h('span', { className: 'bsec-count num' }, String(items.length)))
        const sec = h('section', { className: `bsec${folded.has(s.id) ? ' folded' : ''}`, 'data-sec': s.id }, headBtn, body)
        return sec
      }))
      const i = rows.findIndex((r) => r.item.key === activeKey)
      setActive(i >= 0 ? i : 0, false)
    }
    // filter
    el.classList.toggle('searching', !!q)
    for (const r of rows) {
      const hay = `${r.item.name} ${r.item.sub ?? ''} ${r.item.meta ?? ''} ${sections.find((s) => s.id === r.section)!.title}`.toLowerCase()
      r.el.hidden = !!q && !q.split(/\s+/).every((w) => hay.includes(w))
    }
    for (const sec of list.querySelectorAll<HTMLElement>('.bsec')) {
      const any = [...sec.querySelectorAll<HTMLElement>('.brow')].some((r) => !r.hidden)
      sec.hidden = !!q && !any
      for (const sub of sec.querySelectorAll<HTMLElement>('.bsub')) {
        let n = sub.nextElementSibling as HTMLElement | null, show = false
        while (n && n.classList.contains('brow')) { if (!n.hidden) show = true; n = n.nextElementSibling as HTMLElement | null }
        sub.hidden = !show
      }
    }
    list.querySelector('.browser-none')?.remove()
    if (q && !rows.some((r) => !r.el.hidden)) list.append(h('p', { className: 'browser-none' }, `Nothing matches “${search.value.trim()}”.`))
  }

  function syncHead() {
    const q = qwertyOf(st)
    const on = !!q?.on
    kbBtn.classList.toggle('on', on)
    kbBtn.title = on ? `computer keyboard on: plays ${q!.range()}, velocity ${q!.velocity} (⇧K to turn off)` : 'play notes from the computer keyboard (⇧K)'
    ;(kbBtn.querySelector('.kb-range') as HTMLElement).textContent = on ? q!.range().split('–')[0] : ''
    midiBtn.hidden = !midiSupported() || midiOpen()
  }

  // keyboard: in the list
  list.addEventListener('keydown', (e) => {
    if (e.target instanceof HTMLButtonElement && e.target.classList.contains('bsec-head') && (e.key === 'Enter' || e.key === ' ')) return
    const r = rows[active]
    const handled = (() => {
      switch (e.key) {
        case 'ArrowDown': move(1); return true
        case 'ArrowUp': move(-1); return true
        case 'Home': setActive(rows.indexOf(visibleRows()[0])); return true
        case 'End': { const v = visibleRows(); setActive(rows.indexOf(v[v.length - 1])); return true }
        case 'Enter': if (r) use(r.item); return true
        case 'ArrowLeft': case 'ArrowRight': {
          if (!r) return true
          const sec = r.el.closest('.bsec') as HTMLElement
          const want = e.key === 'ArrowLeft'
          if (sec.classList.contains('folded') !== want) (sec.querySelector('.bsec-head') as HTMLButtonElement).click()
          if (want) (sec.querySelector('.bsec-head') as HTMLButtonElement).focus()
          return true
        }
        case 'Escape': search.focus(); return true
      }
      return false
    })()
    if (handled) { e.preventDefault(); e.stopPropagation() }
  })
  // keyboard: in the search field (the studio's shortcuts already leave text fields alone)
  search.addEventListener('input', render)
  search.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); move(1) }
    else if (e.key === 'Enter') {
      e.preventDefault()
      const first = visibleRows()[0]
      if (first) use(first.item)
    } else if (e.key === 'Escape') {
      if (search.value) { search.value = ''; render() } else search.blur()
      e.preventDefault()
      e.stopPropagation()
    }
  })

  const offs = [
    st.on('doc', render),
    st.on('transport', syncHead),
    st.on('status', syncHead),
  ]
  // narrow screens: the browser is a drawer over the tracks (studio.css); a press outside it or esc closes it
  const drawer = () => typeof matchMedia === 'function' && matchMedia('(max-width: 899px)').matches && st.ui.browserOpen
  const onDown = (e: PointerEvent) => {
    const t = e.target as Element | null
    if (!drawer() || !t?.isConnected || el.contains(t) || t.closest('.popover, dialog, .studio-top')) return
    st.setUi({ browserOpen: false })
  }
  const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape' && drawer() && !e.defaultPrevented) st.setUi({ browserOpen: false }) }
  addEventListener('pointerdown', onDown, true)
  addEventListener('keydown', onKey)
  offs.push(() => removeEventListener('pointerdown', onDown, true), () => removeEventListener('keydown', onKey))
  const q = qwertyOf(st) // (mounted before the browser)
  if (q) offs.push(q.onChange(syncHead))
  render()
  syncHead()

  return {
    el,
    focusSearch: () => search.focus(),
    destroy() {
      stopAudition()
      offs.forEach((f) => f())
    },
  }
}
