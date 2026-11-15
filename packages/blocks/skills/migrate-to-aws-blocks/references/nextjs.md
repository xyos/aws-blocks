# Hosting a Next.js app

> Read when: the app depends on `next` and you write or check the `Hosting` block, `next.config`, the Next.js version, or Vercel-specific features.

Confirm details in `node_modules/@aws-blocks/blocks/docs/hosting/README.md` (sections "Next.js: the OpenNext version", "Front doors") and `node_modules/@aws-blocks/blocks/docs/core/README.md` (section "Hosting").

## How the build works

- `Hosting` with `framework: 'nextjs'` runs `buildCommand` during `cdk synth`, then runs OpenNext (`npx @opennextjs/aws build`), which builds Next.js again and writes `.open-next/`. The deploy uses `.open-next/`, so the synth of the playbook's validate task is the real build test for a Next.js app. Add `.open-next/` to `.gitignore`.
- When `framework` is omitted, a `next` entry in the app's own `package.json` selects `nextjs`. Set `framework` explicitly so the choice is visible.
- Declare OpenNext in the app, because `Hosting` does not install it:

  ```bash
  npm install --save-dev --save-exact @opennextjs/aws@4.1.14
  ```

- Pin an exact version (`--save-exact`; without it npm writes `^4.1.14`, which can resolve to an unverified minor). Choose the newest version inside the verified range whose `next` peer range accepts the app's Next.js: `npm view @opennextjs/aws@<version> peerDependencies.next` prints it. 4.1.14 accepts `>=15.5.28 <16 || >=16.4.1`; 4.1.16 needs `>=15.5.29 <16 || >=16.4.5`, so a `~4.1.14` range on an app with Next.js 16.4.2 resolves to 4.1.16 and `npm install` stops with `ERESOLVE`.
- Verified OpenNext range (`VERIFIED_OPENNEXT_RANGE`): `>=3.10.0 <3.11.0 || >=4.0.0 <4.2.0`. Outside the range the build prints `@opennextjs/aws@<v> is outside the version range this adapter was verified against` and continues; a later `UpstreamPatchPatternChangedError` then means the OpenNext version is the cause.
- Undeclared OpenNext: the build prints `@opennextjs/aws is not installed in this project; building with @opennextjs/aws@4.1.14` (`OPENNEXT_FALLBACK_VERSION`) and downloads it with `npx --yes`. If that build fails, synth throws `OpenNextNotFoundError`. With OpenNext installed, a failed build throws `OpenNextBuildError`; the cause is in the Next.js build output above it.
- Expected output that is safe to ignore: `ERROR Wrapper aws-lambda-streaming and converter aws-apigw-v1 are not compatible`. The adapter patches the bundle after the build.
- The adapter writes a temporary `open-next.config.ts` and removes it after the build. Keep the repository free of a hand-written `open-next.config.ts`; one that lacks `converter: 'aws-apigw-v1'` and a streaming wrapper fails synth with `IncompatibleOpenNextConfigError`.

## Next.js versions

OpenNext declares the Next.js versions it supports as a `next` peer range. For `@opennextjs/aws` 4.1.14 it is `>=15.5.28 <16 || >=16.4.1` (`OPENNEXT_FALLBACK_NEXT_PEER_RANGE`; also in `node_modules/@opennextjs/aws/package.json`). Outside it the build prints `next@<v> is outside the Next.js range @opennextjs/aws@<v> supports` and continues with an untested pair.

| App's `next` | SSR hosting with OpenNext 4.1.14 | Action |
|---|---|---|
| `>=16.4.1` | In range | None |
| `16.0.0` to `16.4.0` | Out of range | Upgrade `next` inside 16 to `>=16.4.1`; record it in MIGRATION.md |
| `>=15.5.28 <16` | In range | None |
| `15.0.0` to `15.5.27` | Out of range | Upgrade `next` inside 15 to `>=15.5.28`; record it in MIGRATION.md |
| 14.x and earlier | No verified OpenNext accepts it | Stop. A major upgrade is the user's decision; record it in MIGRATION.md under Blockers |

- The adapter always passes `--dangerously-use-unsupported-next-version true`, so a Next.js major that OpenNext calls unsupported builds with a warning (`Continuing build due to ... flag`). That warning is about upstream security support. It does not make an out-of-range version verified.
- Keep the app on its current major, and keep OpenNext inside the verified range. A build that passes on a downgraded or untested pair can fail after deploy.
- A static export (below) does not use OpenNext, so it has no version floor.

## `next.config`

- `output: 'standalone'` is optional. OpenNext forces standalone output for its own build; the `nextjs` template sets it so `npm run build` matches. Remove `output: 'export'` for an SSR deployment.
- `basePath`, `assetPrefix` (path form), `trailingSlash`, `images.remotePatterns`, `images.domains`, `images.dangerouslyAllowSVG` and `images.minimumCacheTTL` are read from the build output and applied to the front door. Leave them as the app has them.
- Simple `redirects()` and `headers()` rules move to the front door; rules with `has`/`missing`, regex or locale groups stay in the server function. `rewrites()` stay in the server function. Behavior is the same either way.
- A custom `generateBuildId` is kept.

## Hosting block (`aws-blocks/index.cdk.ts`)

```ts
if (!sandboxMode || previewMode) {
  new Hosting(blocksStack, 'Hosting', {
    ...(previewMode ? HostingPresets.preview : HostingPresets.production),
    root: join(__dirname, '..'),
    buildCommand: 'npm run build',
    framework: 'nextjs',
    api: blocksStack,
    compute: { memorySize: 1024, timeout: 30 },
  });
}
```

- `api: blocksStack` serves `/aws-blocks/api/*` from the same origin as the pages, so the browser needs no CORS setup, and it sets `BLOCKS_API_URL` on the server function.
- `compute` defaults: `memorySize` 512 MB, `timeout` 30 seconds (1 to 900). Leave `buildOutputDir` unset for `nextjs`.
- `HostingPresets.production` sets nothing: CloudFront, image optimization, ISR, Lambda@Edge for edge routes. `HostingPresets.preview` (used by `cdk-blocks sandbox preview`) sets `frontDoor: { kind: 'apiGateway' }`, `imageOptimization: false`, `incrementalRegeneration: false`, `edgeRoutes: 'regional'`, `buildId: 'fixed'`: responses are buffered (about 6 MB each), images are served unoptimized, and prerendered pages never regenerate. A plain `cdk-blocks sandbox` deploys the backend only.
- `basePath`: Next.js `basePath` is detected from the build (`Detected Next.js basePath=/app`) and every route is prefixed, so the app is served at `https://<domain>/app/...`. The `Hosting` prop `basePath` overrides the detected value; set it only to the same value as `next.config`.

## Static export (`output: 'export'`)

```ts
new Hosting(blocksStack, 'Hosting', {
  ...HostingPresets.production,
  root: join(__dirname, '..'),
  buildCommand: 'npm run build',
  framework: 'static',
  buildOutputDir: 'out',
  api: blocksStack,
});
```

- Set `framework: 'static'` explicitly, because auto-detection picks `nextjs` from the `next` dependency. `static` creates no server function and no OpenNext build.
- Set `buildOutputDir: 'out'`; the default for `static` is `dist`, and synth fails with `Build output directory not found`.
- `static` resolves `/about` and `/about/` to `/about/index.html`. Set `trailingSlash: true` in `next.config` so the export writes `about/index.html`; a flat `about.html` returns 404 for `/about`.
- A top-level `404.html` becomes the error page. Unknown paths return 404 (`framework: 'spa'` would answer them with `index.html`).
- Features that need a server stay unavailable, as with any static export: route handlers that read the request, server actions, middleware, ISR, default `next/image` optimization (general Next.js knowledge; `next build` reports them).

## Feature support on AWS

- App Router and Pages Router (`getServerSideProps`, `getStaticProps`, `pages/api/*`), route handlers and server actions run in one server Lambda function behind CloudFront and an API Gateway REST API, with response streaming on the default door.
- Limits on that path: confirm the request size and timeout of the server origin in the hosting README (sections "The server origin's REST API" and "The ALB and API Gateway doors: rules and limits", which gives 10 MB request payload and a 29-second integration timeout for API Gateway). Move large uploads to direct S3 uploads: `cdk-blocks blockify-app guide file-uploads`. Move work longer than the timeout to a job: `cdk-blocks blockify-app guide jobs`.
- Middleware (`middleware.ts`): with the generated OpenNext config it is bundled into the server function. A hand-written config that splits it out makes it a Lambda@Edge function, which only the CloudFront door runs (`MiddlewareNeedsCloudFrontDoorError` on other doors).
- `export const runtime = 'edge'` routes are supported. Each one is built as its own Lambda@Edge function (the build prints `Generated open-next.config.ts with edge function for: ...`). Consequences: the stack needs an explicit region or synth fails with `EdgeComputeRequiresRegionError`; outside `us-east-1` a second support stack is created in `us-east-1`, which must be bootstrapped; Lambda@Edge functions receive no environment variables, so `BLOCKS_API_URL` and `environment` values are absent there. The simplest fix is to delete the `runtime = 'edge'` line when the route works on Node.js. Otherwise add `env: { account: process.env.CDK_DEFAULT_ACCOUNT, region: process.env.CDK_DEFAULT_REGION }` to `BlocksStack.create` and record the `us-east-1` bootstrap in MIGRATION.md under Before deploy (`account`).
- ISR, `revalidate`, `generateStaticParams`, `revalidatePath` and `revalidateTag` are supported in production shape: an S3 cache bucket seeded from the build, a DynamoDB tag table, an SQS FIFO revalidation queue and a revalidation function. With `incrementalRegeneration: false` (preview) only the seeded cache exists.
- Shared-cache safety: a response that sets a cookie, or answers a request with credentials outside the cache key, is sent as `Cache-Control: private, no-store`. Set `frontDoor.features.cacheKeyCookies` to the session cookie name when per-user pages use `s-maxage` or `revalidate`.
- `next/image`: a separate image function with `sharp` (`^0.35.5`, linux-x64) is installed at synth; when the install fails the build warns and images are served unoptimized. Remote sources follow `images.remotePatterns`.
- Server-side WebSocket upgrades are unsupported on this path. Use the Realtime block for push.
- `Hosting` creates no scheduler. `vercel.json` `crons` produce the warning `vercel.json declares N cron job(s), but the hosting construct wires no scheduler`; move each one to a cron job: `cdk-blocks blockify-app guide jobs`.

## Vercel-specific files and packages

- The adapter reads `vercel.json` only to warn about `crons`. `rewrites`, `redirects`, `headers` and `functions` in `vercel.json` have no effect; move them to `next.config` (`redirects()`, `rewrites()`, `headers()`) and to `compute` on `Hosting`.
- The adapter does not inspect `@vercel/*` packages. The following is general knowledge; check each against the package's own documentation:
  - `@vercel/analytics`, `@vercel/speed-insights`: they build, and send no data off Vercel. Remove them or leave them; record the loss of analytics in MIGRATION.md.
  - `@vercel/og` / `next/og`: runs inside the server function. Keep it, on the Node.js runtime.
  - `@vercel/kv`, `@vercel/blob`, `@vercel/postgres`, `@vercel/edge-config`: they call Vercel-hosted services. Replace them: `cdk-blocks blockify-app guide key-value`, `file-uploads`, `database`.
- Vercel system variables (`VERCEL_URL`, `VERCEL_ENV`) are unset on AWS. Replace each read with a `config()` value or a request-derived host.

## Calling the backend and local development

- `cdk-blocks dev` detects `next` in the app's dependencies and starts `npx next dev --webpack --hostname 127.0.0.1 --port 3100` behind the dev server on http://localhost:3000. Change ports with `package.json` `"blocks": { "dev": { "port", "frontendPort" } }`. Keep the detected command unless `cdk-blocks dev` shows the frontend failing to start with it (a Next.js version that rejects `--webpack`); only then set `blocks.dev.frontendCommand`, to a command that contains the same port as `blocks.dev.frontendPort`. A command with a port written into it stops `--frontend-port` from working.
- Server Components, route handlers and Client Components all use `import { api } from 'aws-blocks'`. The client finds the API in this order: `BLOCKS_API_URL`, `BLOCKS_CONFIG`, the file `.blocks-sandbox/config.json` in the working directory (Node.js 22.3 or later), then in the browser `fetch('/.blocks-sandbox/config.json')`.
- Leave `BLOCKS_API_URL` unset in `.env*` files and in `environment`. `Hosting` sets it on the deployed server function and for the build, and `cdk-blocks sandbox` sets it for the local server. A value set locally makes the dev server proxy to that URL in place of the local mocks.
- Pages that call `api` on the server need `export const dynamic = 'force-dynamic'` (or another dynamic signal). The API URL exists at request time only; a page prerendered during the build has no backend to call.
- Signed-in calls from server code: wrap them so the browser's cookies are forwarded.

  ```ts
  import { withAuth } from '@aws-blocks/blocks/server';
  const posts = await withAuth(() => api.listMyPosts());
  ```

  `withAuth` reads cookies from `next/headers` and throws a 401 `ApiError` when there are none. See `cdk-blocks blockify-app guide auth`.

## Environment variables

- `NEXT_PUBLIC_*` values are inlined by `next build`, and that build runs inside synth and deploy with the environment of the deploying shell. Record each `NEXT_PUBLIC_*` name in MIGRATION.md so the user sets it where the deploy runs.
- Server-side values come from the `environment` prop on `Hosting`: a plain string is visible in the CloudFormation template; `secret('KEY')` and `config('KEY')` (from `@aws-blocks/blocks/cdk`) inject only a locator. The key must equal the variable name. Read them with `getSecret('KEY')` / `getConfig('KEY')` from `@aws-blocks/hosting` (add it to `dependencies`); `process.env.KEY` holds the real value only locally. See `cdk-blocks blockify-app guide secrets`.
- A setting that only the Blocks backend (`aws-blocks/index.ts`) can read is not visible in Next.js server code, which runs in a different Lambda function. Call an `api` method for it, or declare the value in `environment` as well.

## TypeScript

- A Next.js app gets no `aws-blocks/tsconfig.json`. `next build` ignores project references when it type-checks, so it checks `aws-blocks/` with the app's `tsconfig.json`. A type error in `aws-blocks/index.ts` therefore fails `next build`.
- Exclude only the CDK entry from the app's `tsconfig.json`, as the template does: `"exclude": ["node_modules", "aws-blocks/index.cdk.ts"]`. Keep `aws-blocks/index.ts` included; it is the source of the `api` types.
