import { isIP } from 'node:net'

export const LOGIN_MAX_ATTEMPTS = 5
export const LOGIN_WINDOW_SECONDS = 5 * 60

export type LoginResult = 'authenticated' | 'invalid' | 'rate_limited'

export class LoginRateLimiter {
  private readonly attempts = new Map<string, number[]>()

  authenticate(
    clientIp: string,
    nowSeconds: number,
    passwordIsValid: () => boolean,
  ): LoginResult {
    const ip = clientIp || 'unknown'
    const bucket = this.attempts.get(ip) ?? []
    while (bucket.length && bucket[0]! < nowSeconds - LOGIN_WINDOW_SECONDS) bucket.shift()

    if (bucket.length >= LOGIN_MAX_ATTEMPTS) {
      this.attempts.set(ip, bucket)
      return 'rate_limited'
    }

    if (!passwordIsValid()) {
      bucket.push(nowSeconds)
      this.attempts.set(ip, bucket)
      this.pruneInactiveBuckets(nowSeconds)
      return 'invalid'
    }

    this.attempts.delete(ip)
    return 'authenticated'
  }

  private pruneInactiveBuckets(nowSeconds: number): void {
    if (this.attempts.size <= 1024) return
    for (const [ip, bucket] of this.attempts) {
      while (bucket.length && bucket[0]! < nowSeconds - LOGIN_WINDOW_SECONDS) bucket.shift()
      if (!bucket.length) this.attempts.delete(ip)
    }
    while (this.attempts.size > 1024) this.attempts.delete(this.attempts.keys().next().value!)
  }
}

export function clientIpFromRequest(request: Request): string {
  const candidates = [
    request.headers.get('cf-connecting-ip'),
    request.headers.get('x-forwarded-for')?.split(',')[0],
    request.headers.get('x-real-ip'),
  ]
  for (const candidate of candidates) {
    const address = candidate?.trim()
    const version = address ? isIP(address) : 0
    if (address && version === 4) return address
    if (address && version === 6) {
      const canonical = new URL(`http://[${address}]/`).hostname
      return canonical.slice(1, -1)
    }
  }
  return 'unknown'
}
