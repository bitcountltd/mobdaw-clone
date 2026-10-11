// The loop pedal's section of the project settings: which MIDI input, and what each of the four actions listens for.
import { ACTIONS, type Action } from '../audio/pedal'
import { describeTrigger, getBindings, getMidiInput, learn, listMidiInputs, midiSupported, onMidiDevices, setBinding, setMidiInput } from '../midi'
import { h } from '../dom'

const LABELS: Record<Action, string> = { loop: 'record / loop / overdub', stopLast: 'stop last loop', stopAll: 'stop all loops', undo: 'undo last layer' }
const LEARN_MS = 15000

/** `onChanged` runs whenever the input or a binding changes (the pedal button's state follows the input). */
export function pedalSettings(onChanged: () => void): HTMLElement {
  if (!midiSupported()) return h('p', { className: 'dim' }, 'this browser has no Web MIDI (try Chrome or Firefox).')
  const msg = h('p', { className: 'error' })
  const input = h('select', {})
  const find = h('button', { onclick: () => void list() }, 'find MIDI inputs…')
  const rows = h('div', {})
  let cancel = () => {}

  async function list() {
    try {
      const ins = await listMidiInputs()
      const want = getMidiInput()
      input.replaceChildren(h('option', { value: '' }, 'none'), ...ins.map((i) => h('option', { value: i.id }, i.name)))
      if (want && !ins.some((i) => i.id === want)) input.append(h('option', { value: want }, 'unavailable'))
      input.value = want
      input.hidden = false
      find.hidden = true
      msg.textContent = ''
    } catch (e) {
      msg.textContent = (e as Error).message
    }
  }
  input.hidden = true
  input.onchange = () => (setMidiInput(input.value), onChanged())
  const off = onMidiDevices(() => (input.isConnected ? void list() : off()))
  if (getMidiInput()) void list() // (access was granted before: no prompt)

  function draw() {
    const b = getBindings()
    rows.replaceChildren(...ACTIONS.map((a, i) => {
      const t = b[a]
      const btn = h('button', { title: `press the switch to bind it, or ${i + 1} on the keyboard works without one` }, t ? 'learn again' : 'learn')
      const state = h('span', { className: 'dim grow' }, t ? describeTrigger(t) : 'not set')
      btn.onclick = () => {
        cancel()
        if (!getMidiInput()) return void (msg.textContent = 'choose a MIDI input first')
        const l = learn(getMidiInput())
        const timer = setTimeout(l.cancel, LEARN_MS)
        cancel = l.cancel
        state.textContent = 'press the switch…'
        l.done.then((tr) => (setBinding(a, tr), onChanged()), () => {}).finally(() => (clearTimeout(timer), draw()))
      }
      const clear = t ? h('button', { title: 'forget this switch', onclick: () => (setBinding(a, null), onChanged(), draw()) }, '×') : null
      return h('div', { className: 'pedal-row' }, h('span', {}, `${i + 1} ${LABELS[a]}`), h('div', { className: 'row' }, state, btn, clear))
    }))
  }
  draw()
  return h('div', {}, h('label', { className: 'field' }, h('span', { className: 'dim' }, 'MIDI input'), input), find, rows,
    h('p', { className: 'dim' }, 'with the pedal switched on, keys 1–4 do the same.'), msg)
}
