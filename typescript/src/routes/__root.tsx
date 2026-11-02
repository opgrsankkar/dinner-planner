import { useEffect } from "react";
import {
  createRootRoute,
  HeadContent,
  Outlet,
  Scripts,
} from "@tanstack/react-router";
declare const __CSS_VERSION__: string; // set from app.css content in vite.config.ts
export const Route = createRootRoute({
  head: () => ({
    meta: [
      { charSet: "utf-8" },
      { name: "viewport", content: "width=device-width, initial-scale=1" },
      { title: "Meal Planner" },
      { name: "mobile-web-app-capable", content: "yes" },
      { name: "apple-mobile-web-app-capable", content: "yes" },
      { name: "apple-mobile-web-app-title", content: "Meals" },
    ],
    links: [
      { rel: "stylesheet", href: `/static/app.css?v=${__CSS_VERSION__}` },
      { rel: "manifest", href: "/manifest.webmanifest" },
      { rel: "icon", href: "/icons/icon.svg", type: "image/svg+xml" },
      { rel: "icon", href: "/icons/favicon-32.png", sizes: "32x32", type: "image/png" },
      { rel: "apple-touch-icon", href: "/icons/apple-touch-icon.png" },
    ],
  }),
  component: RootDocument,
});

function RootDocument() {
  useEffect(() => {
    if (import.meta.env.PROD && "serviceWorker" in navigator)
      navigator.serviceWorker.register("/service-worker.js").catch(() => {});
  }, []);
  return (
    <html lang="en">
      <head>
        <HeadContent />
        {/* Page colours of the light and dark themes; the planner retargets both
            when Settings overrides the system theme. Rendered here because
            head() keeps only one meta per name. */}
        <meta name="theme-color" content="#edbb97" media="(prefers-color-scheme: light)" />
        <meta name="theme-color" content="#352b32" media="(prefers-color-scheme: dark)" />
      </head>
      <body>
        <Outlet />
        <Scripts />
      </body>
    </html>
  );
}
