import { createFileRoute } from '@tanstack/react-router'
import { loadAuthConfig } from '../security/config.ts'
import { handleLoginRequest } from '../security/auth-handlers.ts'

type LoginSearch = {
  readonly next?: string
  readonly error?: 'invalid' | 'rate_limited'
}

export const Route = createFileRoute('/login')({
  validateSearch: (search: Record<string, unknown>): LoginSearch => {
    const error = search.error === 'invalid' || search.error === 'rate_limited' ? search.error : undefined
    return {
      ...(typeof search.next === 'string' ? { next: search.next } : {}),
      ...(error ? { error } : {}),
    }
  },
  server: {
    handlers: {
      POST: ({ request }) => handleLoginRequest(request, loadAuthConfig()),
    },
  },
  component: LoginPage,
})

function LoginPage() {
  const { next, error } = Route.useSearch()
  const errorMessage = error === 'rate_limited'
    ? 'Too many attempts. Try again shortly.'
    : error === 'invalid'
      ? 'Incorrect password.'
      : null

  return (
    <main>
      <h1>Sign in to Dinner Planner</h1>
      <form action="/login" method="post">
        <label htmlFor="password">Password</label>
        <input
          autoComplete="current-password"
          id="password"
          name="password"
          required
          type="password"
        />
        <input name="next" type="hidden" value={next ?? '/'} />
        {errorMessage ? <p id="login-error" role="alert">{errorMessage}</p> : null}
        <button type="submit">Sign in</button>
      </form>
    </main>
  )
}
