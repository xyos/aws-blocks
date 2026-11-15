# Calling the Blocks API from the frontend

> Read when: frontend or SSR code called the app's own HTTP API (`fetch`, axios, a generated client) and must now call `ApiNamespace` methods.

## The import

```ts
import { api, orders } from 'aws-blocks';        // one client per exported ApiNamespace
import type { Order } from 'aws-blocks';         // types exported by aws-blocks/index.ts
const order = await orders.get('42');            // typed from the backend method
```

- `aws-blocks` is the workspace package in `aws-blocks/`. Its `package.json` `exports` map sends the conditions `browser`, `react-server` and `import` to the generated `./client.js`, and `types` to `./index.ts`. So the type checker reads the backend source and the bundle gets the client.
- `client.js` exports one proxy per namespace, under the export name used in `aws-blocks/index.ts`, plus `generateClient(options)`. There is no aggregate object: `api.orders.get()` does not exist.
- Import by package name. A relative import of `../aws-blocks/index.ts` gives the server module, which behaves differently and pulls server code into the bundle.
- Return types come from the backend. Delete frontend response interfaces that duplicate them.
- Keep `aws-blocks/package.json` as scaffolded (`"type": "module"` and `exports`).

## Generating `aws-blocks/client.js`

- Writers: `cdk-blocks dev` at startup and on each restart; `cdk-blocks sandbox` and `cdk-blocks deploy` before synth; `npx --no -- cdk-blocks generate client` on demand.
- The scaffold adds `aws-blocks/client.js` to `.gitignore`. Keep it ignored: the file differs between local dev (mock middleware) and AWS (generated with `--conditions=aws-runtime`), so a committed copy is wrong for one of them. Do not edit it.
- A fresh checkout has no `client.js`, and a standalone build (CI, `npm run build`) cannot resolve `aws-blocks` until it exists. The templates solve this with a script; the in-place scaffold does not add it, so add it:

```json
"scripts": { "prebuild": "cdk-blocks generate client" }
```

- If the app already has a `prebuild`, chain the command. Some package managers do not run `pre` scripts (`cdk-blocks blockify-app guide package-managers`); then put it at the start of `build`.
- After you add or rename a namespace, the client is stale until one of the writers runs. `cdk-blocks dev` restarts on a backend change.
- `generate client` writes the AWS variant, and `cdk-blocks dev` writes the local one. After a build that ran `prebuild`, restart `cdk-blocks dev` before you test locally, so that it writes its own client again.

## Dependencies and workspaces

- The scaffold adds `"aws-blocks"` to the root `workspaces`. With npm the install links it into the root `node_modules`, and imports from the root package resolve.
- A package other than the root that imports `aws-blocks` (a nested `web/` or `apps/frontend/`) declares it in its own `dependencies` (`"aws-blocks": "*"` for npm; `workspace:*` for pnpm and yarn). pnpm also needs `aws-blocks` in `pnpm-workspace.yaml` (`cdk-blocks blockify-app guide package-managers`).
- When the app is itself a member of a larger npm workspace, npm ignores the app's own `workspaces`. Add `<app path>/aws-blocks` to the `workspaces` of the outer root; the scaffold prints this.
- Symptom of missing wiring: `Cannot find module 'aws-blocks'` at type check or build. Fix the dependency and workspace entries; an alias hides the problem.

## Rewriting call sites

- Find how the frontend reaches the server: `fetch`/axios calls, a wrapper (`src/lib/api.ts`, a query client that adds headers), or a generated client (orval, openapi hooks such as `useGetLinks`, sometimes its own package). With a generated client, a search for `fetch('/api` finds nothing while every screen still calls the old API.
- `fetch('/api/orders/' + id).then((r) => r.json())` becomes `orders.get(id)`. Arguments are positional, in the order of the backend method.
- The method returns the parsed result. Delete the `.json()` call, `res.ok` and status checks, `Content-Type` and auth headers, `JSON.stringify` and URL building around it. The client sends cookies itself (`credentials: 'include'`).
- TanStack Query: `useQuery({ queryKey: ['orders', id], queryFn: () => orders.get(id) })`. Replace generated key helpers with plain arrays and invalidate with the same arrays.
- A call with no backend method (a debug endpoint, a dropped route): delete the call and its dead code.
- Remove the old client: wrapper files, a generated-client package from `dependencies` and from `tsconfig` `references`, and its codegen script.
- Calls to third-party services stay as they are. Calls to a kept `RawRoute` or framework route stay plain `fetch` with a relative URL.

## Errors

```ts
import { ApiError, isBlocksError } from '@aws-blocks/blocks/client';

try { await orders.get(id); } catch (e) {
  if (e instanceof ApiError && e.status === 404) showNotFound();
  else if (isBlocksError(e, 'OrderNotFound')) showNotFound();   // matches e.name
  else throw e;
}
```

- A failed call rejects with `ApiError`: `status` (what the backend threw; 500 for an unexpected error), `name` (`'ApiError'` when the backend set none), `message`, `retriable`.
- The HTTP response of a failed call is 200, so code that inspects `response.status` sees nothing. Port every status branch to `e.status`.
- The backend must throw `new ApiError(message, status)` for each status the frontend branches on; other throws arrive as 500 `Internal error`.
- A response that is not JSON-RPC (a gateway `429`, an HTML error page) also rejects with `ApiError`: `status` is the HTTP status (502 when that was 2xx) and `message` is `HTTP <status>` or the body's `message`.
- Auth state errors are returned, not thrown: `cdk-blocks blockify-app guide auth`.

## Browser-safe entry points

- In browser code import helpers from `@aws-blocks/blocks/client` (`ApiError`, `isBlocksError`, `hasAuthError`, `ApiNamespaceClient`) and `@aws-blocks/blocks/ui`. The root `@aws-blocks/blocks` resolves to an empty module under the `browser` condition; `ApiNamespace`, `Secret` and the other blocks exist only in `aws-blocks/`.
- `@aws-blocks/blocks/server` (`withAuth`) is for SSR code.

## Bundler and TypeScript

- Vite: the templates set `resolve: { conditions: ['browser'] }` in `vite.config.ts`. If the app sets `resolve.conditions`, keep `browser` in the list: without `browser` or `import`, the `exports` map falls back to `./index.ts`, the server module.
- Leave `aws-blocks` and `@aws-blocks/*` out of `resolve.alias` and `build.rollupOptions.external`. The client must be bundled into the frontend, and an alias to `index.ts` ships server code.
- Remove the dev proxy to the old API (`server.proxy['/api']`, Next.js `rewrites` to a local server). `cdk-blocks dev` serves the frontend and `/aws-blocks/api` from one port and starts Vite itself with `--port <frontendPort> --strictPort`.
- Vite `base` must be absolute (`'/'`, or the Hosting `basePath`). With `'./'`, a deep link such as `/orders/42` loads assets from `/orders/assets/...` and the page stays blank, while the root page works.
- A config guard that throws when `PORT` or a base-path variable is unset fails the build inside the deploy. Give it a literal default.
- TypeScript: `moduleResolution` must be `bundler`, `node16` or `nodenext` so that the `exports` map is read (the templates use `bundler`).
- The frontend type check now covers `aws-blocks/index.ts`. Next.js: the scaffold leaves the app's `tsconfig.json` in charge; exclude `aws-blocks/index.cdk.ts` as the template does. Other projects: the scaffold writes `aws-blocks/tsconfig.json` (Node types); add `"references": [{ "path": "./aws-blocks" }]` to the frontend tsconfig and type check with `tsc -b --force` when `tsc` reports `TS2591: Cannot find name 'process'` in `aws-blocks/`.

## How the client finds the API URL

The URL is resolved on the first call, in this order: `BLOCKS_API_URL`, `BLOCKS_CONFIG` (JSON with `apiUrl`), the file `.blocks-sandbox/config.json` in the working directory (Node.js 22.3 or later), then in the browser `fetch('/.blocks-sandbox/config.json')`.

| Environment | Who provides it |
|---|---|
| `cdk-blocks dev` | The dev server writes `.blocks-sandbox/config.json` and serves it: `{"apiUrl":"http://localhost:3000/aws-blocks/api","environment":"local"}` |
| `cdk-blocks sandbox` | The CLI sets `BLOCKS_API_URL` for the local server, which proxies `/aws-blocks/api` to the deployed sandbox; the browser still calls localhost |
| Deployed, browser | `Hosting` uploads `config.json` and serves `/.blocks-sandbox/*` as static files |
| Deployed, SSR | `Hosting` sets `BLOCKS_API_URL` (and `BLOCKS_CONFIG` when `backendConfig` is set) on each SSR function |

- Do not set `BLOCKS_API_URL` yourself in code, scripts or `.env*` files. In `.env.local` it makes `cdk-blocks dev` skip the local mocks and proxy to that URL.
- Failure text: `Blocks API URL not configured` (nothing found) or `Blocks API URL is not configured (source: ...)` (a bad value). `{"_placeholder":true}` in the build output's `.blocks-sandbox/config.json` is expected; the deploy replaces it.
- During the build that runs inside a deploy, `BLOCKS_API_URL` is an unresolved CDK token. A page that calls the API while it is prerendered fails the build with `Blocks API URL contains unresolved CDK tokens`. A plain local `next build` does not show this. Add `export const dynamic = 'force-dynamic';` to each page or layout that calls the API on the server.

## Server code of the frontend framework

- Next.js server components, route handlers and server actions, Astro pages and endpoints, Nuxt server routes and SvelteKit `load` functions use the same `import { api } from 'aws-blocks'`.
- The browser's cookies are not attached to server-side calls. For a method that reads the caller's cookie: `await withAuth(() => orders.list())`, from `@aws-blocks/blocks/server`. It finds the cookies of Next.js by itself; in other frameworks pass the request's cookie header as the second argument.
- `withAuth` throws an `ApiError` with status 401 when it has no cookie to forward, before it calls the method, and a request from a first-time visitor has none: `headers.get('cookie')` is `null`. So call it only with a cookie, and call the method plainly without one:

  ```ts
  const cookie = Astro.request.headers.get('cookie');
  const cart = cookie ? await withAuth(() => api.getCart(), cookie) : await api.getCart();
  ```

  This matters most in a part that every page renders, such as a header with a cart count or the user's name: without the guard every page fails for a visitor who has no cookie yet. A framework that streams its HTML has already sent status 200 by then, and the page stops in the middle.
- Next.js edge-runtime routes get no environment variables on AWS, so the client cannot find the API there. Call the API from Node-runtime code.
- More for Next.js: `cdk-blocks blockify-app guide nextjs`.

## Frontend on another origin

- With `api: blocksStack` on `Hosting`, the frontend and `/aws-blocks/api` share one origin and need no CORS setup. Local dev allows `localhost` and `127.0.0.1` origins.
- A frontend that stays on another host needs its origin in `defaults.allowedOrigins` of `BlocksStack.create` in `aws-blocks/index.cdk.ts` (spread the preset first: `{ ...BlocksPresets.production, allowedOrigins: ['https://app.example.com'] }`). An origin outside the list is rejected on AWS and passes locally.
- That frontend has no `/.blocks-sandbox/config.json`. Build its client with the deployed URL: `generateClient({ url: '<ApiUrl stack output>' })` from `aws-blocks`. Record the URL step in MIGRATION.md under After deploy.
- Session cookies across different registrable domains need the `Auth` option `session: { crossDomain: true }` (`cdk-blocks blockify-app guide auth`).
- Details: `node_modules/@aws-blocks/blocks/docs/core/README.md`, sections "Runtime config" and "CORS Configuration".
