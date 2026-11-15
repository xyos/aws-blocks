# API routes: ApiNamespace, RawRoute, or keep the framework route

> Read when: the app has HTTP endpoints (Next.js route handlers and `pages/api`, Nuxt `server/api`, SvelteKit `+server` files, Astro endpoints, an Express/Fastify/Hono server, server actions, webhooks) and you must decide where each one runs on AWS Blocks.

## Pick one target per route

| The route | Target |
|---|---|
| Is called only by the app's own frontend and exchanges JSON | `ApiNamespace` method |
| Has a caller outside the repo (webhook, OAuth callback, health check, link in an email), needs the exact request body, or needs its own status, headers, cookies or content type | `RawRoute` at the original path |
| Is a route of the frontend framework (Next.js, Nuxt, SvelteKit, Astro) that needs no Building Block, or streams, or returns binary data | Keep the framework route |

- Keep every URL that an outside caller uses, with the same method and statuses. A route that no frontend file calls can have callers outside the repo.
- WebSockets fit none of the three (`node_modules/@aws-blocks/blocks/docs/bb-realtime/README.md`).

## Keep the framework route

- This holds for every framework whose server `Hosting` runs: Next.js route handlers and `pages/api`, Nuxt `server/api` and `server/routes`, SvelteKit `+server` files and form actions, Astro endpoints. A route that only sets a cookie, redirects, or reads a file that ships with the app needs no Building Block: leave it where it is, also when another route of the same app moves.
- It runs in the SSR function that `Hosting` creates. That function receives `BLOCKS_API_URL` and the Hosting `environment` values. Building Block permissions go to the shared execution role of the Blocks computes, so a kept route cannot use a block instance.
- `import { api } from 'aws-blocks'` in a route handler resolves to the generated client. The route reaches Blocks data through `api.method()` calls; wrap them in `withAuth` when the method needs the signed-in user (`cdk-blocks blockify-app guide client-wiring`).
- Secrets it reads move to Hosting values (`cdk-blocks blockify-app guide secrets`).
- Do not declare a `RawRoute` on the same path: on AWS the request then goes to the Blocks API and the framework route is unreachable.

## ApiNamespace method

```ts
// aws-blocks/index.ts
import { ApiNamespace, ApiError } from '@aws-blocks/blocks';

export const orders = new ApiNamespace(scope, 'orders', (context) => ({
  async get(id: string) {
    const user = await auth.requireAuth(context);           // 401 when signed out
    const order = await findOrder(id, user.userId);
    if (!order) throw new ApiError('Order not found', 404, { name: 'OrderNotFound' });
    return order;                                           // plain JSON value
  },
}));
```

- The frontend calls `orders.get(id)`: `<export name>.<method>`. The second constructor argument is only a label. For `orders.create()`, export an `orders` namespace.
- Transport: `POST /aws-blocks/api/<export name>` with a JSON-RPC 2.0 body. Arguments are positional. Arguments and results are JSON: return plain objects, strings and numbers; a `Date` arrives as a string; files go through `FileBucket` (`cdk-blocks blockify-app guide file-uploads`).
- Every method is a public endpoint. A method is gated only by the check you write as its first statement (`await auth.requireAuth(context)`, see `cdk-blocks blockify-app guide auth`). Local dev applies no gate either, so a missing check passes every local test. Port each middleware-based guard explicitly.
- Errors: `throw new ApiError(message, status, { name?, retriable? })`. The response is HTTP 200 with a JSON-RPC error whose `code` is `status`; the client rejects with an `ApiError` that has the same `status`, `name` and `message`. Any other throw (a bare `Error`, a driver exception) reaches the client as status 500 with message `Internal error`; the real error is in the server log. An error thrown by a Building Block keeps its name and message; it keeps its status when it has one, and is 500 otherwise.
- `{ httpErrorStatus: true }` as the fourth argument answers a 4xx `ApiError` with that HTTP status. `Hosting` fails synth (`HttpErrorStatusErrorPagesError`) when the distribution maps 403 or 404 to an error page; leave the option off unless the user needs status-based metrics.
- Request data: `context.request.headers.get('x-forwarded-for')`. Port `req.headers[...]`, Next.js `headers()` and cookie reads to it. A value the old server read from the request (IP, user agent, an auth token) stays a server-side read; as a method argument the caller could supply any value. `context.request.params` is `{}` for methods.
- Limits: body 10 MiB, locally and on AWS (larger answers 413, name `PayloadTooLarge`). On AWS a call has about 29 seconds; the handler answers 504 at 28 seconds, and the local server sets no deadline. Longer work goes to `AsyncJob` (`cdk-blocks blockify-app guide jobs`, `cdk-blocks blockify-app guide aws-limits`).
- A Node caller resends a call once when its connection closes before the response headers arrive. Keep state-changing methods safe to repeat.

## RawRoute

```ts
import { RawRoute } from '@aws-blocks/blocks';

new RawRoute(scope, 'stripe-webhook', {
  method: 'POST',                          // GET | POST | PUT | DELETE | PATCH | HEAD | OPTIONS
  path: '/api/webhooks/stripe',            // the URL the third party already calls
  handler: async (ctx) => {
    const raw = await ctx.request.text();  // exact body, for the signature check
    const sig = ctx.request.headers.get('stripe-signature');
    // verify, then act
    ctx.response.send({ received: true });
  },
});
```

- Pass `path`. Without it the path comes from the scope ids, and a scope change moves the URL.
- Path forms: exact (`/health`); `{name}` captures one segment and is URL-decoded (`ctx.request.params.id`); a trailing `*` captures the rest as `params['*']`, not decoded, so validate it. One `*`, last segment only. A trailing slash on the request is accepted.
- Reserved: `/`, `/aws-blocks`, `/aws-blocks/api` and everything under it. Keep out of `/aws-blocks/auth/` too; the `Auth` block owns it.
- Construct routes while `aws-blocks/index.ts` loads (top level, or a module it imports). A later registration throws `Routes must be registered during initialization`. The same method and path twice throws `RawRouteErrors.DuplicateRoute`. A route is not exported.
- The method must match exactly: a `GET` route does not answer `HEAD`. The dispatcher answers every `OPTIONS` preflight itself, and rejects a request whose `Origin` is not allowed before the handler runs (`cdk-blocks blockify-app guide client-wiring`, CORS). Requests without an `Origin` header, such as webhooks, pass.
- `ctx.request`: `headers`, `text()`, `json()`, `body`, `url` (`url.searchParams` for the query), `params`, `signal`.
- `ctx.response`: `status` (default 200), `headers`, `send(body)`. A string is sent as it is; any other value is sent as JSON. Defaults: `Content-Type: application/json` and `Cache-Control: no-store, no-cache, must-revalidate, proxy-revalidate`. Set `Content-Type` for HTML, text or CSV.
- Redirect: `ctx.response.status = 302; ctx.response.headers.set('Location', to); ctx.response.send('')`. Cookies: `ctx.response.headers.append('Set-Cookie', ...)` once per cookie.
- Errors that escape the handler are sanitized: an `ApiError` gives its status with body `{"error": message}` (plus `"name"` when set); anything else gives 500 `{"error":"Internal error"}`. Headers set before the throw are kept. A path with no route answers 404 `{"error":"Not Found"}`.
- Buffered in both directions:
  - On AWS the request body is decoded as UTF-8 text. A binary or multipart upload arrives damaged. Use `FileBucket` upload handles.
  - The response is one string. A `Buffer` or a stream is JSON-serialized (`{}` for a stream). For downloads, redirect to a `FileBucket` URL. Server-sent events arrive as one block when the handler ends.
  - On AWS the gateway limits a request to 10 MB and 29 seconds. The local server reads a RawRoute body of any size and sets no deadline (`ctx.request.signal` is `undefined` locally).
- `ctx.request.url`: locally `http://localhost:3000/...`. Behind the default CloudFront door of `Hosting` it is the URL the client called. Behind another door, or for a direct call to the `execute-api` URL, the origin is the API Gateway host; build public links from the app's configured site URL in that case. `url.pathname` never contains the stage.
- Details: `node_modules/@aws-blocks/blocks/docs/core/README.md`, section "RawRoute".

## How Hosting routes RawRoutes

- A RawRoute adds no AWS resource to the backend: the shared API Gateway forwards every path to the Blocks handler.
- With `api: blocksStack` on `Hosting` and the default CloudFront door, synth adds one CloudFront behavior per route pattern, next to `/aws-blocks/api*` and `/aws-blocks/auth/*`.
- An exact path gets an exact behavior. A path with `{param}` becomes `<prefix>/*`, and a wildcard path keeps its `*`. Synth warns: `RawRoute '<path>' creates CloudFront behavior '<pattern>' which may shadow SSR/frontend routes under the same prefix`.
- Consequence on AWS only: `/api/hooks/{id}` creates `/api/hooks/*`; a route `/api/{id}` creates `/api/*` and takes every `/api/...` request away from Next.js or the SPA. Unmatched paths under it answer 404 `{"error":"Not Found"}` from the Blocks handler. Choose a prefix that the frontend does not use, and read the synth output for this warning.

## Express, Fastify, Hono servers

- One router or resource becomes one exported `ApiNamespace`; each route becomes a method. Path and query parameters and body fields become positional arguments.
- `res.json(data)` becomes `return data`. Keep the response field names that the frontend reads.
- Port what the handler does to its input before it uses it, in the same order: `trim()`, defaults, conversions such as `Number(req.params.id)`, length limits. A method receives its arguments exactly as the frontend sent them, and a check that ran on the trimmed value passes `'  '` when the trim is gone.
- `res.status(code).json({ error })` becomes `throw new ApiError(error, code)`. A frontend branch on `err.status` keeps working.
- Middleware becomes a helper that the method calls first: auth to `auth.requireAuth(context)`, validation to a schema parse that throws `ApiError(..., 400)`, rate limits to `cdk-blocks blockify-app guide aws-limits`.
- `express.static`, CORS middleware, body parsers, cookie parsers and the `listen()` call have no replacement: `Hosting` serves the frontend and the handler parses JSON.
- `multer` and other upload middleware: `cdk-blocks blockify-app guide file-uploads`.
- A route that renders a page (`res.render`, `reply.view`) at a path other than `/` becomes a `RawRoute` that sends the same HTML: `ctx.response.headers.set('Content-Type', 'text/html; charset=utf-8')`, with the template as a string in the module (`ejs.render(template, data)`), since the bundle carries no template files. A `RawRoute` cannot answer `/`; the playbook says what to do with a page the server renders there.
- A plain form post (`application/x-www-form-urlencoded`) that has to keep its URL, because something outside the app posts to it or because its page must work without JavaScript, stays a `RawRoute`: `new URLSearchParams(await ctx.request.text())` gives the fields, and the answer is the same redirect as before.
- When every route is ported, remove the old server from the `dev`, `build` and `start` scripts and from the bundler's dev proxy, then delete its directory and its unused dependencies. A server that stays in the build keeps its `process.env` reads and its port in the app.

## Server actions and server functions

- A server action that only reads or writes app data stays as the entry point. Move the data access into an `ApiNamespace` method and call it from the action: `await withAuth(() => orders.create(input))`, with `withAuth` from `@aws-blocks/blocks/server`. The action runs in the SSR function, which has no access to Building Blocks.
- `revalidatePath`, `redirect` and form handling stay in the action.

## Backend file layout

- Export only `ApiNamespace` instances from `aws-blocks/index.ts`. The generated client and the RPC dispatcher treat every other exported function or plain object as a callable namespace, so `export const helpers = { deleteAll }` becomes a public endpoint. Exported Building Block instances, names that start with `_`, and `secret()`/`config()` markers are skipped.
- For an API in several files, create the shared objects once (`scope`, `auth`, the database, buckets, secrets) in a module such as `aws-blocks/resources.ts`. Route modules import from it; `index.ts` imports the route modules and re-exports their namespaces. A route module that imports `index.ts` creates an import cycle.
- A module that only declares `RawRoute`s needs a side-effect import in `index.ts` (`import './webhooks.js'`), so that the routes register during load.
- Check with `npx --no -- cdk-blocks dev`: it loads `index.ts`, then `curl -i http://localhost:3000<path>` for each RawRoute and a JSON-RPC call for one method per namespace:

```bash
curl -s -X POST http://localhost:3000/aws-blocks/api/orders -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","method":"orders.get","params":["42"],"id":1}'
```
