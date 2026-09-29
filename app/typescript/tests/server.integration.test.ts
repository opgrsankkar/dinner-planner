import assert from 'node:assert/strict'
import test from 'node:test'

process.env.APP_PASSWORD = 'integration-test-password'
process.env.SESSION_SECRET = 'integration-test-session-secret-0123456789abcdef'
process.env.ALLOWED_HOSTS = 'planner.test'
process.env.COOKIE_SECURE = 'false'

const entry = await import('../dist/server/server.js') as {
  readonly default: { readonly fetch: (request: Request) => Response | Promise<Response> }
}
const appFetch = entry.default.fetch
const origin = 'http://planner.test'

test('built TanStack server renders login, gates pages/APIs, issues sessions, and CSRF-protects logout', async () => {
  const health = await appFetch(new Request(`${origin}/healthz`))
  assert.equal(health.status, 200)
  assert.deepEqual(await health.json(), { status: 'ok' })
  assert.equal(health.headers.get('x-frame-options'), 'DENY')

  const loginPage = await appFetch(new Request(`${origin}/login`))
  assert.equal(loginPage.status, 200)
  const loginHtml = await loginPage.text()
  assert.match(loginHtml, /<h1[^>]*>Sign in to Dinner Planner<\/h1>/u)
  assert.match(loginHtml, /<label[^>]*for="password">Password<\/label>/u)
  assert.equal(loginPage.headers.get('cache-control'), 'no-store')

  const privatePage = await appFetch(new Request(`${origin}/?week=2026-09-28`))
  assert.equal(privatePage.status, 303)
  assert.match(privatePage.headers.get('location')!, /^\/login\?next=%2F%3Fweek%3D2026-09-28/u)

  const api = await appFetch(new Request(`${origin}/api/planner`))
  assert.equal(api.status, 401)
  assert.deepEqual(await api.json(), { error: 'Authentication required' })

  const failedLogin = await appFetch(new Request(`${origin}/login`, {
    method: 'POST',
    headers: {
      origin,
      'content-type': 'application/x-www-form-urlencoded',
      'x-forwarded-for': '192.0.2.101',
    },
    body: new URLSearchParams({ password: 'wrong-password', next: '/planner' }),
  }))
  assert.equal(failedLogin.status, 401)
  assert.match(await failedLogin.text(), /Incorrect password/u)

  const success = await appFetch(new Request(`${origin}/login`, {
    method: 'POST',
    headers: {
      origin,
      'content-type': 'application/x-www-form-urlencoded',
      'x-forwarded-for': '192.0.2.102',
    },
    body: new URLSearchParams({ password: process.env.APP_PASSWORD!, next: '/' }),
  }))
  assert.equal(success.status, 303)
  assert.equal(success.headers.get('location'), '/')
  const sessionCookie = success.headers.get('set-cookie')
  assert.ok(sessionCookie)

  const signedIn = await appFetch(new Request(`${origin}/`, {
    headers: { cookie: sessionCookie.split(';', 1)[0]! },
  }))
  assert.equal(signedIn.status, 200)
  const signedInHtml = await signedIn.text()
  assert.match(signedInHtml, /You are signed in\./u)
  const csrfToken = signedInHtml.match(/<input(?=[^>]*name="csrf")(?=[^>]*value="([A-Za-z0-9_-]+)")[^>]*>/u)?.[1]
  assert.ok(csrfToken, 'authenticated server-rendered page provides its session CSRF token')

  const rejectedLogout = await appFetch(new Request(`${origin}/logout`, {
    method: 'POST',
    headers: {
      origin,
      cookie: sessionCookie.split(';', 1)[0]!,
      'content-type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({ csrf: 'wrong-token' }),
  }))
  assert.equal(rejectedLogout.status, 403)

  const logout = await appFetch(new Request(`${origin}/logout`, {
    method: 'POST',
    headers: {
      origin,
      cookie: sessionCookie.split(';', 1)[0]!,
      'content-type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({ csrf: csrfToken }),
  }))
  assert.equal(logout.status, 303)
  assert.equal(logout.headers.get('location'), '/login')
  assert.match(logout.headers.get('set-cookie')!, /Max-Age=0/u)
})

test('built server rejects untrusted hosts and cross-origin mutations while keeping healthz public', async () => {
  const hostileHost = await appFetch(new Request(`${origin}/healthz`, { headers: { host: 'evil.test' } }))
  assert.equal(hostileHost.status, 400)

  const crossOriginLogin = await appFetch(new Request(`${origin}/login`, {
    method: 'POST',
    headers: {
      origin: 'https://attacker.test',
      'content-type': 'application/x-www-form-urlencoded',
      'x-forwarded-for': '192.0.2.103',
    },
    body: new URLSearchParams({ password: process.env.APP_PASSWORD!, next: '/' }),
  }))
  assert.equal(crossOriginLogin.status, 403)

  const health = await appFetch(new Request(`${origin}/healthz`))
  assert.equal(health.status, 200)
  assert.deepEqual(await health.json(), { status: 'ok' })
})
