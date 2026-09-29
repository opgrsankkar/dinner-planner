const REDIRECT_BASE = 'https://dinner-planner.invalid'
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/u

export function safeNext(value: string | null | undefined): string {
  if (!value || !value.startsWith('/') || value.includes('\\') || CONTROL_CHARACTERS.test(value)) return '/'

  let decoded = value
  for (let count = 0; count < 10; count += 1) {
    let next: string
    try {
      next = decodeURIComponent(decoded)
    } catch {
      return '/'
    }
    if (next.includes('\\') || CONTROL_CHARACTERS.test(next) || next.startsWith('//')) return '/'
    if (next === decoded) break
    decoded = next
    if (count === 9) return '/'
  }

  if (!decoded.startsWith('/') || decoded.startsWith('//')) return '/'
  try {
    const parsed = new URL(value, REDIRECT_BASE)
    if (parsed.origin !== REDIRECT_BASE || !parsed.pathname.startsWith('/')) return '/'
  } catch {
    return '/'
  }
  return value
}
