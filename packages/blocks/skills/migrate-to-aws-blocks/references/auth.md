# Replacing an app's sign-in with the Auth block

> Read when: the app signs users in with its own code or a library (Auth.js / next-auth, better-auth, Clerk, Passport, hand-rolled sessions) and the migration replaces that with the `Auth` block.

Confirm details in `node_modules/@aws-blocks/blocks/docs/bb-auth/README.md` (recipes, option tables), `docs/bb-auth/CUSTOMIZING-AUTH-UI.md` (custom forms) and `docs/auth-common/README.md` (UI helpers). Supabase-hosted auth stays on Supabase: see `cdk-blocks migrate guide supabase`.

## Pick the configuration

`Auth` is one block. `store` decides where users live, and one block holds one kind of user.

| The app signs in with | Configuration | Sign-in in `cdk-blocks dev` |
|---|---|---|
| Email + password (better-auth, Auth.js credentials, Passport local, Clerk, own sessions) | default store: `new Auth(scope, 'auth', { users: { signInWith: ['email'], caseSensitive: false } })` | Works. Local user pool in `.bb-data/`. |
| Only GitHub, or another OAuth 2.0 / OIDC provider (Auth.js with GitHub, Okta, Entra ID, Auth0) | `store: 'builtin'` with `github({ clientId, clientSecret })`, `customOauth2({...})` or `{ type: 'oidc', issuer, clientId, clientSecret? }` | Works with `stubIdp()`. The real provider works only with its real credentials and a `localhost` callback. |
| Only Google, Apple, Facebook or Amazon | default store: `emailPassword: false`, `providers: { google: { type: 'google', clientId, clientSecret } }` (the key must equal the `type`) | Does not work. The sign-in route answers `501` `ProviderUnavailableException`; test on a deployed sandbox. |
| Password users and a backend-verified provider | Two `Auth` blocks, each with its own `createApi()` export | Each as above. |

- `github()`, `customOauth2()` and `stubIdp()` compile only with `store: 'builtin'`. `type: 'google'` and `type: 'saml'` compile only on the default store.
- A `store: 'builtin'` block creates no user pool. It has no email + password, MFA, `auth.admin` or `users.signInWith`; `users.groups` is the only `users` key, and `requireRole` reads groups from the provider's `groupsClaim`.
- An option that `Auth` does not know is an error at construction (in dev, at synth and in Lambda), with a "did you mean" hint.

## Options to decide before the first deploy

- Fixed once the user pool exists; synth and deploy refuse a change: `users.signInWith` (default `['username', 'email']`), `users.caseSensitive` (default case-sensitive), required and existing custom `users.attributes`, `hostedUi.domainPrefix`, the `store`, and the block id (`'auth'`). Renaming or removing the block deletes the pool and its users.
- Email sign-in needs `users.signInWith: ['email']`. With the default, an email is only an alias and a username may not look like an email, so a form that sends the email as `username` fails at sign-up.
- `users.caseSensitive: false` lets `Alice@Example.com` sign in as `alice@example.com`. Set it when the original app compared emails without case.
- `emailPassword.selfSignUp` defaults to `true`. Set `false` when the original app had no public sign-up; users are then created only through `auth.admin`, and sign-up answers `NotAuthorizedException`.
- `emailPassword.passwordPolicy` defaults to `minLength: 8` and `requireUppercase`, `requireLowercase`, `requireDigits`, `requireSymbols` all `true`. Set it to the rule the original form enforced, or its validation messages become wrong. A rejected password is `InvalidPasswordException`.
- `users.attributes` declares custom attributes only. `email` and the other standard attributes are implicit.
- Commit the baseline file that synth writes to `aws-blocks/baselines/`; the guard compares against it.

## Backend

```ts
// aws-blocks/index.ts
import { Auth, Scope } from '@aws-blocks/blocks';

const scope = new Scope('my-app');
const auth = new Auth(scope, 'auth', { users: { signInWith: ['email'], caseSensitive: false, groups: ['admin'] } });
export const authApi = auth.createApi(); // the export name is the client namespace

export const api = auth.protect(scope, 'api', {
  public: () => ({ async health() { return { ok: true }; } }),
  methods: (context, user) => ({
    async me() { return { id: user.userSub, email: user.attributes.email ?? null }; },
    async adminOnly() { await auth.requireRole(context, 'admin'); return true; },
  }),
});
```

- Every method of a plain `new ApiNamespace(...)` is public until it awaits `auth.requireAuth(context)` or `auth.requireRole(context, role)`. A guard without `await` protects nothing, and the local runtime behaves the same, so a missing guard passes every local check. `auth.protect` is deny by default: `methods` run only after the session check.
- Keep public routes public. Add a guard only where the original route required a signed-in user.
- No session: 401 `NotAuthenticatedException`. Signed in but outside the group: 403 `NotAuthorizedException`. `requireRole` reads group membership on each request. `auth.getCurrentUser(context)` returns the user or `null`.
- The user object: `userSub`, `userId`, `username`, `groups`, `attributes`, `signInProvider` (`'password'` or the provider id), and for federated users `federatedIdentity` (`{ providerId, sub }`) and, on a `'builtin'` block, `claims`. There is no top-level `email`: read `user.attributes.email`.
- Key data on `user.userSub`. Default store: the Cognito `sub` (a UUID). `'builtin'` store: `` `${issuer}:${sub}` ``, for example `oauth2:github:<GitHub user id>`. With `signInWith: ['email']`, `username` and `userId` are a generated id equal to `userSub`, so show `attributes.email` to people.
- `auth.admin` (`createUser`, `setUserPassword`, `addUserToGroup`, `getUser`, `scan`, ...) exists only with `admin: {}` on a default-store block. It does not check the caller, so gate each method that uses it with `requireRole`.

## Provider sign-in (OAuth-only apps)

```ts
import { Auth, Scope, Secret, getDeploymentType, github, stubIdp } from '@aws-blocks/blocks';

const scope = new Scope('my-app');
const githubSecret = new Secret(scope, 'github-client-secret', { name: 'my-app/GITHUB_CLIENT_SECRET' });
const auth = new Auth(scope, 'auth', {
  store: 'builtin',
  providers: {
    github: getDeploymentType() === 'production'
      ? github({ clientId: 'Iv1.your-client-id', clientSecret: githubSecret })
      : stubIdp({ users: [{ sub: 'u-1', email: 'dev@example.com', name: 'Dev' }] }),
  },
});
export const authApi = auth.createApi();
```

- `stubIdp()` is a real OIDC provider with an account picker, served by `cdk-blocks dev` and by sandbox deployments. Synth of any other deployment that contains a stub fails, so select the provider with `getDeploymentType()` (`'local'`, `'sandbox'` or `'production'`). On a sandbox the stub signs in anyone who can reach the URL.
- Local validation with the stub proves the session, the guards and the UI. It does not prove the real provider: the client id, the secret and the callback URL are first exercised on a deployed stack. Record that check in MIGRATION.md under After deploy.
- `clientId` is a literal string in the code. Take it from the old provider config (`GITHUB_ID`, `GOOGLE_CLIENT_ID` in an env file) when the repository has it. When it does not, write a placeholder and record a `code` step in MIGRATION.md under Before deploy: sign-in cannot work until the real id is in `aws-blocks/index.ts`.
- `clientSecret` is a reference, never a string: a `Secret`, or an `AppSetting` with `secret: true`. The first deploy creates the `Secret` above; the user sets it after that deploy with `npx --no -- cdk-blocks secret set GITHUB_CLIENT_SECRET --prefix my-app` (it prompts; `--value-stdin` reads a pipe). Record it under After deploy. Until it has a value, sign-in fails and the backend logs "the provider client secret has no value".
- To run the real provider locally, put the value in `.bb-data/settings.json` under the secret's `name` (`{ "my-app/GITHUB_CLIENT_SECRET": "..." }`) and register `http://localhost:3000/aws-blocks/auth/callback` with the provider.
- Callback URL to register for a `'builtin'` block: `<app origin>/aws-blocks/auth/callback`. The post-logout URL is `<app origin>/`. The origin exists only after the first deploy, so record this step in MIGRATION.md under After deploy.
- Default-store providers (`type: 'google'` and the other social types, `type: 'saml'`, `type: 'oidc'`) federate through Cognito managed login. Register `https://<domainPrefix>.auth.<region>.amazoncognito.com/oauth2/idpresponse` with the provider and set `hostedUi: { domainPrefix }` before the first deploy. A `Secret` used there needs `generate: true`, or the first deploy fails reading it (synth warns `@aws-blocks/bb-auth:ProviderSecretWithoutValue`); set the real value, then deploy again.
- The browser starts a provider sign-in by navigation, not by RPC: follow the `url` of the `signIn:<id>` action from `getAuthState()` (`/aws-blocks/auth/signin/<id>`, optional same-origin `?redirectPath=`). `setAuthState({ action: 'signIn:<id>' })` answers an `InvalidParameterException` state.
- `github()` reads the profile from `https://api.github.com/user`, so `attributes.email` is absent for a user whose GitHub email is private. Relink GitHub users by `user.federatedIdentity.sub` (the GitHub user id), which Auth.js stored as `accounts.providerAccountId`.
- Two blocks that both have `providers` mount the same routes and fail at synth. Give the second its own `redirects: { callbackPath, signOutPath }` under `/aws-blocks/auth/`.

## Sign-in UI

- Browser code imports `authApi` from `'aws-blocks'`, helpers from `@aws-blocks/blocks/ui` and `@aws-blocks/blocks/client`. The root `@aws-blocks/blocks` entry exports nothing under the `browser` condition, so match errors by their wire name: `isBlocksError(e, 'NotAuthenticatedException')` and `hasAuthError(state, 'NotAuthorizedException')`.
- `Authenticator(authApi)`, `AccountMenuBar(authApi)` and `AuthenticatedContent(authApi, render, fallback)` return DOM nodes and cover the whole flow. In React, append the node to a ref inside `useEffect` in a client component. Nothing renders a sign-in screen until the app mounts one.
- A custom form drives the state machine: `authApi.getAuthState()` and `submitAuthAction(authApi, { action, ...fields })` from `/ui`. `submitAuthAction` calls `authApi.setAuthState` and then notifies `onAuthChange`, `AuthenticatedContent` and other tabs; a bare `setAuthState` call notifies nothing.
- `AuthState`: `state` (`signedOut`, `signedIn`, `confirmingSignUp`, `confirmingSignIn`, `confirmingPasswordReset`), `actions` (name, label, fields, optional `url`), `user`, `error`, `errorName`, `retriable`. Read hidden fields such as `session` and `challenge` from `state.actions[n].fields` and send them back.
- Actions for email + password:
  - `{ action: 'signIn', username, password }` → `signedIn`, or `confirmingSignIn`.
  - `{ action: 'signUp', username, password }` → `confirmingSignUp`. Add `email` when `signInWith` includes `'username'`.
  - `{ action: 'confirmSignUp', username, code }` → a state whose only action is `autoSignIn`; submit `{ action: 'autoSignIn', username }` → `signedIn`. `{ action: 'resendSignUpCode', username }` sends a new code.
  - `{ action: 'confirmSignIn', session, challenge: 'newPassword', newPassword }` for an admin-created user's first sign-in.
  - `{ action: 'resetPassword', username }` → `confirmingPasswordReset`; `{ action: 'confirmResetPassword', username, code, newPassword }` → `signedOut`, and every session of that user ends.
  - `{ action: 'signOut' }` → `signedOut`.
- Failures of an action return a state; only network and 5xx errors reject. A failure with `retriable: true` has `state: 'signedOut'` and no actions: keep the current form and show `error`.
- Error names: wrong user or password `NotAuthorizedException` (one answer for both), `CodeMismatchException` (wrong code; by default also an expired code or an unknown user), `InvalidPasswordException`, `PasswordResetRequiredException`, `LimitExceededException`. `UsernameExistsException` and `ExpiredCodeException` appear only with `emailPassword.revealExistingUsers: true`; by default a sign-up for an existing account answers `confirmingSignUp` like a new one.
- `onAuthChange(authApi, (user) => ...)` reports who is signed in. `getAuthStateSnapshot(authApi)` returns `null` until the first read lands; `null` means "not known yet", so do not redirect on it. `broadcastAuthChange` is needed only when the session changed outside `submitAuthAction`.
- `state.user` carries `displayName` (the email on an email pool), `userSub`, `groups` and `attributes`.

## Next.js server code

```tsx
// app/dashboard/page.tsx
import { redirect } from 'next/navigation';
import { withAuth } from '@aws-blocks/blocks/server';
import { api } from 'aws-blocks';

export const dynamic = 'force-dynamic'; // the page reads cookies and the API URL at request time

export default async function Page() {
  let me: Awaited<ReturnType<typeof api.me>> | undefined;
  try {
    me = await withAuth(() => api.me());
  } catch (e) {
    if ((e as { status?: number }).status !== 401) throw e; // only a 401 means "signed out"
  }
  if (!me) redirect('/sign-in'); // redirect() throws, so call it outside the try
  return <p>{me.email}</p>;
}
```

- Server components, route handlers and server actions do not send the browser's cookies to the API. `withAuth(fn)` reads them from `next/headers` and forwards them to every call inside `fn`. Other frameworks pass the header: `withAuth(fn, request.headers.get('cookie'))`.
- `withAuth` throws a 401 `ApiError` when the request has no cookies; a guard throws 401 `NotAuthenticatedException`. Branch on `status === 401`, and rethrow other errors so a database failure does not loop between the page and sign-in.
- This replaces `auth()`, `getServerSession()`, `auth.api.getSession()` and Clerk's `auth()`: call a gated API method (or `authApi.getAuthState()`) inside `withAuth` in each layout, page or route handler that needs the user.
- Remove the session check from `middleware.ts` (next-auth `withAuth`, better-auth cookie checks, `clerkMiddleware`). The session is validated by the backend, so the check runs in the page, layout or route handler as above. The session cookie is `auth_<block fullId>` (`HttpOnly`); its presence does not prove a session.
- Every URL that the old middleware protected must still turn a signed-out visitor away. List the paths of its `matcher` (or of each `auth()` redirect) before you remove it, and give each one the check above. A page that is a client component (`'use client'`) cannot run the check: add a `layout.tsx` for its route segment, or make the page a server component that renders the client component, and do the check and the `redirect()` there. A gated API method keeps the data safe, but a page that renders empty for a signed-out visitor where it used to redirect is a change in behavior.
- Prove it: with the local server running, request each protected URL without cookies (`curl -s -o /dev/null -w '%{http_code}' http://localhost:3000/notes`) and confirm a redirect to sign-in (307) where the original redirected.
- Run sign-in, sign-up and sign-out in the browser (a client component), so the browser receives the session cookie.

## Confirmation codes and email

- Every self-service sign-up confirms the address with a 6-digit code. Build that step even when the original app had none.
- Locally nothing is sent. Each code is written to `.bb-data/<fullId>/last-code.json` as `{ username, code, purpose }` and passed to the local-only `codeDelivery` hook. Add `codeDelivery: async (username, code, purpose) => console.log(purpose, username, code)` to see codes in the dev terminal. AWS ignores the hook.
- On AWS, Cognito sends the codes. Its default sender is limited to 50 emails per day (sign-up, reset and email MFA together). For production set `email: { fromAddress, fromName }` with an SES identity verified in the pool's Region and request SES production access; it can be added later without touching users. Record this in MIGRATION.md under After deploy.

## Existing users and user rows

- Passwords cannot be imported: Cognito does not accept another system's password hashes. Record a user-migration step in MIGRATION.md under After deploy: users sign up again or use "forgot password"; with `selfSignUp: false` an admin calls `auth.admin.createUser(username, { temporaryPassword?, suppressInvite? })` and the user sets a new password at first sign-in (`confirmingSignIn`).
- Find the code that created the app's user or profile row. When the app's own form created it, keep that code and replace only the id source. When the old provider created it (adapter, webhook), add an upsert in a helper that every gated method calls, before any insert that references the row.
- New ids do not match old rows. Add a column for `userSub` and look users up by it; this is safer than rewriting primary keys, which needs `ON UPDATE CASCADE` on every foreign key in the deployed schema.
- Relink an old row by email only when the pool verified the address: `(await auth.getUserAttributes(context)).email_verified === 'true'`. A relink on an unverified email lets one user take over another user's rows.
- Leave the old provider's tables (`sessions`, `accounts`, `verification`, password hash columns) in place and stop reading them. Dropping them is a separate decision for the user.

## Remove the replaced provider

- Packages (`next-auth`, `@auth/*`, `better-auth`, `@clerk/*`, `passport*`, session stores) and their config files.
- Route handlers (`app/api/auth/[...nextauth]`, `app/api/auth/[...all]`), auth middleware, provider components (`SessionProvider`, `ClerkProvider`) and their hooks.
- Env vars: `NEXTAUTH_*`, `AUTH_SECRET`, `AUTH_URL`, `AUTH_TRUST_HOST`, `BETTER_AUTH_*`, `CLERK_*`, `NEXT_PUBLIC_CLERK_*`. Provider credentials such as `AUTH_GITHUB_ID` and `AUTH_GITHUB_SECRET` move into the `providers` entry and its `Secret`.

## Local smoke test

```sh
U=http://localhost:3000/aws-blocks/api; H='Content-Type: application/json'
curl -s -c jar -X POST $U -H "$H" -d '{"jsonrpc":"2.0","id":1,"method":"authApi.setAuthState","params":[{"action":"signUp","username":"a@example.com","password":"Passw0rd!"}]}'
CODE=$(node -p "require('./.bb-data/my-app-auth/last-code.json').code")
curl -s -b jar -c jar -X POST $U -H "$H" -d '{"jsonrpc":"2.0","id":2,"method":"authApi.setAuthState","params":[{"action":"confirmSignUp","username":"a@example.com","code":"'$CODE'"}]}'
curl -s -b jar -c jar -X POST $U -H "$H" -d '{"jsonrpc":"2.0","id":3,"method":"authApi.setAuthState","params":[{"action":"signIn","username":"a@example.com","password":"Passw0rd!"}]}'
curl -s -b jar -X POST $U -H "$H" -d '{"jsonrpc":"2.0","id":4,"method":"api.me","params":[]}'   # the user; without -b jar: NotAuthenticatedException
```

- The method is `<export name>.<method>`. `my-app-auth` is the block's `fullId` (scope id, then block id).
- Local users, groups and the session secret live in `.bb-data/<fullId>/state.json`, with passwords in plain text. Use test credentials only. Delete `.bb-data/` to reset.
- In tests use `getLastAuthCode(username)` and `createTestClient(app)` from `@aws-blocks/blocks/utils` (Node only; one cookie jar per user). Run them from the project root under `tsx -C browser`. The built-in forms carry test ids such as `authenticator-username`, `authenticator-password`, `authenticator-code`, `authenticator-action-signIn`.
- The local pool accepts any 6-digit authenticator code and does not verify passkey signatures; AWS verifies both.
