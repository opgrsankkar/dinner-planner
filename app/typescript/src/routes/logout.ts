import { createFileRoute } from '@tanstack/react-router'
import { loadAuthConfig } from '../security/config.ts'
import { handleLogoutRequest } from '../security/auth-handlers.ts'

export const Route = createFileRoute('/logout')({
  server: {
    handlers: {
      POST: ({ request }) => handleLogoutRequest(request, loadAuthConfig()),
    },
  },
})
