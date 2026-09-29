import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import type { AuthConfig } from './config.ts'

export const SESSION_TTL_SECONDS = 60 * 60 * 24 * 30
export const SESSION_COOKIE_NAME = 'meals_session'
export const HOST_SESSION_COOKIE_NAME = `__Host-${SESSION_COOKIE_NAME}`

export interface AuthSession {
  readonly authenticated: true
  readonly csrfToken: string
  readonly issuedAt: number
  readonly expiresAt: number
}

function encode(value: Buffer | string): string {
  return Buffer.from(value).toString('base64url')
}

function decode(value: string): Buffer | null {
  if (!/^[A-Za-z0-9_-]+$/u.test(value)) return null
  try {
    return Buffer.from(value, 'base64url')
  } catch {
    return null
  }
}

function sessionMac(encodedPayload: string, secret: string): Buffer {
  return createHmac('sha256', secret).update(encodedPayload).digest()
}

export function sessionCookieName(config: AuthConfig): string {
  return config.cookieSecure ? HOST_SESSION_COOKIE_NAME : SESSION_COOKIE_NAME
}

export function createSession(
  config: AuthConfig,
  nowMilliseconds = Date.now(),
): { readonly session: AuthSession; readonly cookie: string } {
  const issuedAt = Math.floor(nowMilliseconds / 1000)
  const session: AuthSession = {
    authenticated: true,
    csrfToken: randomBytes(32).toString('base64url'),
    issuedAt,
    expiresAt: issuedAt + SESSION_TTL_SECONDS,
  }
  const encodedPayload = encode(JSON.stringify(session))
  const signedValue = `${encodedPayload}.${sessionMac(encodedPayload, config.sessionSecret).toString('base64url')}`
  const cookie = [
    `${sessionCookieName(config)}=${signedValue}`,
    'Path=/',
    `Max-Age=${SESSION_TTL_SECONDS}`,
    'HttpOnly',
    'SameSite=Lax',
    ...(config.cookieSecure ? ['Secure'] : []),
  ].join('; ')
  return { session, cookie }
}

export function expireSessionCookie(config: AuthConfig): string {
  return [
    `${sessionCookieName(config)}=`,
    'Path=/',
    'Max-Age=0',
    'HttpOnly',
    'SameSite=Lax',
    ...(config.cookieSecure ? ['Secure'] : []),
  ].join('; ')
}

export function readSession(
  cookieHeader: string | null | undefined,
  config: AuthConfig,
  nowMilliseconds = Date.now(),
): AuthSession | null {
  if (!cookieHeader) return null
  const cookieName = sessionCookieName(config)
  const cookiePart = cookieHeader.split(';').map((part) => part.trim()).find((part) => part.startsWith(`${cookieName}=`))
  const signedValue = cookiePart?.slice(cookieName.length + 1)
  if (!signedValue || signedValue.length > 4096) return null

  const separator = signedValue.indexOf('.')
  if (separator <= 0 || signedValue.indexOf('.', separator + 1) !== -1) return null
  const encodedPayload = signedValue.slice(0, separator)
  const encodedMac = signedValue.slice(separator + 1)
  const hasValidMacEncoding = /^[A-Za-z0-9_-]+$/u.test(encodedMac)
  const suppliedMac = Buffer.from(encodedMac, 'base64url')

  const expectedMac = sessionMac(encodedPayload, config.sessionSecret)
  const normalizedMac = Buffer.alloc(expectedMac.length)
  suppliedMac.copy(normalizedMac, 0, 0, expectedMac.length)
  const macMatches = timingSafeEqual(expectedMac, normalizedMac)
  if (!hasValidMacEncoding || suppliedMac.length !== expectedMac.length || !macMatches) return null

  const payload = decode(encodedPayload)
  if (!payload) return null
  let value: unknown
  try {
    value = JSON.parse(payload.toString('utf8'))
  } catch {
    return null
  }
  if (!value || typeof value !== 'object') return null

  const session = value as Partial<AuthSession>
  if (
    session.authenticated !== true ||
    typeof session.csrfToken !== 'string' ||
    !/^[A-Za-z0-9_-]{40,}$/u.test(session.csrfToken) ||
    !Number.isSafeInteger(session.issuedAt) ||
    !Number.isSafeInteger(session.expiresAt) ||
    (session.expiresAt as number) - (session.issuedAt as number) !== SESSION_TTL_SECONDS ||
    Math.floor(nowMilliseconds / 1000) >= (session.expiresAt as number)
  ) {
    return null
  }

  return session as AuthSession
}

export function readSessionFromRequest(
  request: Request,
  config: AuthConfig,
  nowMilliseconds = Date.now(),
): AuthSession | null {
  return readSession(request.headers.get('cookie'), config, nowMilliseconds)
}
