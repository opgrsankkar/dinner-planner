import { isIP } from 'node:net'
import type { AuthConfig } from './config.ts'

interface NormalizedHost {
  readonly hostname: string
  readonly port: string
}

function normalizeHost(value: string): NormalizedHost | null {
  if (!value || /[\s\\/@?#\u0000-\u001f\u007f]/u.test(value)) return null
  try {
    const parsed = new URL(`http://${value}`)
    if (!parsed.hostname || parsed.username || parsed.password || parsed.pathname !== '/' || parsed.search || parsed.hash) {
      return null
    }
    const hostname = parsed.hostname.toLowerCase()
    const withoutRootDot = hostname.replace(/\.$/u, '')
    if (hostname.startsWith('[') && hostname.endsWith(']')) {
      if (isIP(hostname.slice(1, -1)) !== 6) return null
    } else if (isIP(withoutRootDot) === 0) {
      if (/^\d+(?:\.\d+){0,3}$/u.test(withoutRootDot)) return null
      const labels = withoutRootDot.split('.')
      if (!labels.every((label) => label.length > 0 && label.length <= 63 && /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/iu.test(label))) return null
    }
    return { hostname: withoutRootDot, port: parsed.port }
  } catch {
    return null
  }
}

function matchesAllowedHost(host: NormalizedHost, pattern: string): boolean {
  if (pattern === '*') return true
  const wildcard = pattern.startsWith('*.')
  const normalizedPattern = normalizeHost(wildcard ? pattern.slice(2) : pattern)
  if (!normalizedPattern || host.port !== normalizedPattern.port) return false
  if (!wildcard) return host.hostname === normalizedPattern.hostname
  return host.hostname.endsWith(`.${normalizedPattern.hostname}`)
}

export function isAllowedHost(request: Request, config: AuthConfig): boolean {
  const rawHost = request.headers.get('host') ?? new URL(request.url).host
  const host = normalizeHost(rawHost)
  return host !== null && config.allowedHosts.some((pattern) => matchesAllowedHost(host, pattern))
}
