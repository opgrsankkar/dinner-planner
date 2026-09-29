import type { AuthConfig } from './config.ts'
import { loadAuthConfig } from './config.ts'
import { isSameOriginRequest } from './csrf.ts'
import { isAllowedHost } from './host.ts'
import { safeNext } from './redirect.ts'
import { isApiPath, isStaticPath, withSecurityHeaders } from './response.ts'
import { readSessionFromRequest } from './session.ts'

export type FetchHandler = (request: Request) => Response | Promise<Response>

export interface SecurityHandlerOptions {
  readonly getConfig?: () => AuthConfig
  readonly now?: () => number
}

function unauthorized(request: Request): Response {
  if (isApiPath(new URL(request.url).pathname)) {
    return Response.json({ error: 'Authentication required' }, { status: 401 })
  }

  const url = new URL(request.url)
  const target = safeNext(`${url.pathname}${url.search}`)
  return new Response(null, {
    status: 303,
    headers: { location: `/login?${new URLSearchParams({ next: target }).toString()}` },
  })
}

function publicPath(pathname: string): boolean {
  return pathname === '/healthz' || pathname === '/login' || isStaticPath(pathname)
}

function failure(status: number, body: string): Response {
  return new Response(body, { status, headers: { 'content-type': 'text/plain; charset=utf-8' } })
}

export function createSecurityHandler(
  next: FetchHandler,
  options: SecurityHandlerOptions = {},
): FetchHandler {
  return async (request) => {
    let config: AuthConfig
    try {
      config = options.getConfig?.() ?? loadAuthConfig()
    } catch {
      return withSecurityHeaders(failure(500, 'Server configuration error'), request)
    }

    const pathname = new URL(request.url).pathname
    if (!isAllowedHost(request, config)) {
      return withSecurityHeaders(failure(400, 'Invalid host'), request)
    }

    if (!['GET', 'HEAD', 'OPTIONS'].includes(request.method.toUpperCase()) && !isSameOriginRequest(request)) {
      return withSecurityHeaders(failure(403, 'Cross-origin request rejected'), request)
    }

    if (!publicPath(pathname) && !readSessionFromRequest(request, config, options.now?.() ?? Date.now())) {
      return withSecurityHeaders(unauthorized(request), request)
    }

    try {
      const response = await next(request)
      return withSecurityHeaders(response, request)
    } catch {
      return withSecurityHeaders(failure(500, 'Internal server error'), request)
    }
  }
}
