# Environment variables, secrets and config

> Read when: the app reads `process.env`, `import.meta.env` or a `.env*` file, and you must decide where each value lives after the migration.

## Why this needs care

- `cdk-blocks dev` loads `.env.local` into the backend process, and `next dev` / `vite` load their own `.env*` files. Every leftover `process.env.X` read therefore works locally.
- On AWS the functions get only the variables that AWS Blocks sets. A read that nobody migrated returns `undefined` after deploy, while every local check passed.
- Classify every variable into one of the five classes below. Finish with the sweep.

## Sweep

```bash
grep -rnE "process\.env|import\.meta\.env" . \
  --include='*.ts' --include='*.tsx' --include='*.js' --include='*.jsx' --include='*.mjs' \
  --exclude-dir=node_modules --exclude-dir=.next --exclude-dir=dist --exclude-dir=cdk.out
sed 's/=.*//' .env* 2>/dev/null | sort -u   # key names only; values stay out of your output
```

- Run it before you start (to build the list) and after the port (each remaining match must be in class (a) or (e), or be in code that no longer runs).
- Check platform config too (`vercel.json`, `netlify.toml`, a `Dockerfile`, CI files): they name variables that no source file reads directly.

## (a) Public build-time values: `NEXT_PUBLIC_*`, `VITE_*`

- The bundler inlines them into browser code when the build runs. They are public; a secret must not get one of these prefixes.
- `Hosting` runs `buildCommand` during synth and passes the environment of the deploy process to it. `cdk-blocks deploy` loads `.env.production` into that process first; `cdk-blocks sandbox` loads `.env.local`. A variable that is already set wins over the file.
- The scaffold adds `.env` and `.env.*` to `.gitignore` (it keeps `.env.example`). A value that exists only in an ignored file is missing on another machine or in CI, and the deployed bundle then contains `undefined`.
  - For values that are public and the same for every deploy, put them in `.env.production` and add `!.env.production` to `.gitignore`, or write them as constants.
  - Otherwise record each name in MIGRATION.md under Before deploy (`build-config`): the user must export it, or create `.env.production`, before the first deploy.
- Delete variables that held the old API location (`VITE_API_URL`, `NEXT_PUBLIC_API_BASE_URL`). The generated client finds the API (`cdk-blocks blockify-app guide client-wiring`).

## (b) Secrets and config read by Blocks backend code (`aws-blocks/`)

```ts
import { Secret, AppSetting, ApiNamespace, ApiError } from '@aws-blocks/blocks';

const stripeKey = new Secret(scope, 'stripe-api-key');                       // AWS Secrets Manager
const supportEmail = new AppSetting(scope, 'support-email', { value: 'help@example.com' }); // SSM parameter

export const api = new ApiNamespace(scope, 'api', () => ({
  async charge(amount: number) {
    const key = await stripeKey.get();
    if (key === null) throw new ApiError('Payments are not configured', 503);
    // ...
  },
}));
```

- `Secret` is the recommended block for credentials. `get()` returns `null` until a value is set; it does not throw. Handle `null`.
  - Options: `generate: true` creates a random value on first deploy (session or HMAC keys). `name` sets a fixed Secrets Manager name. `allowRuntimeWrite: true` adds `put()`; without it the object has no `put()` and the role is read-only.
  - On AWS the value, also a `null`, is cached for `cacheTtlSeconds` (default 300). A value set after deploy is visible after at most that time.
  - Cost: USD 0.40 per secret per month. Value limit 64 KB.
- `AppSetting` holds one SSM parameter. Non-secret: `{ value }` is required. `{ secret: true }` takes no `value` and no `schema` (synth and the local mock reject them). `get()` throws `AppSettingErrors.ParameterNotFound` when the parameter is missing or a secret is empty. Limit 4 KB. Use it for config, and for a low-value secret when the per-secret cost matters.
- Call `get()` inside a method or handler. At synth both classes throw on `get()`, so a top-level `await secret.get()` in `aws-blocks/index.ts` breaks `npx cdk synth`.
- No constructor accepts a secret value from source or from an environment variable. The first deploy creates the secret or parameter, empty; the user sets the value after it (record the step in MIGRATION.md under After deploy):
  - Open `/aws-blocks/settings` on the deployed app: it redirects to the stack's settings resource group in the AWS console, where `Secret` and `AppSetting` values are edited.
  - Or give the secret a `name` and let the user set it from a terminal, in the deploy Region: `npx --no -- cdk-blocks secret set <KEY> --prefix <app>` for `name: '<app>/<KEY>'` (it prompts), or `aws secretsmanager put-secret-value --secret-id <name> --secret-string file:///dev/stdin` with the value on stdin.
  - Do not create a secret with that `name` before the first deploy: the deploy then fails because the name is taken.
- Local mocks: a `Secret` reads `.bb-data/settings.json`, keyed by `name` or else by `fullId` (`new Secret(new Scope('my-app'), 'stripe-key')` is `my-app-stripe-key`). Without an entry `get()` returns `null`. A secret `AppSetting` returns a random value locally, so a third-party call runs with a wrong key instead of failing early. Use test keys only; `.bb-data/` is plain text.
- Non-secret values that CDK code knows (a queue URL, a flag): `registerConfig(blocksStack, 'KEY', value)` from `@aws-blocks/blocks/cdk` in `aws-blocks/index.cdk.ts` loads `KEY` into `process.env` on every Blocks compute at cold start.
- Details: `node_modules/@aws-blocks/blocks/docs/bb-secret/README.md`, `docs/bb-app-setting/README.md`.

## (c) Secrets and config read by SSR framework code

Next.js server components, route handlers and server actions run in a separate function that `Hosting` creates. `Secret` and `AppSetting` grant access to the Blocks execution role only, so SSR code uses Hosting values.

```ts
// aws-blocks/index.cdk.ts
import { Hosting, secret, config } from '@aws-blocks/blocks/cdk';

await Hosting.create(blocksStack, 'Hosting', {
  // ...existing props
  environment: {
    STRIPE_KEY: secret('STRIPE_KEY'),          // Secrets Manager; only a locator is injected
    FEATURE_FLAGS: config('FEATURE_FLAGS'),    // SSM Parameter Store
    SUPPORT_URL: 'https://example.com/help',   // plain string: visible in the CloudFormation template
  },
});
```

```ts
// SSR code
import { getSecret, getConfig } from '@aws-blocks/hosting';
const key = await getSecret('STRIPE_KEY');
```

- The environment variable name must equal the key. Use string-literal keys: the type generator skips others.
- Add `@aws-blocks/hosting` to the app's `dependencies`: the in-place scaffold adds only `@aws-blocks/blocks`.
- Resolution order: `process.env[KEY]`, then the injected locator. With neither, the call throws `[hosting] getSecret("KEY"): no secret reference found`. Port a route that answered 401 or 503 on a missing key with a `try`/`catch`.
- Local: put a test value in `.env.local` (the file `cdk-blocks dev` loads; it does not load `.env`). Because the plain variable wins, a key that you forgot to declare in `environment` still works locally and throws on AWS.
- The user sets the real values before the first deploy (these commands need AWS credentials and the deploy Region, and they need no deployed stack). Record each one in MIGRATION.md under Before deploy:

```bash
npx --no -- cdk-blocks secret set STRIPE_KEY                 # hidden prompt
npx --no -- cdk-blocks secret set STRIPE_KEY --value-stdin   # value piped on stdin
npx --no -- cdk-blocks config set FEATURE_FLAGS '{"beta":true}'
npx --no -- cdk-blocks secret list                           # names only
```

- A secret value on the command line is rejected (`A secret value must not be passed on the command line`). `set` creates or overwrites.
- `--stage <name>` writes a value that only an app with `secretStore: { stage: '<name>' }` (or `configStore`) reads; without it the value is shared by the stages of this app. `--region` selects the Region.
- The values are stored per app: Secrets Manager name `blocks/<stackId>/secrets/<KEY>` and SSM parameter `/blocks/<stackId>/config/<KEY>`, with `stackId` from `.blocks/config.json`. The commands and the deploy read the same file, so they agree without `--prefix`, `secretStore` or `configStore`; run the commands from the repository root. Changing `stackId` after a value was set leaves that value behind.
- `await Hosting.create(...)` checks during `cdk-blocks deploy` that each declared value exists and stops before it creates anything, with `UnresolvedSecretError` (`secret 'STRIPE_KEY' is referenced (environment) but not set.`). Without AWS credentials the check is skipped, so local `npx cdk synth` passes either way. `new Hosting(...)`, which the scaffold writes, does not check: the deploy succeeds and the first read fails at request time. Prefer `Hosting.create` (`index.cdk.ts` already uses top-level `await`).
- Edge-runtime routes run on Lambda@Edge, which takes no environment variables. Read secrets in Node-runtime code.
- Type-safe keys: `npx --no -- cdk-blocks generate types` writes `.blocks/hosting-values.d.ts` from the `secret()`/`config()` calls. Add `.blocks/**/*.d.ts` to `tsconfig.json` `include`. `--check` exits 1 when the file is stale. `cdk-blocks dev` regenerates it while it runs.
- When a Blocks backend exists, an alternative is to move the work into an `ApiNamespace` method that reads a `Secret`, and call it from SSR code (`cdk-blocks blockify-app guide api-routes`).
- Details: `node_modules/@aws-blocks/blocks/docs/hosting/README.md`, section "Secrets & config".

## (d) Variables to delete

- Config of what the migration replaced: the old auth provider's keys and URLs, the old host's variables (`VERCEL_*`, `KV_*`, `BLOB_*`), the old API base URL, `PORT` for a server that no longer runs.
- `DATABASE_URL`, once the `Database` block replaces the driver (`cdk-blocks blockify-app guide database`).
- Delete the reads in code too. Do not create a `Secret` for them and do not list them in MIGRATION.md.
- `cdk-blocks deploy` writes the first environment variable whose name ends in `_DB_URL` or `_CONNECTION_STRING` to an SSM SecureString for the external-database feature. Remove stale ones from `.env.production` unless the database guide tells you to keep them.

## (e) Variables the platform sets

- Leave these alone: `NODE_ENV`, `AWS_REGION`, `BLOCKS_API_URL` and `BLOCKS_CONFIG` (set by `Hosting` on SSR functions), `CORS_ALLOWED_ORIGINS` and `CORS_HOSTING_ORIGINS` (set from `defaults.allowedOrigins` and by `Hosting`).
- Do not put `BLOCKS_API_URL` in a `.env*` file: `cdk-blocks dev` then runs as a sandbox session and proxies API calls to that URL.

## Rules for secret values

- Secret values stay out of the repository, out of MIGRATION.md and out of command lines. Write names and commands only.
- For each value that only the user holds, add one MIGRATION.md entry with: the key or block id, what it is, where the code reads it, and the exact command or console step.
  - Hosting values (`secret()`, `config()`), under `Hosting.create` and under `new Hosting`: under Before deploy. They are stored outside the stack, and `Hosting.create` stops the first deploy until they are set.
  - `Secret` / `AppSetting` values: under After deploy. The stack creates them.
  - Public build-time values that are not in git: under Before deploy.
- Do not copy values from the app's `.env` files into `.env.local` for a third-party production account. Ask for, or record the need for, test credentials.
