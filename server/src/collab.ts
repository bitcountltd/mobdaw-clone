import { Database } from '@hocuspocus/extension-database'
import { IncomingMessage, MessageType, Server, type Connection, type Document, type Hocuspocus } from '@hocuspocus/server'
import { chatDocName, chatLog, docName, parseDocName, samplesMap, type ChatMessage } from '@mobdaw/shared'
import { SESSION_COOKIE, isPublic, memberRole, projectRole, sessionUser, writeBlock, type Ctx } from './auth.ts'
import type { Link } from './uploads.ts'

export type Collab = ReturnType<typeof createCollab>

/** Close open connections to a project's document (one user's, or everyone's); clients re-check access. */
export function kick(collab: Collab, projectId: string, userId?: number) {
  for (const name of [docName(projectId), chatDocName(projectId)])
    for (const c of collab.hocuspocus.documents.get(name)?.getConnections() ?? [])
      if (userId === undefined || c.context.userId === userId) c.close({ code: 1000, reason: KICK_REASON })
}
export const KICK_REASON = 'access_changed'

/** Close every open document connection a user has, across projects. */
export function kickUser(collab: Collab, userId: number) {
  for (const doc of collab.hocuspocus.documents.values())
    for (const c of doc.getConnections()) if (c.context.userId === userId) c.close({ code: 1000, reason: KICK_REASON })
}

/**
 * Drop connections that can still write although their user or project is now read-only (a plan change made
 * outside this process, e.g. by the admin CLI). The client reconnects and gets a read-only connection.
 */
export function enforceReadOnly(ctx: Ctx, collab: Collab) {
  for (const [name, doc] of collab.hocuspocus.documents)
    for (const c of doc.getConnections())
      if (!c.readOnly && writeBlock(ctx, parseDocName(name)?.projectId ?? '', c.context.userId)) c.close({ code: 1000, reason: KICK_REASON })
}

/**
 * Audio left these projects (its upload was deleted): where no one else's copy of it is still linked, mark the sample
 * `missing` in the document, so clients show it as deleted (docs/engine.md §9.3). Best effort.
 */
export async function markMissing(ctx: Ctx, collab: Collab, links: Link[]) {
  const linked = ctx.db.prepare('SELECT 1 FROM project_samples WHERE project_id = ? AND hash = ?')
  const exists = ctx.db.prepare('SELECT 1 FROM projects WHERE id = ?')
  const byProject = new Map<string, string[]>()
  for (const l of links) if (!linked.get(l.project_id, l.hash) && exists.get(l.project_id)) byProject.set(l.project_id, [...(byProject.get(l.project_id) ?? []), l.hash])
  for (const [id, hashes] of byProject) {
    try {
      const conn = await collab.hocuspocus.openDirectConnection(docName(id))
      try {
        await conn.transact((doc) => {
          const m = samplesMap(doc)
          for (const h of hashes) {
            const s = m.get(h)
            if (s && !s.status) m.set(h, { ...s, status: 'missing' })
          }
        })
      } finally {
        await conn.disconnect()
      }
    } catch (e) {
      console.error(`marking missing audio in ${id} failed`, e)
    }
  }
}

/**
 * Move chat messages out of a project document into the project's chat document (members only), skipping any already
 * there, and delete them from the project document. Projects kept their chat in their own document until it moved
 * out; a client from before the move may still write it there.
 */
async function moveChat(hocuspocus: Hocuspocus, projectId: string, project: Document) {
  const from = chatLog(project)
  if (!from.length) return
  const msgs = from.toArray()
  const conn = await hocuspocus.openDirectConnection(chatDocName(projectId))
  try {
    await conn.transact((doc) => {
      const to = chatLog(doc)
      const have = new Set(to.toArray().map((m) => m.id))
      for (const m of msgs) {
        if (have.has(m.id)) continue
        // in time order among what is there (the old history goes before anything said since)
        const at = to.toArray().findIndex((x) => x.ts > m.ts)
        to.insert(at < 0 ? to.length : at, [m as ChatMessage])
      }
    })
  } finally {
    await conn.disconnect()
  }
  // (only what was copied: anything written meanwhile is moved by the next call)
  project.transact(() => {
    for (let i = from.length - 1; i >= 0; i--) if (msgs.some((m) => m.id === from.get(i).id)) from.delete(i, 1)
  })
}

/**
 * Watchers (see onAuthenticate) get no presence: drop every awareness message the server would send them (the
 * current states when they connect, later changes, replies to their queries). Installed on the document before any
 * connection is added to it, so it sees each connection before anything is sent on it.
 */
function hidePresenceFromWatchers(document: Document) {
  const add = document.addConnection.bind(document)
  document.addConnection = (connection: Connection) => {
    if (connection.context?.watching) {
      const send = connection.send.bind(connection)
      connection.send = (message: Uint8Array) => {
        const m = new IncomingMessage(message)
        m.readVarString() // the document's name
        if (m.readVarUint() !== MessageType.Awareness) send(message)
      }
    }
    return add(connection)
  }
}

type HeaderBag = Headers | Record<string, string | string[] | undefined> | undefined
const header = (headers: HeaderBag, name: string) => {
  const raw = headers instanceof Headers ? headers.get(name) : headers?.[name]
  return (Array.isArray(raw) ? raw.join('; ') : raw) ?? undefined
}

/** The session token from a request's Cookie header, if any. */
export function cookieToken(headers: HeaderBag): string | undefined {
  const line = header(headers, 'cookie')
  for (const part of line?.split(';') ?? []) {
    const [k, ...v] = part.trim().split('=')
    if (k === SESSION_COOKIE) {
      try {
        return decodeURIComponent(v.join('='))
      } catch {
        return undefined
      }
    }
  }
  return undefined
}

/** Hocuspocus server; the caller swaps in its own HTTP request handler (see main.ts). */
export function createCollab(ctx: Ctx) {
  const { db, config } = ctx
  const server: Server = new Server({
    port: config.port, // listen() is called without a port: it ignores 0
    quiet: true,
    stopOnSignals: false,
    extensions: [
      {
        // Only /collab upgrades are WebSocket connections; drop everything else.
        async onUpgrade({ request, socket }) {
          if (new URL(request.url ?? '/', 'http://x').pathname !== '/collab') {
            socket.destroy()
            throw null // swallowed by Hocuspocus: stops further handling
          }
        },
      },
      new Database({
        async fetch({ documentName }) {
          const row = db.prepare('SELECT data FROM documents WHERE name = ?').get(documentName) as { data: Uint8Array } | undefined
          return row ? new Uint8Array(row.data) : null
        },
        async store({ documentName, state }) {
          // A deleted project's doc may still be flushing: don't resurrect its row.
          const of = parseDocName(documentName)
          if (!of || !db.prepare('SELECT 1 FROM projects WHERE id = ?').get(of.projectId)) return
          db.prepare(
            `INSERT INTO documents(name, data, updated_at) VALUES(?,?,?)
             ON CONFLICT(name) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at`,
          ).run(documentName, state, Date.now())
        },
      }),
    ],
    // Presence is a write too: whoever is not a collaborator (a signed-out visitor, or anyone who got in through a
    // public link) only watches, and is never shown to others.
    async beforeHandleAwareness({ context, states }) {
      if (context?.watching) states.clear()
    },
    async afterLoadDocument({ document, documentName }) {
      hidePresenceFromWatchers(document)
      const of = parseDocName(documentName)
      if (of?.kind !== 'project') return
      // Chat in the project document (an old project's history; a stale client) moves to the chat document before
      // anyone gets the project document, and as soon as it is written later.
      await moveChat(server.hocuspocus, of.projectId, document)
      let moving = false
      chatLog(document).observe(() => {
        if (moving) return
        moving = true
        setTimeout(() => moveChat(server.hocuspocus, of.projectId, document)
          .catch((e) => console.error(`moving chat out of ${documentName} failed`, e))
          .finally(() => (moving = false)), 0)
      })
    },
    async onAuthenticate({ token, documentName, connectionConfig, requestHeaders }) {
      // The client sends the token it keeps in localStorage; the session cookie (sent with the upgrade request) covers a
      // browser whose stored token is gone or stale (storage cleared, signed in again elsewhere) while the cookie lives on.
      // (only from our own pages: a cookie must not let another site open the socket as the user)
      const sameOrigin = header(requestHeaders, 'origin') === new URL(config.publicUrl).origin
      const user = sessionUser(ctx, token) ?? (sameOrigin ? sessionUser(ctx, cookieToken(requestHeaders)) : null)
      const of = parseDocName(documentName)
      const projectId = of?.projectId ?? null
      if (!user) {
        // Signed out: only a public project, read-only (and never its chat).
        if (!projectId || of?.kind !== 'project' || !isPublic(ctx, projectId)) throw new Error('not_signed_in')
        connectionConfig.readOnly = true
        return { userId: null, username: 'guest', role: 'viewer' as const, watching: true }
      }
      // The chat is for the project's members only: not for whoever reads it through a public link.
      const role = projectId && (of?.kind === 'chat' ? memberRole(ctx, projectId, user.id) : projectRole(ctx, projectId, user.id))
      if (!role) throw new Error('forbidden')
      connectionConfig.readOnly = role === 'viewer' || !!writeBlock(ctx, projectId!, user.id)
      return { userId: user.id, username: user.username, role, watching: !memberRole(ctx, projectId!, user.id) }
    },
  })
  return server
}
