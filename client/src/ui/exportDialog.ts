import { saveBlob, safeName } from '../download'
import { encodeWavPlanar, type WavDepth } from '../audio/wav'
import { RenderAborted, type Rendered, type RenderOptions } from '../audio/render'
import { h } from '../dom'
import { numberField, segmented } from '../theme/controls'
import { modal } from '../theme/dialog'
import { icon } from '../theme/icons'
import './panels.css'

const FORMATS: { value: `${WavDepth}`; label: string; title: string }[] = [
  { value: '16', label: '16-bit', title: 'WAV, 16-bit: CDs and most players' },
  { value: '24', label: '24-bit', title: 'WAV, 24-bit: for mastering or another studio' },
  { value: '32', label: '32-bit float', title: 'WAV, 32-bit float: no clipping, largest file' },
]

/** A modal for rendering the project to a file: pick a name and format, watch the progress, and the download starts when it is done. */
export function exportDialog(opts: {
  name: string
  /** The loop region (samples) and how it reads ("bars 5 – 9"), when the project has one: it can be exported alone. */
  loop?: { start: number; end: number; label: string } | null
  render(o: RenderOptions): Promise<Rendered>
}) {
  const file = h('input', { value: safeName(opts.name), spellcheck: false, 'aria-label': 'file name' })
  const format = segmented(FORMATS, '16')
  const loop = opts.loop && opts.loop.end > opts.loop.start ? opts.loop : null
  const range = segmented<'song' | 'loop'>([
    { value: 'song', label: 'Whole song', title: 'from the first audible clip to the last' },
    { value: 'loop', label: 'Loop region', title: loop ? `only the loop region: ${loop.label}` : 'there is no loop region' },
  ], 'song', () => drawRange())
  const rangeNote = h('span', { className: 'export-note dim' })
  const drawRange = () => (rangeNote.textContent = range.get() === 'loop' && loop ? loop.label : 'first audible clip to the last')
  drawRange()
  if (!loop) range.el.querySelectorAll('button')[1].disabled = true
  const tail = numberField({ value: 2, min: 0, max: 60, step: 1, format: (v) => `${v} s`, width: '72px', title: 'silence added after the last clip, for reverb and delay tails (drag or click to type)' })
  const bar = h('progress', { max: 1, value: 0 })
  const pct = h('span', { className: 'num dim' }, '')
  const msg = h('p', { className: 'export-msg dim', role: 'status' })
  const progress = h('div', { className: 'export-progress', hidden: true }, bar, pct)
  const go = h('button', { className: 'btn primary', onclick: () => void start() }, icon('export'), 'export')
  const cancel = h('button', { className: 'btn', onclick: () => m.close() }, 'cancel')
  const field = (label: string, ...el: HTMLElement[]) => h('label', { className: 'field' }, h('span', {}, label), ...el)
  const m = modal({
    title: 'Export audio',
    className: 'export-dialog',
    body: [
      field('File name', h('span', { className: 'export-file' }, file, h('span', { className: 'dim' }, '.wav'))),
      h('div', { className: 'field' }, h('span', {}, 'Range'), h('span', { className: 'export-range' }, range.el, rangeNote)),
      h('div', { className: 'field' }, h('span', {}, 'Format'), format.el),
      field('Tail after the end', tail.el),
      progress, msg,
    ],
    foot: [cancel, go],
    onClose: () => abort?.abort(),
  })
  let abort: AbortController | null = null
  const lock = (on: boolean) => {
    for (const el of [file, tail.el, go, ...format.el.querySelectorAll('button'), range.el.querySelector('button')!]) (el as HTMLButtonElement).disabled = on
    if (loop) range.el.querySelectorAll('button')[1].disabled = on
  }

  async function start() {
    const name = safeName(file.value.trim().replace(/\.wav$/i, ''), 'untitled')
    const depth = Number(format.get()) as WavDepth
    const ctl = (abort = new AbortController())
    lock(true)
    progress.hidden = false
    bar.value = 0
    msg.className = 'export-msg dim'
    msg.textContent = 'Rendering…'
    try {
      const r = await opts.render({ tail: tail.get(), range: range.get() === 'loop' && loop ? loop : undefined, signal: ctl.signal, onProgress: (f) => ((bar.value = f), (pct.textContent = `${Math.round(f * 100)}%`)) })
      msg.textContent = 'Encoding…'
      await new Promise((res) => setTimeout(res)) // let the message paint
      saveBlob(encodeWavPlanar(r.channels, r.rate, depth), `${name}.wav`)
      if (!r.skipped) return m.close()
      msg.textContent = `Saved. ${r.skipped} audio file${r.skipped > 1 ? 's' : ''} could not be loaded and ${r.skipped > 1 ? 'are' : 'is'} silent in it.`
    } catch (e) {
      if (e instanceof RenderAborted) return
      msg.className = 'export-msg error'
      msg.textContent = (e as Error).message
    }
    abort = null
    progress.hidden = true
    lock(false)
    cancel.textContent = 'close'
  }

  file.select()
}
