import type { AuthConfig } from './config.ts'
import { isSameOriginRequest, verifyCsrfRequest } from './csrf.ts'
import { readUrlEncodedForm } from './form.ts'
import { safeNext } from './redirect.ts'
import { LoginRateLimiter, clientIpFromRequest } from './rate-limit.ts'
import { createSession, expireSessionCookie, readSessionFromRequest } from './session.ts'
import { passwordMatches } from './password.ts'

export interface AuthHandlerOptions {
  readonly now?: () => number
  readonly rateLimiter?: LoginRateLimiter
}

const processRateLimiter = new LoginRateLimiter()

function redirect(location: string, extraHeaders?: HeadersInit): Response {
  const headers = new Headers(extraHeaders)
  headers.set('location', location)
  return new Response(null, { status: 303, headers })
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/gu, (character) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  })[character]!)
}

function loginFailure(status: 401 | 429, next: string, message: string): Response {
  const safeTarget = escapeHtml(next)
  const safeMessage = escapeHtml(message)
  return new Response(
    `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Sign in to Dinner Planner</title></head><body><main><h1>Sign in to Dinner Planner</h1><form action="/login" method="post"><label for="password">Password</label><input autocomplete="current-password" id="password" name="password" required type="password" aria-describedby="login-error"><input name="next" type="hidden" value="${safeTarget}"><p id="login-error" role="alert">${safeMessage}</p><button type="submit">Sign in</button></form></main></body></html>`,
    { status, headers: { 'content-type': 'text/html; charset=utf-8' } },
  )
}

export async function handleLoginRequest(
  request: Request,
  config: AuthConfig,
  options: AuthHandlerOptions = {},
): Promise<Response> {
  if (!isSameOriginRequest(request)) return new Response('Forbidden', { status: 403 })
  const form = await readUrlEncodedForm(request)
  if (!form) return new Response('Invalid form submission', { status: 400 })

  const target = safeNext(form.get('next'))
  const password = form.get('password') ?? ''
  const limiter = options.rateLimiter ?? processRateLimiter
  const nowMilliseconds = options.now?.() ?? Date.now()
  const result = limiter.authenticate(
    clientIpFromRequest(request),
    Math.floor(nowMilliseconds / 1000),
    () => passwordMatches(config.appPassword, password),
  )

  if (result === 'rate_limited') return loginFailure(429, target, 'Too many attempts. Try again shortly.')
  if (result === 'invalid') return loginFailure(401, target, 'Incorrect password.')

  const { cookie } = createSession(config, nowMilliseconds)
  return redirect(target, { 'set-cookie': cookie })
}

export async function handleLogoutRequest(
  request: Request,
  config: AuthConfig,
  nowMilliseconds = Date.now(),
): Promise<Response> {
  const session = readSessionFromRequest(request, config, nowMilliseconds)
  if (!session) return Response.json({ error: 'Authentication required' }, { status: 401 })
  if (!isSameOriginRequest(request)) return new Response('Forbidden', { status: 403 })

  const form = await readUrlEncodedForm(request)
  const suppliedToken = request.headers.get('x-csrf-token') ?? form?.get('csrf')
  if (!verifyCsrfRequest(request, session, suppliedToken)) {
    return new Response('Invalid CSRF token', { status: 403 })
  }

  return redirect('/login', { 'set-cookie': expireSessionCookie(config) })
}
