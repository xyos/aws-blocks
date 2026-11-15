# Apps that use Supabase

> Read when: the app imports `@supabase/supabase-js` or `@supabase/ssr`, or has a `supabase/` directory.

## Default decision

- Supabase-hosted surfaces stay on Supabase: `supabase.auth.*`, tables read with `supabase.from()`, Storage, and Realtime. The migration moves the hosting and the server runtime. The reason: users, sessions, row-level security policies and data keep working with no export and no user re-enrollment.
- Replace a Supabase surface only when the user asked to leave Supabase. See "Leaving Supabase" below.
- Record the decision in `MIGRATION.md`, with the Supabase project the app depends on.

## What changes

- **Public values** (`NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`, `VITE_SUPABASE_*`): the frontend build inlines them. Hosting runs `buildCommand` at synth and deploy with the environment of the deploy process, and `cdk-blocks deploy` loads `.env.production` first. The values must be present there, or the deployed bundle has `undefined` in their place while the local build passes. Record each one that is not in git in `MIGRATION.md` under Before deploy (`build-config`). For values that the SSR function reads at runtime, see `cdk-blocks migrate guide secrets`.
- **Service-role key**: it bypasses row-level security. Keep it in server code only and store it as a `Secret` (`cdk-blocks migrate guide secrets`). Record "set the service-role key" in `MIGRATION.md` under After deploy.
- **Redirect URLs**: Supabase Auth sends users back to allow-listed URLs. Record in `MIGRATION.md` under After deploy: add the deployed origin to the project's Site URL and Redirect URLs (Supabase dashboard, Authentication, URL Configuration), and to each OAuth provider that lists origins. Until then email links and OAuth sign-in return to the old origin.
- **Middleware and server clients** (`@supabase/ssr`): the session refresh in `middleware.ts` and `createServerClient` run in the Next.js server function with no code change. Cookies are set on the deployed origin, so keep cookie options free of a hard-coded `domain`. See `cdk-blocks migrate guide nextjs`.
- **Images**: `next/image` `remotePatterns` for `*.supabase.co` stay as they are.
- **Local dev**: `cdk-blocks dev` needs the same project values as before. The Blocks backend loads `.env.local` (and does not load `.env`); the frontend dev server loads its own env files as before.

## Edge functions (`supabase/functions/*`)

Edge functions are server code, so they move when the user wants the server runtime on AWS. Each function becomes a method of an exported `ApiNamespace` (or a `RawRoute` for a webhook that needs the raw body). When the user wants no backend change, leave them deployed on Supabase and record that.

- Replace `Deno.serve` and `Deno.env.get` with a plain method and a `Secret` or config value; replace `https://esm.sh/…` and `npm:` imports with dependencies in `aws-blocks/package.json`.
- The typed client sends no Supabase session. Pass the access token as an argument from the frontend (`(await supabase.auth.getSession()).data.session?.access_token`).
- A function that required a verified caller (`verify_jwt`) verifies the token first. Verify against the project's JWKS; `jose` is a small dependency for this:

```typescript
import { createRemoteJWKSet, jwtVerify } from 'jose';
import { ApiError, ApiNamespace } from '@aws-blocks/blocks';

// The project URL is public. Hard-code it or read it from a config value (guide `secrets`).
const issuer = 'https://<project-ref>.supabase.co/auth/v1';
const jwks = createRemoteJWKSet(new URL(`${issuer}/.well-known/jwks.json`));

async function requireSupabaseUser(token: string) {
  try {
    const { payload } = await jwtVerify(token, jwks, { issuer, audience: 'authenticated' });
    return payload; // payload.sub is the Supabase user id
  } catch {
    throw new ApiError('Not authenticated', 401, { name: 'NotAuthenticatedException' });
  }
}

export const functions = new ApiNamespace(scope, 'functions', () => ({
  async createReport(accessToken: string, input: { title: string }) {
    const user = await requireSupabaseUser(accessToken);
    // Same posture as the original: a client with the caller's token, or the service-role key.
  },
}));
```

- The Supabase-side details here (JWKS path, `audience`, dashboard locations) are general knowledge about Supabase; confirm them in the Supabase docs for the project.
- JWKS verification needs asymmetric signing keys (ES256 or RS256) on the Supabase project. A project that signs with the legacy HS256 secret publishes no public keys: verify with `supabase.auth.getUser(token)` instead (one network call per request), or record "switch the project to asymmetric JWT signing keys" under Blockers.
- Keep each function's original posture. A user-scoped function creates a client with the anon key and the header `Authorization: Bearer <token>`, so row-level security still applies. A function that used the service-role key keeps using it, from a `Secret`.
- Every `ApiNamespace` method is a public endpoint. A method without the verification above is callable by anyone, and local checks do not show that.
- Update the callers: `supabase.functions.invoke('name', { body })` becomes `functions.name(token, body)` from `import { functions } from 'aws-blocks'`. See `cdk-blocks migrate guide client-wiring`.
- A function that calls an LLM: see `cdk-blocks migrate guide ai`. A function on a schedule: see `cdk-blocks migrate guide jobs`.

## Local mocks and AWS

- Supabase is not mocked. Local checks call the real project, so use a development project when one exists, and keep test data out of production tables.
- A page that fails locally only because a Supabase value is absent from `.env.local` is an environment gap. Record the value name under Blockers; add no placeholder.
- On AWS the server code runs in Lambda, with the 29-second API Gateway limit for API methods (`cdk-blocks migrate guide aws-limits`). An edge function that ran longer needs an `AsyncJob`.

## Leaving Supabase

Do this only on request, one surface at a time. Each step has a data move that the user must run; record it in `MIGRATION.md` under After deploy.

- **Database**: `Database` with `connection: fromExisting({ connectionString })` connects the Blocks backend to the existing Supabase Postgres, so the code can move before the data. The server certificate is verified by default; pass the provider CA in `ssl.ca` (PEM contents). `npx --no -- cdk-blocks db pull` introspects the public schema read-only and generates typed tables and CRUD for tables that have a primary key and row-level security enabled; it does not migrate Auth, Storage, Realtime or Edge Functions. `db.withRLS({ userId, role })` sets `request.jwt.claims` so that existing policies keep applying. Details: `node_modules/@aws-blocks/blocks/docs/bb-data/README.md` and `cdk-blocks migrate guide database`. Moving the data to Aurora is a dump and restore that the user runs.
- **Auth**: see `cdk-blocks migrate guide auth`. Record how existing users get an account in the new user store (user re-enrollment).
- **Storage**: see `cdk-blocks migrate guide file-uploads`. Record the object copy from Supabase Storage to the new bucket, and replace stored public URLs with keys.
- **Realtime**: the `Realtime` block (`node_modules/@aws-blocks/blocks/docs/bb-realtime/README.md`) delivers messages that the backend publishes with `publish()`. Code that subscribed to table changes needs the backend to publish after each write.
