export const DEFAULT_ALLOWED_HOSTS = [
  'meals.happydaysblr.ddns.net',
  'localhost',
  '127.0.0.1',
  'testserver',
] as const

export interface AuthConfig {
  readonly appPassword: string
  readonly sessionSecret: string
  readonly allowedHosts: readonly string[]
  readonly cookieSecure: boolean
}

function validateAllowedHost(pattern: string): void {
  if (pattern === '*') return

  const host = pattern.startsWith('*.') ? pattern.slice(2) : pattern
  if (!host || host.includes('*') || /[\s\\/@?#\u0000-\u001f\u007f]/u.test(host)) {
    throw new Error(`Invalid ALLOWED_HOSTS entry: ${pattern}`)
  }

  try {
    const parsed = new URL(`http://${host}`)
    const hostname = parsed.hostname.toLowerCase()
    const bareHostname = hostname.startsWith('[') && hostname.endsWith(']')
      ? hostname.slice(1, -1)
      : hostname.replace(/\.$/u, '')
    const isIpv6 = bareHostname.includes(':')
    const isIpv4 = /^\d+(?:\.\d+){0,3}$/u.test(bareHostname)
    const dnsLabels = bareHostname.split('.')
    const validDnsName = dnsLabels.length > 0 && dnsLabels.every((label) =>
      label.length > 0 && label.length <= 63 && /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/iu.test(label),
    )
    if (
      !hostname ||
      parsed.username ||
      parsed.password ||
      parsed.pathname !== '/' ||
      parsed.search ||
      parsed.hash ||
      (isIpv6 && !hostname.startsWith('[')) ||
      (isIpv6 && !/^\[[0-9a-f:.]+\]$/iu.test(hostname)) ||
      (isIpv4 && !/^\d{1,3}(?:\.\d{1,3}){3}$/u.test(bareHostname)) ||
      (!isIpv6 && !isIpv4 && !validDnsName)
    ) {
      throw new Error()
    }
  } catch {
    throw new Error(`Invalid ALLOWED_HOSTS entry: ${pattern}`)
  }
}

export function loadAuthConfig(env: NodeJS.ProcessEnv = process.env): AuthConfig {
  const appPassword = env.APP_PASSWORD ?? ''
  const sessionSecret = env.SESSION_SECRET ?? ''
  if (!appPassword) throw new Error('APP_PASSWORD must be set')
  if ([...sessionSecret].length < 32) {
    throw new Error('SESSION_SECRET must contain at least 32 characters')
  }

  const allowedHostsValue = env.ALLOWED_HOSTS ?? DEFAULT_ALLOWED_HOSTS.join(',')
  const allowedHosts = allowedHostsValue.split(',').map((host) => host.trim())
  if (allowedHosts.length === 0 || allowedHosts.some((host) => !host)) {
    throw new Error('ALLOWED_HOSTS must contain at least one host')
  }
  for (const host of allowedHosts) validateAllowedHost(host)

  const cookieSecureValue = env.COOKIE_SECURE
  const cookieSecure = cookieSecureValue === undefined
    ? true
    : ['1', 'true', 'yes', 'on'].includes(cookieSecureValue.toLowerCase())

  return {
    appPassword,
    sessionSecret,
    allowedHosts,
    cookieSecure,
  }
}
