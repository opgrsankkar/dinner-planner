const SECURITY_HEADERS: Readonly<Record<string, string>> = {
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'no-referrer',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
  'Content-Security-Policy': [
    "default-src 'self'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
    "img-src 'self' data:",
    "style-src 'self'",
    "script-src 'self'",
    "connect-src 'self'",
    "manifest-src 'self'",
    "worker-src 'self'",
  ].join('; '),
}

export function isApiPath(pathname: string): boolean {
  return pathname === '/api' || pathname.startsWith('/api/') || pathname === '/_serverFn' || pathname.startsWith('/_serverFn/')
}

export function isStaticPath(pathname: string): boolean {
  return pathname === '/favicon.ico' || [
    '/assets/',
    '/_build/',
    '/@vite/',
    '/@id/',
    '/@fs/',
    '/src/',
    '/node_modules/',
  ].some((prefix) => pathname.startsWith(prefix))
}

export function withSecurityHeaders(response: Response, request: Request): Response {
  const headers = new Headers(response.headers)
  for (const [name, value] of Object.entries(SECURITY_HEADERS)) headers.set(name, value)

  const pathname = new URL(request.url).pathname
  if (isApiPath(pathname) || (!isStaticPath(pathname) && pathname !== '/healthz')) {
    headers.set('Cache-Control', 'no-store')
  }
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  })
}
