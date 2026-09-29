import { createHash, timingSafeEqual } from 'node:crypto'
import type { AuthSession } from './session.ts'

function fixedTimeStringEqual(expected: string, supplied: string): boolean {
  const expectedDigest = createHash('sha256').update(expected).digest()
  const suppliedDigest = createHash('sha256').update(supplied).digest()
  return timingSafeEqual(expectedDigest, suppliedDigest)
}

export function isSameOriginRequest(request: Request): boolean {
  const expectedOrigin = new URL(request.url).origin
  const suppliedOrigin = request.headers.get('origin')
  const suppliedReferer = request.headers.get('referer')
  const candidate = suppliedOrigin ?? suppliedReferer
  if (!candidate || candidate === 'null') return false

  try {
    const parsed = new URL(candidate)
    if (parsed.origin !== expectedOrigin) return false
    if (suppliedOrigin !== null && (parsed.pathname !== '/' || parsed.search || parsed.hash)) return false
    return true
  } catch {
    return false
  }
}

export function csrfTokenMatches(expected: string | undefined, supplied: string | null | undefined): boolean {
  if (expected === undefined || supplied === undefined || supplied === null) return false
  const matches = fixedTimeStringEqual(expected, supplied)
  return expected.length > 0 && supplied.length > 0 && matches
}

export function verifyCsrfRequest(
  request: Request,
  session: AuthSession,
  suppliedToken?: string | null,
): boolean {
  return isSameOriginRequest(request) && csrfTokenMatches(
    session.csrfToken,
    suppliedToken ?? request.headers.get('x-csrf-token'),
  )
}
