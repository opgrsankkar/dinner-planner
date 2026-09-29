import assert from 'node:assert/strict'
import test from 'node:test'
import type { AuthConfig } from '../src/security/config.ts'
import { loadAuthConfig } from '../src/security/config.ts'
import { csrfTokenMatches, isSameOriginRequest, verifyCsrfRequest } from '../src/security/csrf.ts'
import { handleLoginRequest, handleLogoutRequest } from '../src/security/auth-handlers.ts'
import { isAllowedHost } from '../src/security/host.ts'
import { safeNext } from '../src/security/redirect.ts'
import { LoginRateLimiter, LOGIN_WINDOW_SECONDS, clientIpFromRequest } from '../src/security/rate-limit.ts'
import { withSecurityHeaders } from '../src/security/response.ts'
import { createSession, expireSessionCookie, readSession, sessionCookieName, SESSION_TTL_SECONDS } from '../src/security/session.ts'
import { createSecurityHandler } from '../src/security/server-handler.ts'

const testConfig: AuthConfig = {
  appPassword: 'correct horse battery staple',
  sessionSecret: 'test-only-session-secret-0123456789abcdef',
  allowedHosts: ['planner.test', '*.trusted.test'],
  cookieSecure: true,
}

function signedCookie(config = testConfig, now = 1_800_000_000_000): { cookie: string; csrfToken: string } {
  const { cookie, session } = createSession(config, now)
  return { cookie: cookie.split(';', 1)[0]!, csrfToken: session.csrfToken }
}

function formRequest(
  path: string,
  fields: Record<string, string>,
  options: { readonly ip?: string; readonly cookie?: string; readonly origin?: string } = {},
): Request {
  const headers = new Headers({ 'content-type': 'application/x-www-form-urlencoded' })
  if (options.origin !== undefined) headers.set('origin', options.origin)
  if (options.cookie) headers.set('cookie', options.cookie)
  if (options.ip) headers.set('x-forwarded-for', options.ip)
  return new Request(`https://planner.test${path}`, {
    method: 'POST',
    headers,
    body: new URLSearchParams(fields),
  })
}

test('authentication configuration requires credentials and validates host entries', () => {
  assert.throws(() => loadAuthConfig({ SESSION_SECRET: 'a'.repeat(32) }), /APP_PASSWORD must be set/)
  assert.throws(() => loadAuthConfig({ APP_PASSWORD: 'test', SESSION_SECRET: 'short' }), /at least 32 characters/)
  assert.throws(
    () => loadAuthConfig({ APP_PASSWORD: 'test', SESSION_SECRET: 's'.repeat(32), ALLOWED_HOSTS: 'planner.test,https://evil.test' }),
    /Invalid ALLOWED_HOSTS entry/,
  )
  assert.throws(
    () => loadAuthConfig({ APP_PASSWORD: 'test', SESSION_SECRET: 's'.repeat(32), ALLOWED_HOSTS: 'planner.test,' }),
    /at least one host/,
  )
  assert.throws(
    () => loadAuthConfig({ APP_PASSWORD: 'test', SESSION_SECRET: 's'.repeat(32), ALLOWED_HOSTS: 'planner..test' }),
    /Invalid ALLOWED_HOSTS entry/,
  )

  const defaults = loadAuthConfig({ APP_PASSWORD: 'test', SESSION_SECRET: 's'.repeat(32) })
  assert.equal(defaults.cookieSecure, true)
  assert.deepEqual(defaults.allowedHosts, ['meals.happydaysblr.ddns.net', 'localhost', '127.0.0.1', 'testserver'])
  assert.equal(loadAuthConfig({ APP_PASSWORD: 'test', SESSION_SECRET: 's'.repeat(32), COOKIE_SECURE: 'false' }).cookieSecure, false)
})

test('sessions are signed, HttpOnly, Lax, Secure by default, and expire after 30 days', () => {
  const now = 1_800_000_000_000
  const { cookie, csrfToken } = signedCookie(testConfig, now)
  const attributes = createSession(testConfig, now).cookie.split('; ').slice(1)
  assert.equal(sessionCookieName(testConfig), '__Host-meals_session')
  assert.ok(attributes.includes('Path=/'))
  assert.ok(attributes.includes(`Max-Age=${SESSION_TTL_SECONDS}`))
  assert.ok(attributes.includes('HttpOnly'))
  assert.ok(attributes.includes('SameSite=Lax'))
  assert.ok(attributes.includes('Secure'))
  assert.equal(attributes.some((attribute) => attribute.toLowerCase().startsWith('domain=')), false)

  const tokenHeader = cookie
  assert.equal(readSession(tokenHeader, testConfig, now)?.csrfToken, csrfToken)
  assert.equal(readSession(tokenHeader, testConfig, now + SESSION_TTL_SECONDS * 1000 - 1)?.csrfToken, csrfToken)
  assert.equal(readSession(tokenHeader, testConfig, now + SESSION_TTL_SECONDS * 1000), null)
  assert.equal(readSession(tokenHeader, { ...testConfig, sessionSecret: 'different-session-secret-0123456789' }, now), null)

  const [payload, mac] = cookie.split('.')
  assert.ok(payload && mac)
  const changedMac = `${mac![0] === 'A' ? 'B' : 'A'}${mac!.slice(1)}`
  assert.equal(readSession(`__Host-meals_session=${payload}.${changedMac}`, testConfig, now), null)
  const changedPayload = `${payload![0] === 'A' ? 'B' : 'A'}${payload!.slice(1)}.${mac}`
  assert.equal(readSession(`__Host-meals_session=${changedPayload}`, testConfig, now), null)

  const localConfig = { ...testConfig, cookieSecure: false }
  const localCookie = createSession(localConfig, now).cookie
  assert.match(localCookie, /^meals_session=/u)
  assert.doesNotMatch(localCookie, /(?:^|; )Secure(?:;|$)/u)
  assert.match(expireSessionCookie(testConfig), /^__Host-meals_session=; Path=\/; Max-Age=0/u)
})

test('password comparison, per-IP five-attempt rolling limits, and successful reset', () => {
  const limiter = new LoginRateLimiter()
  let comparisons = 0
  for (let index = 0; index < 5; index += 1) {
    assert.equal(limiter.authenticate('192.0.2.1', 1000 + index, () => { comparisons += 1; return false }), 'invalid')
  }
  assert.equal(limiter.authenticate('192.0.2.1', 1005, () => { comparisons += 1; return true }), 'rate_limited')
  assert.equal(comparisons, 5, 'blocked attempts must not invoke the password check')
  assert.equal(limiter.authenticate('192.0.2.2', 1005, () => true), 'authenticated')
  assert.equal(limiter.authenticate('192.0.2.1', 1000 + LOGIN_WINDOW_SECONDS + 6, () => true), 'authenticated')

  for (let index = 0; index < 4; index += 1) {
    assert.equal(limiter.authenticate('198.51.100.1', 2000 + index, () => false), 'invalid')
  }
  assert.equal(limiter.authenticate('198.51.100.1', 2004, () => true), 'authenticated')
  assert.equal(limiter.authenticate('198.51.100.1', 2005, () => false), 'invalid')
})

test('safe redirects reject external, protocol-relative, encoded, backslash, and control-character targets', () => {
  assert.equal(safeNext('/settings?tab=slots'), '/settings?tab=slots')
  assert.equal(safeNext('/'), '/')
  for (const value of [
    'https://attacker.test/',
    '//attacker.test/path',
    '/%2f%2fattacker.test/',
    '/%252f%252fattacker.test/',
    '/\\attacker.test/',
    '/%5c%5cattacker.test/',
    '/safe%0d%0aLocation:%20https://attacker.test',
  ]) {
    assert.equal(safeNext(value), '/', `unsafe target ${value} must use the local fallback`)
  }
})

test('host checks allow configured exact and subdomain hosts and reject hostile authorities', () => {
  assert.equal(isAllowedHost(new Request('https://planner.test/'), testConfig), true)
  assert.equal(isAllowedHost(new Request('https://board.trusted.test/'), testConfig), true)
  assert.equal(isAllowedHost(new Request('https://trusted.test/'), testConfig), false)
  assert.equal(isAllowedHost(new Request('https://evil.test/', { headers: { host: 'evil.test' } }), testConfig), false)
  assert.equal(isAllowedHost(new Request('https://planner.test/', { headers: { host: 'planner.test.evil.test' } }), testConfig), false)
})

test('CSRF checks require a same-origin request and constant-time token equality', () => {
  const session = createSession(testConfig, 1_800_000_000_000).session
  const sameOrigin = new Request('https://planner.test/logout', {
    method: 'POST',
    headers: { origin: 'https://planner.test' },
  })
  const hostileOrigin = new Request('https://planner.test/logout', {
    method: 'POST',
    headers: { origin: 'https://planner.test.evil.test' },
  })
  const refererOnly = new Request('https://planner.test/logout', {
    method: 'POST',
    headers: { referer: 'https://planner.test/account' },
  })
  assert.equal(isSameOriginRequest(sameOrigin), true)
  assert.equal(isSameOriginRequest(hostileOrigin), false)
  assert.equal(isSameOriginRequest(refererOnly), true)
  assert.equal(isSameOriginRequest(new Request('https://planner.test/logout', { method: 'POST' })), false)
  assert.equal(csrfTokenMatches(session.csrfToken, session.csrfToken), true)
  assert.equal(csrfTokenMatches(session.csrfToken, `${session.csrfToken}x`), false)
  assert.equal(verifyCsrfRequest(sameOrigin, session, session.csrfToken), true)
  assert.equal(verifyCsrfRequest(hostileOrigin, session, session.csrfToken), false)
})

test('login and logout preserve failure statuses, signed sessions, and CSRF requirements', async () => {
  const now = 1_800_000_000_000
  const limiter = new LoginRateLimiter()
  const wrongPassword = await handleLoginRequest(
    formRequest('/login', { password: 'incorrect', next: '/planner' }, { ip: '203.0.113.10', origin: 'https://planner.test' }),
    testConfig,
    { now: () => now, rateLimiter: limiter },
  )
  assert.equal(wrongPassword.status, 401)
  assert.match(await wrongPassword.text(), /role="alert"/u)

  const unsafeNext = await handleLoginRequest(
    formRequest('/login', { password: 'incorrect', next: '//attacker.test' }, { ip: '203.0.113.11', origin: 'https://planner.test' }),
    testConfig,
    { now: () => now, rateLimiter: new LoginRateLimiter() },
  )
  assert.equal(unsafeNext.status, 401)
  assert.match(await unsafeNext.text(), /value="\/"/u)

  const failedOrigin = await handleLoginRequest(
    formRequest('/login', { password: testConfig.appPassword, next: '/' }, { ip: '203.0.113.12', origin: 'https://attacker.test' }),
    testConfig,
    { now: () => now, rateLimiter: new LoginRateLimiter() },
  )
  assert.equal(failedOrigin.status, 403)

  const success = await handleLoginRequest(
    formRequest('/login', { password: testConfig.appPassword, next: '/settings?view=slots' }, { ip: '203.0.113.13', origin: 'https://planner.test' }),
    testConfig,
    { now: () => now, rateLimiter: new LoginRateLimiter() },
  )
  assert.equal(success.status, 303)
  assert.equal(success.headers.get('location'), '/settings?view=slots')
  const setCookie = success.headers.get('set-cookie')!
  const session = readSession(setCookie, testConfig, now)
  assert.ok(session)
  assert.ok(session.csrfToken)

  const logoutWithoutCsrf = await handleLogoutRequest(
    new Request('https://planner.test/logout', {
      method: 'POST',
      headers: { cookie: setCookie, origin: 'https://planner.test' },
    }),
    testConfig,
    now,
  )
  assert.equal(logoutWithoutCsrf.status, 403)

  const logout = await handleLogoutRequest(
    formRequest('/logout', { csrf: session.csrfToken }, { cookie: setCookie, origin: 'https://planner.test' }),
    testConfig,
    now,
  )
  assert.equal(logout.status, 303)
  assert.equal(logout.headers.get('location'), '/login')
  assert.match(logout.headers.get('set-cookie')!, /Max-Age=0/u)
})

test('login rejects after five failures for one IP and allows another IP independently', async () => {
  const now = 1_800_000_000_000
  const limiter = new LoginRateLimiter()
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const response = await handleLoginRequest(
      formRequest('/login', { password: 'wrong' }, { ip: '192.0.2.44', origin: 'https://planner.test' }),
      testConfig,
      { now: () => now + attempt * 1000, rateLimiter: limiter },
    )
    assert.equal(response.status, 401)
  }
  const blocked = await handleLoginRequest(
    formRequest('/login', { password: testConfig.appPassword }, { ip: '192.0.2.44', origin: 'https://planner.test' }),
    testConfig,
    { now: () => now + 5000, rateLimiter: limiter },
  )
  assert.equal(blocked.status, 429)
  assert.match(await blocked.text(), /Too many attempts/u)

  const otherIp = await handleLoginRequest(
    formRequest('/login', { password: testConfig.appPassword }, { ip: '192.0.2.45', origin: 'https://planner.test' }),
    testConfig,
    { now: () => now + 5000, rateLimiter: limiter },
  )
  assert.equal(otherIp.status, 303)
  assert.equal(clientIpFromRequest(formRequest('/login', {}, { ip: '192.0.2.45', origin: 'https://planner.test' })), '192.0.2.45')
})

test('server guard redirects pages, returns JSON 401 for APIs, and leaves healthz public', async () => {
  const seen: string[] = []
  const handler = createSecurityHandler(async (request) => {
    seen.push(new URL(request.url).pathname)
    return Response.json({ status: 'ok' })
  }, { getConfig: () => testConfig, now: () => 1_800_000_000_000 })

  const page = await handler(new Request('https://planner.test/private?week=2026-09-28'))
  assert.equal(page.status, 303)
  assert.match(page.headers.get('location')!, /^\/login\?next=%2Fprivate%3Fweek%3D2026-09-28/u)
  assert.equal(page.headers.get('cache-control'), 'no-store')
  assert.equal(page.headers.get('x-frame-options'), 'DENY')
  assert.equal(page.headers.get('x-content-type-options'), 'nosniff')
  assert.equal(page.headers.get('referrer-policy'), 'no-referrer')
  assert.match(page.headers.get('content-security-policy')!, /frame-ancestors 'none'/u)

  const api = await handler(new Request('https://planner.test/api/me'))
  assert.equal(api.status, 401)
  assert.deepEqual(await api.json(), { error: 'Authentication required' })
  assert.equal(api.headers.get('cache-control'), 'no-store')

  const hostRejected = await handler(new Request('https://planner.test/healthz', { headers: { host: 'evil.test' } }))
  assert.equal(hostRejected.status, 400)
  assert.equal(hostRejected.headers.get('x-frame-options'), 'DENY')

  const health = await handler(new Request('https://planner.test/healthz'))
  assert.equal(health.status, 200)
  assert.deepEqual(await health.json(), { status: 'ok' })
  assert.equal(health.headers.get('cache-control'), null)
  assert.deepEqual(seen, ['/healthz'], 'private requests must not reach application handlers')
})

test('response headers apply to app pages and API responses while preserving existing headers', () => {
  const request = new Request('https://planner.test/api/data')
  const response = withSecurityHeaders(new Response('ok', { headers: { 'set-cookie': 'x=y; HttpOnly' } }), request)
  assert.equal(response.headers.get('cache-control'), 'no-store')
  assert.equal(response.headers.get('set-cookie'), 'x=y; HttpOnly')
  assert.equal(response.headers.get('permissions-policy'), 'camera=(), microphone=(), geolocation=()')

  const pageResponse = withSecurityHeaders(new Response('page'), new Request('https://planner.test/login'))
  assert.equal(pageResponse.headers.get('cache-control'), 'no-store')
})
