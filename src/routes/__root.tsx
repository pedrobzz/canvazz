import { HeadContent, Scripts, createRootRoute } from '@tanstack/react-router'

import appCss from '../styles.css?url'

export const Route = createRootRoute({
  head: () => ({
    meta: [
      {
        charSet: 'utf-8',
      },
      {
        name: 'viewport',
        content: 'width=device-width, initial-scale=1',
      },
      {
        title: 'Canvazz — AI-first design editor',
      },
      {
        // Belt-and-braces on top of the model sanitizer: no plugins, no
        // frames, no base hijack, no remote form posts. Script policy stays
        // host-level (vite dev needs inline/eval); production deployments
        // should additionally send strict script-src + Trusted Types headers.
        httpEquiv: 'Content-Security-Policy',
        content: "object-src 'none'; frame-src 'none'; base-uri 'self'; form-action 'self'",
      },
    ],
    links: [
      {
        rel: 'stylesheet',
        href: appCss,
      },
    ],
  }),
  shellComponent: RootDocument,
})

function RootDocument({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <head>
        <HeadContent />
      </head>
      <body>
        {children}
        <Scripts />
      </body>
    </html>
  )
}
