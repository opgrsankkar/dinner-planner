import { createFileRoute } from '@tanstack/react-router'
import { createServerFn } from '@tanstack/react-start'
import { getRequest } from '@tanstack/react-start/server'
import { loadAuthConfig } from '../security/config.ts'
import { readSessionFromRequest } from '../security/session.ts'

const getSessionCsrf = createServerFn({ method: 'GET' }).handler(() => {
  const request = getRequest()
  const config = loadAuthConfig()
  return readSessionFromRequest(request, config)?.csrfToken ?? null
})

export const Route = createFileRoute('/')({
  loader: () => getSessionCsrf(),
  component: IndexPage,
})

function IndexPage() {
  const csrfToken = Route.useLoaderData()
  return (
    <main>
      <h1>Dinner Planner</h1>
      <p>You are signed in.</p>
      {csrfToken ? (
        <form action="/logout" method="post">
          <input name="csrf" type="hidden" value={csrfToken} />
          <button type="submit">Sign out</button>
        </form>
      ) : null}
    </main>
  )
}
