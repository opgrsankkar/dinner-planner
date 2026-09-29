import { createStartHandler, defaultStreamHandler } from '@tanstack/react-start/server'
import { createServerEntry } from '@tanstack/react-start/server-entry'
import { loadAuthConfig } from './security/config.ts'
import { createSecurityHandler } from './security/server-handler.ts'

const authConfig = loadAuthConfig()
const startFetch = createStartHandler(defaultStreamHandler)
const fetch = createSecurityHandler(startFetch, { getConfig: () => authConfig })

export default createServerEntry({ fetch })
