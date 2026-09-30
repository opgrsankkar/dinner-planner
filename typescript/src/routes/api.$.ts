import { createFileRoute } from "@tanstack/react-router";
import { app, handle } from "../server/app";
export const Route = createFileRoute("/api/$")({
  server: {
    handlers: {
      GET: async ({ request }) => handle(request, await app()),
      POST: async ({ request }) => handle(request, await app()),
    },
  },
});
