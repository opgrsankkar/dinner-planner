import { createHash, timingSafeEqual } from 'node:crypto'

function passwordDigest(password: string): Buffer {
  return createHash('sha256').update(password, 'utf8').digest()
}

export function passwordMatches(expected: string, supplied: string): boolean {
  return timingSafeEqual(passwordDigest(expected), passwordDigest(supplied))
}
