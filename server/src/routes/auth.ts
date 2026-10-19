import { Hono, type Context } from 'hono'
import { deleteCookie, setCookie } from 'hono/cookie'
import type { LoginResponse, UserInfo } from '@mobdaw/shared'
import {
  SESSION_COOKIE, SESSION_MS, findUser, getMe, insertUser, requireSignedIn, signSession,
  type Ctx, type Env,
} from '../auth.ts'
import { tx } from '../db.ts'
import { PASSWORD_MAX, PASSWORD_MIN, USERNAME_RE, burnPasswordCheck, hashPassword, verifyPassword } from '../password.ts'

// Failed logins per username in a sliding window (in memory: resets on restart, which is fine here).
const MAX_FAILS = 8
const FAIL_WINDOW_MS = 15 * 60_000
const fails = new Map<string, number[]>()
// Username lookups per account, likewise.
const MAX_LOOKUPS = 30
const LOOKUP_WINDOW_MS = 60_000
const lookups = new Map<number, number[]>()
const recentLookups = (id: number) => {
  const now = Date.now()
  const list = (lookups.get(id) ?? []).filter((t) => now - t < LOOKUP_WINDOW_MS)
  list.length ? lookups.set(id, list) : lookups.delete(id)
  return list
}
const recentFails = (u: string) => {
  const now = Date.now()
  const list = (fails.get(u) ?? []).filter((t) => now - t < FAIL_WINDOW_MS)
  list.length ? fails.set(u, list) : fails.delete(u)
  return list
}

type InviteRow = { token: string; expires_at: number | null; redeemed_by: string | null; gift_months: number }
const inviteProblem = (inv: InviteRow | undefined) =>
  !inv ? 'invite_invalid' : inv.redeemed_by ? 'invite_used' : inv.expires_at && inv.expires_at < Date.now() ? 'invite_expired' : null

export function authRoutes(ctx: Ctx) {
  const { config, db } = ctx
  const r = new Hono<Env>()

  const startSession = (c: Context<Env>, userId: number) => {
    const token = signSession(config.sessionSecret, userId)
    setCookie(c, SESSION_COOKIE, token, {
      httpOnly: true,
      sameSite: 'Lax',
      secure: config.publicUrl.startsWith('https:'),
      path: config.basePath || '/',
      maxAge: SESSION_MS / 1000,
    })
    return c.json<LoginResponse>({ token, me: getMe(ctx, userId) })
  }

  r.post('/auth/register', async (c) => {
    const body = await c.req.json().catch(() => ({}))
    const username = String(body.username ?? '').trim().toLowerCase()
    const password = String(body.password ?? '')
    const token = String(body.invite ?? '').trim()
    if (!USERNAME_RE.test(username)) return c.json({ error: 'bad_username' }, 400)
    if (password.length < PASSWORD_MIN || password.length > PASSWORD_MAX) return c.json({ error: 'bad_password' }, 400)
    const find = () => db.prepare('SELECT * FROM invites WHERE token = ?').get(token) as InviteRow | undefined
    const problem = inviteProblem(find())
    if (problem) return c.json({ error: problem }, problem === 'invite_invalid' ? 400 : 410)
    if (findUser(db, username)) return c.json({ error: 'username_taken' }, 409)

    const passwordHash = await hashPassword(password)
    const result = tx(db, () => {
      // Re-check inside the transaction: another request may have used the invite or name meanwhile.
      const invite = find()
      const again = inviteProblem(invite)
      if (again) return again
      if (findUser(db, username)) return 'username_taken'
      const id = insertUser(ctx, username, passwordHash, false, invite!.gift_months)
      db.prepare('UPDATE invites SET redeemed_by = ?, redeemed_at = ? WHERE token = ?').run(username, Date.now(), token)
      return id
    })
    if (typeof result === 'string') return c.json({ error: result }, result === 'username_taken' ? 409 : 410)
    return startSession(c, result)
  })

  r.post('/auth/login', async (c) => {
    const body = await c.req.json().catch(() => ({}))
    const username = String(body.username ?? '').trim().toLowerCase()
    const password = String(body.password ?? '')
    if (recentFails(username).length >= MAX_FAILS) return c.json({ error: 'too_many_attempts' }, 429)
    const user = findUser(db, username)
    const hash = user?.password_hash
    const ok = password.length <= PASSWORD_MAX && (hash ? await verifyPassword(password, hash) : (await burnPasswordCheck(password), false))
    if (!ok) {
      fails.set(username, [...recentFails(username), Date.now()])
      return c.json({ error: 'invalid_credentials' }, 401)
    }
    fails.delete(username)
    return startSession(c, user!.id)
  })

  r.post('/auth/logout', (c) => {
    deleteCookie(c, SESSION_COOKIE, { path: config.basePath || '/' })
    return c.json({ ok: true })
  })

  r.get('/me', requireSignedIn, (c) => c.json(getMe(ctx, c.var.session!.id)))

  // Whether an account goes by exactly this name (to add someone to a project). There is no list of accounts: the
  // owner has to know the name, and guessing is slowed down.
  r.get('/users/:username', requireSignedIn, (c) => {
    const recent = recentLookups(c.var.session!.id)
    if (recent.length >= MAX_LOOKUPS) return c.json({ error: 'too_many_attempts' }, 429)
    lookups.set(c.var.session!.id, [...recent, Date.now()])
    const u = findUser(db, c.req.param('username').trim().toLowerCase())
    return u ? c.json<UserInfo>({ username: u.username }) : c.json({ error: 'not_found' }, 404)
  })

  return r
}
