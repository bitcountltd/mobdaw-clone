// The master scope in the top bar: a small oscilloscope of the mix (from `pb.analyser`), drawn in the accent colour
// only while audio is moving; at rest it is a flat, faint line and costs nothing. Click it to switch to a spectrum.
import { h } from '../dom'
import type { Studio } from './studio'

export type ScopeMode = 'wave' | 'spectrum'
const MODE_KEY = 'mobdaw.scope'

export function mountScope(st: Studio, w = 120, hgt = 28) {
  const canvas = h('canvas', { className: 'scope-cv' })
  const el = h('button', { className: 'scope', type: 'button', 'aria-label': 'master scope', 'data-hint': 'master scope: click for the spectrum / the waveform' }, canvas)
  let mode: ScopeMode = 'wave'
  try { if (localStorage.getItem(MODE_KEY) === 'spectrum') mode = 'spectrum' } catch { /* (not remembered) */ }
  el.title = mode === 'wave' ? 'master scope (click: spectrum)' : 'master spectrum (click: scope)'
  let raf = 0
  let quietSince = 0
  let lastLoud = 0
  let buf: Float32Array<ArrayBuffer> | null = null
  let bins: Uint8Array<ArrayBuffer> | null = null
  let colors: { accent: string; faint: string } | null = null
  const dpr = () => devicePixelRatio || 1

  function size() {
    const d = dpr()
    if (canvas.width !== Math.round(w * d)) (canvas.width = Math.round(w * d)), (canvas.height = Math.round(hgt * d))
    canvas.style.width = `${w}px`
    canvas.style.height = `${hgt}px`
  }
  function idle() {
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    size()
    colors ??= { accent: css('--accent', '#f0b44c'), faint: css('--faint', '#5d5b57') }
    ctx.setTransform(dpr(), 0, 0, dpr(), 0, 0)
    ctx.clearRect(0, 0, w, hgt)
    ctx.fillStyle = colors.faint
    if (mode === 'wave') ctx.fillRect(0, Math.round(hgt / 2), w, 1)
    else for (let x = 0; x < w; x += 4) ctx.fillRect(x, hgt - 1, 3, 1)
  }
  const css = (n: string, d: string) => getComputedStyle(el).getPropertyValue(n).trim() || d

  function frame() {
    raf = 0
    const pb = st.pb
    if (!pb || st.destroyed) return
    const a = pb.analyser
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    size()
    colors ??= { accent: css('--accent', '#f0b44c'), faint: css('--faint', '#5d5b57') }
    ctx.setTransform(dpr(), 0, 0, dpr(), 0, 0)
    ctx.clearRect(0, 0, w, hgt)
    let peak = 0
    if (mode === 'wave') {
      if (!buf || buf.length !== a.fftSize) buf = new Float32Array(a.fftSize)
      a.getFloatTimeDomainData(buf)
      // start on a rising zero crossing so a steady tone stands still
      let s0 = 0
      for (let i = 1; i < buf.length / 2; i++) if (buf[i - 1] < 0 && buf[i] >= 0) { s0 = i; break }
      const n = Math.min(buf.length - s0, 1024)
      ctx.beginPath()
      for (let x = 0; x <= w; x++) {
        const v = buf[s0 + Math.floor((x / w) * (n - 1))]
        peak = Math.max(peak, Math.abs(v))
        const y = hgt / 2 - Math.max(-1, Math.min(1, v * 1.4)) * (hgt / 2 - 2)
        x ? ctx.lineTo(x, y) : ctx.moveTo(x, y)
      }
      ctx.strokeStyle = colors.accent
      ctx.lineWidth = 1.25
      ctx.lineJoin = 'round'
      ctx.stroke()
    } else {
      if (!bins || bins.length !== a.frequencyBinCount) bins = new Uint8Array(a.frequencyBinCount)
      a.getByteFrequencyData(bins)
      // 30 log-spaced bars from ~40 Hz to ~16 kHz
      const nyq = a.context.sampleRate / 2, bars = 30, bw = w / bars
      ctx.fillStyle = colors.accent
      for (let i = 0; i < bars; i++) {
        const f0 = 40 * Math.pow(400, i / bars), f1 = 40 * Math.pow(400, (i + 1) / bars)
        const b0 = Math.floor((f0 / nyq) * bins.length), b1 = Math.max(b0 + 1, Math.floor((f1 / nyq) * bins.length))
        let m = 0
        for (let b = b0; b < b1 && b < bins.length; b++) m = Math.max(m, bins[b])
        peak = Math.max(peak, m / 255)
        const bh = Math.max(1, (m / 255) * (hgt - 1))
        ctx.fillRect(Math.round(i * bw), hgt - bh, Math.max(1, Math.round(bw) - 1), bh)
      }
    }
    const now = performance.now()
    if (peak > 0.004) (lastLoud = now), (quietSince = 0)
    else if (!quietSince) quietSince = now
    // keep drawing while playing or while something sounds; stop half a second after it all went quiet
    if (st.playing || now - lastLoud < 500) raf = requestAnimationFrame(frame)
    else idle()
  }
  const wake = () => { if (!raf && st.pb && el.isConnected && el.offsetParent) raf = requestAnimationFrame(frame) }

  el.addEventListener('click', () => {
    mode = mode === 'wave' ? 'spectrum' : 'wave'
    el.title = mode === 'wave' ? 'master scope (click: spectrum)' : 'master spectrum (click: scope)'
    try { localStorage.setItem(MODE_KEY, mode) } catch { /* (not remembered) */ }
    idle()
    wake()
  })
  const offs = [
    st.on('transport', wake),
    st.on('meters', (m) => { if (m.master[0] > 0.001 || m.master[1] > 0.001) wake() }),
  ]
  requestAnimationFrame(idle)
  return {
    el,
    destroy() {
      offs.forEach((f) => f())
      cancelAnimationFrame(raf)
    },
  }
}
