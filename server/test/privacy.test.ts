// What people who only read a public project (signed out, or signed in but not members) must not get: the
// collaborators' chat and their presence.
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { HocuspocusProvider } from '@hocuspocus/provider'
import { addChatMessage, addTrack, chatDocName, chatLog, docName, getTracks, type ChatMessage } from '@mobdaw/shared'
import WebSocket from 'ws'
import * as Y from 'yjs'
import { ADMIN, admit, login, startTest, until, type Client } from './helpers.ts'

let t: Awaited<ReturnType<typeof startTest>>
let admin: Client, alice: Client, outsider: Client
let projectId: string
const open: HocuspocusProvider[] = []

const OLD: ChatMessage[] = [
  { id: 'old1', username: ADMIN, color: '#f00', text: 'secret plans', ts: 1000 },
  { id: 'old2', username: 'alice', color: '#0f0', text: 'more secrets', ts: 2000 },
]

beforeAll(async () => {
  t = await startTest()
  admin = await login(t.base, ADMIN)
  alice = await admit(t.base, admin, 'alice')
  outsider = await admit(t.base, admin, 'outsider')
  projectId = (await admin.post('/api/projects', { name: 'Public' })).body.id
  await admin.post(`/api/projects/${projectId}/members`, { username: 'alice' })
  await admin.patch(`/api/projects/${projectId}`, { public: true })
  // A project from before chat moved out of the project document: its history is in there.
  const d = new Y.Doc()
  addTrack(d, 'Drums')
  chatLog(d).push(OLD)
  t.ctx.db.prepare('INSERT INTO documents(name, data, updated_at) VALUES(?,?,?)').run(docName(projectId), Y.encodeStateAsUpdate(d), Date.now())
})
afterAll(async () => {
  for (const p of open) p.destroy()
  await t.cleanup()
})

/** Open a document as `token` ('' for signed out); `failed` resolves if the server turns it down. */
function connect(name: string, token: string) {
  const doc = new Y.Doc()
  const provider = new HocuspocusProvider({ url: `ws://127.0.0.1:${t.port}/collab`, name, document: doc, token, WebSocketPolyfill: WebSocket } as ConstructorParameters<typeof HocuspocusProvider>[0])
  open.push(provider)
  const failed = new Promise<boolean>((resolve) => {
    provider.on('authenticationFailed', () => resolve(true))
    provider.on('synced', () => resolve(false))
  })
  return { doc, provider, failed }
}
const settle = () => new Promise((r) => setTimeout(r, 300))
const others = (p: HocuspocusProvider) => [...p.awareness!.getStates()].filter(([id]) => id !== p.document.clientID).map(([, s]) => s)

describe('public-link viewers', () => {
  it('get the project without its chat; members find the old history in the chat document', async () => {
    const guest = connect(docName(projectId), '')
    const stranger = connect(docName(projectId), outsider.token!)
    expect(await guest.failed).toBe(false)
    expect(await stranger.failed).toBe(false)
    for (const w of [guest, stranger]) {
      expect(getTracks(w.doc).map((x) => x.name)).toEqual(['Drums'])
      expect(chatLog(w.doc).length).toBe(0)
      expect(JSON.stringify(w.doc.toJSON())).not.toContain('secret')
    }
    // and the stored project document no longer has it either
    await until(() => !Buffer.from((t.ctx.db.prepare('SELECT data FROM documents WHERE name = ?').get(docName(projectId)) as { data: Uint8Array }).data).includes('secret'))

    const chat = connect(chatDocName(projectId), alice.token!)
    expect(await chat.failed).toBe(false)
    expect(chatLog(chat.doc).toArray()).toEqual(OLD)
  })

  it("can't open the chat document", async () => {
    expect(await connect(chatDocName(projectId), '').failed).toBe(true)
    expect(await connect(chatDocName(projectId), outsider.token!).failed).toBe(true)
    expect(await connect(chatDocName(projectId), 'garbage').failed).toBe(true)
  })

  it('receive no chat entries as members talk, including ones a stale client writes into the project', async () => {
    const guest = connect(docName(projectId), '')
    const member = connect(docName(projectId), admin.token!)
    const chat = connect(chatDocName(projectId), admin.token!)
    await Promise.all([guest.failed, member.failed, chat.failed])

    addChatMessage(chat.doc, { username: ADMIN, color: '#f00' }, 'new secret')
    expect(chatLog(chat.doc).length).toBe(3)
    // a client from before the move writes into the project document: it moves to the chat document
    addChatMessage(member.doc, { username: ADMIN, color: '#f00' }, 'stale secret')
    await until(() => chatLog(chat.doc).toArray().some((m) => m.text === 'stale secret'))
    await until(() => chatLog(member.doc).length === 0 && chatLog(guest.doc).length === 0)
    expect(chatLog(chat.doc).toArray().map((m) => m.text)).toEqual(['secret plans', 'more secrets', 'new secret', 'stale secret'])
    expect(JSON.stringify(guest.doc.toJSON())).not.toContain('new secret')
  })

  it("receive no other user's presence, whether it was there before they came or set after", async () => {
    const a = connect(docName(projectId), alice.token!)
    await a.failed
    a.provider.awareness!.setLocalStateField('user', { username: 'alice', color: '#0f0' })
    const b = connect(docName(projectId), admin.token!)
    await b.failed
    await until(() => others(b.provider).some((s) => s.user?.username === 'alice')) // members do see each other

    const guest = connect(docName(projectId), '')
    const stranger = connect(docName(projectId), outsider.token!)
    await Promise.all([guest.failed, stranger.failed])
    guest.provider.awareness!.setLocalStateField('user', { username: 'guest', color: '#000' })
    a.provider.awareness!.setLocalStateField('selection', { clips: ['x'] })
    b.provider.awareness!.setLocalStateField('user', { username: ADMIN, color: '#f00' })
    await settle()
    expect(others(guest.provider)).toEqual([])
    expect(others(stranger.provider)).toEqual([])
    // and the watcher's own state reaches no one
    expect(others(a.provider).filter((s) => s.user).map((s) => s.user.username)).toEqual([ADMIN])
  })
})

describe('usernames', () => {
  it('are looked up by exact name only, and guessing is throttled', async () => {
    const guesser = await admit(t.base, admin, 'guesser')
    expect((await guesser.get('/api/users')).body).not.toEqual(expect.arrayContaining([expect.objectContaining({ username: 'alice' })]))
    expect((await guesser.get('/api/users/a')).status).toBe(404)
    expect((await guesser.get('/api/users/al*')).status).toBe(404)
    expect((await guesser.get('/api/users/alice')).body).toEqual({ username: 'alice' })
    const statuses: number[] = []
    for (let i = 0; i < 30; i++) statuses.push((await guesser.get(`/api/users/guess${i}`)).status)
    expect(statuses.at(-1)).toBe(429)
    expect((await guesser.get('/api/users/alice')).status).toBe(429) // even a right guess, until the window passes
    expect((await alice.get('/api/users/outsider')).status).toBe(200) // per account
  })
})
