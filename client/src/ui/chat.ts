// Chat sidebar: an SMS-style view of the doc's append-only `chat` array (synced and persisted with the project).
import { addChatMessage, chatLog, deleteChatMessage, type AwarenessState, type ChatMessage } from '@mobdaw/shared'
import type * as Y from 'yjs'
import { h } from '../dom'
import { icon } from '../theme/icons'
import { popover } from './popover'
import './chat.css'

const SHOWN = 500
const GAP_MS = 5 * 60_000 // a new name/time line after this much silence
const clock = (ts: number) => new Date(ts).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })

export type ChatDeps = {
  doc: Y.Doc
  user: AwarenessState['user']
  readOnly: boolean
  /** Messages that arrived while the panel was closed. */
  onUnread(n: number): void
  /** The panel opened or closed (from its own close button too). */
  onOpenChange?(open: boolean): void
}

export function chatPanel({ doc, user, readOnly, onUnread, onOpenChange }: ChatDeps) {
  const log = chatLog(doc)
  let open = false
  let seen = 0

  const list = h('div', { className: 'chat-log' })
  const input = h('input', { type: 'text', placeholder: readOnly ? 'viewers can read the chat, not write' : 'message everyone in the project', maxLength: 2000, disabled: readOnly, 'aria-label': 'message' })
  const send = h('button', { className: 'icon-btn chat-send', type: 'button', title: 'send', 'aria-label': 'send', disabled: readOnly }, icon('chevron-right'))
  const empty = h('p', { className: 'chat-empty' }, 'No messages yet. Messages are kept with the project, for everyone in it.')
  const submit = () => {
    if (addChatMessage(doc, user, input.value)) input.value = ''
    list.scrollTop = list.scrollHeight
  }
  send.onclick = submit
  input.onkeydown = (e) => {
    e.stopPropagation() // not a timeline shortcut
    if (e.key === 'Enter') submit()
    else if (e.key === 'Escape') input.blur()
  }
  const close = h('button', { className: 'icon-btn sm', type: 'button', title: 'close the chat', 'aria-label': 'close the chat', onclick: () => api.setOpen(false) }, icon('close'))
  const el = h('aside', { className: 'chat', hidden: true, 'aria-label': 'chat' },
    h('div', { className: 'chat-head' }, h('h2', {}, 'Chat'), close),
    list, h('div', { className: 'chat-in' }, input, send))
  el.addEventListener('keydown', (e) => { if (e.key === 'Escape') (e.stopPropagation(), api.setOpen(false)) })

  function render() {
    const atEnd = list.scrollHeight - list.scrollTop - list.clientHeight < 40
    const msgs = log.toArray().slice(-SHOWN)
    let prev: ChatMessage | undefined
    list.replaceChildren(...(msgs.length ? [] : [empty]), ...msgs.flatMap((m) => {
      const me = m.username === user.username
      const side = me ? 'me' : 'them'
      const out: HTMLElement[] = []
      if (!prev || prev.username !== m.username || m.ts - prev.ts > GAP_MS)
        out.push(h('div', { className: `msg-meta ${side}` }, me ? clock(m.ts) : `${m.username} · ${clock(m.ts)}`))
      const b = h('div', { className: `msg ${side}` }, m.text)
      if (!me) b.style.boxShadow = `inset 2px 0 0 ${m.color}`
      else if (!readOnly) b.oncontextmenu = (e) => { // own messages only: the server can't tell who wrote what
        e.preventDefault()
        popover(b, [['delete message', () => deleteChatMessage(doc, m.id)]], [e.clientX, e.clientY])
      }
      out.push(b)
      prev = m
      return out
    }))
    if (atEnd) list.scrollTop = list.scrollHeight
    if (open) seen = log.length
    onUnread(open ? 0 : Math.max(0, log.length - seen))
  }
  log.observe(render)
  render()

  const api = {
    el,
    get open() { return open },
    setOpen(o: boolean) {
      if (o === open) return
      open = o
      el.hidden = !o
      render()
      if (o) { list.scrollTop = list.scrollHeight; if (!readOnly) input.focus() }
      onOpenChange?.(o)
    },
    /** Treat everything already in the log as read (history loaded on sync). */
    markSeen() { seen = log.length; onUnread(0) },
    destroy() { log.unobserve(render) },
  }
  return api
}
