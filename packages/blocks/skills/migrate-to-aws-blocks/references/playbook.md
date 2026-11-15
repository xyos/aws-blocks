# Playbook: move an existing app onto AWS Blocks

> Read when: you start the migration. This is the procedure; the other pages are reference for one topic each.

You move this web app onto AWS Blocks in place: the same repository, the same product, a new hosting and server runtime. No fixed list of steps fits every app. Inspect the repository, write a plan that fits it, carry the plan out, and prove the result runs.

How commands are written here: `cdk-blocks <command>` means `npx --no -- cdk-blocks <command>` once the app has `@aws-blocks/blocks` installed (after the scaffold task), and `npx -y -p @aws-blocks/blocks cdk-blocks <command>` before that. Replace `npm` with the app's package manager.

## How to work

1. Inspect the repository: how it builds and starts, every route and server function, what it stores and where, how users sign in, which environment variables it reads, what runs on a schedule. `cdk-blocks blockify-app playbook` lists what it detected; treat that list as a start and check it.
2. Write the plan into `MIGRATION.md` at the repository root before you change any other file. Use the template in "Plan and report" below.
3. Read the guide for each surface before you write its task: `cdk-blocks blockify-app guide <name>`. The block documentation is in `node_modules/@aws-blocks/blocks/docs/<package>/README.md` after the install; confirm every block name, option and method there before a task depends on it.
4. Carry out the tasks in order and tick each one in `MIGRATION.md` when it is done.
5. Validate as "Validate task" says. Then complete `MIGRATION.md`: blockers, the steps the user must do before and after the first deploy, and the result of each check.

Rules for the whole migration:

- Stay local. Do not deploy and do not run a command that needs an AWS account (`deploy`, `sandbox`, `cdk deploy`, `cdk bootstrap`, `secret set`, `config set`) unless the user asked for a deploy in this conversation. `cdk-blocks dev`, the app's build and `cdk synth` need no AWS account. When the user asked for a deploy, read `cdk-blocks blockify-app guide deploy` first.
- Leave commits and branches to the user unless they asked for them. Leave the changes in the working tree.
- Keep secret values out of the repository, out of `MIGRATION.md` and off command lines. Name each value the user must supply.

## Fixed decisions

These settle questions the block documentation leaves open. Follow them without deciding again.

- Integrate AWS Blocks into the existing repository. A separate new app that the frontend is moved into loses the history and the app's own tooling.
- One backend, in `aws-blocks/`. Code that uses a Building Block (database, auth, files, jobs, settings) runs in the Blocks backend, as `ApiNamespace` methods, `RawRoute` handlers or job handlers. Server code of the frontend framework (Next.js server components, route handlers, server actions, a Nitro server) runs in a different Lambda function that has no access to the blocks: it calls the backend through `import { api } from 'aws-blocks'`.
<!-- when: data -->
- Relational data that the app keeps in its own PostgreSQL, MySQL or SQLite database goes to the `Database` block (Aurora Serverless v2 PostgreSQL on AWS, PGlite locally), with `minCapacity: 0` so that an idle app costs nothing for compute. Keep the schema: the same tables, columns, types and ids, written as SQL migrations in `aws-blocks/migrations/`. The other data blocks (`DistributedTable`, `DistributedDatabase`) change the data model, so use one only when the user asked for it. Details: guide `database`.
<!-- end -->
<!-- when: key-value -->
- Key-value data (Vercel KV, Upstash, Redis used as a cache, counters or expiring keys) goes to `KVStore`, or to `Database` when the app needs exact counters or queries. Details: guide `key-value`.
<!-- end -->
<!-- when: in-memory-state -->
- Data that server code keeps in a module-level `Map` or `Set` between requests (a cart, sessions, a rate limit, a counter) is lost on AWS: each request can run in another function instance, and instances are recycled. Move it to `KVStore`, or to `Database` when it needs queries or exact counters. The local server is one process, so no local check shows the loss. A collection that is filled once from constants stays, and so does a cache whose loss only costs time. Details: guide `aws-limits`, row "No shared memory", and guide `key-value`.
<!-- end -->
<!-- when: auth -->
- Sign-in that the app runs itself (Auth.js, better-auth, Clerk, Passport, sessions) is replaced by the `Auth` block. Passwords cannot be copied to it, so existing users sign up again or reset their password: record that under "After deploy". Details: guide `auth`.
<!-- end -->
<!-- when: supabase -->
- What Supabase hosts stays on Supabase: `supabase.auth`, tables read with `supabase.from()`, Storage and Realtime. The migration moves the hosting and the app's own server code only. No `Auth`, `Database`, `FileBucket` or `Realtime` block replaces them, and no data or user is moved. Details: guide `supabase`.
<!-- end -->
<!-- when: ssr -->
- A server-rendered app stays server-rendered, with the same framework and the same major version. Server functions of the framework that use no Building Block keep running unchanged in the framework's server bundle. `Hosting` runs the server of Next.js, Nuxt and other Nitro frameworks, Astro and SvelteKit. When the app's framework is another one, do not turn its server rendering off to make it fit (a single-page or prerendered build): that changes how the product renders and loads its data, so it is the user's decision, also when you were told to decide for yourself. Ask before the scaffold task; when you cannot ask, stop there with the question under "Blockers" in `MIGRATION.md`, and change no other file.
<!-- end -->
<!-- when: server-rendered-views -->
- Pages that the app's own server renders (a view engine, `res.render`). `Hosting` does not run that server: it serves built files, and it runs only the server of Next.js, Nuxt, Astro, SvelteKit or Nitro.
  - A rendered page at any path except `/` stays what it is as a `RawRoute`: the same path, the same HTML, `Content-Type: text/html; charset=utf-8`. Put its template into the handler's module as a string. The backend is bundled into one file of code, and a template file that the server reads from disk is not in it. Guide `api-routes`.
  - A `RawRoute` cannot answer `/`. When the server renders the page at `/`, no option keeps it rendered on a server. The replacement is a static page that loads its data in the browser, and that changes the product: the page then needs JavaScript, and crawlers and link previews see no data. Do not make this choice for the user, also when you were told to decide for yourself or to work without asking: that instruction covers how to migrate, not what the product becomes. Ask before the scaffold task. When you cannot ask, stop there: write `MIGRATION.md` with the plan you would carry out, name this decision under "Blockers" with both options (the static page; or the user first moves the pages to a framework that `Hosting` runs on a server), change no other file, and tell the user. Go on only when the user has already said, in this conversation, which option they want.
  - When the user chose static pages, the rest follows the usual rules of guide `api-routes`: a route that only that page calls can become a method, and a URL that something outside the app calls stays where it is. The server file and its templates are code that the migration replaced: delete them.
<!-- end -->

## Preserve behavior

Migrate the hosting and the server runtime, not the product.

- Keep the rendering mode. A single-page app stays one, a static or prerendered site stays static, a server-rendered app stays server-rendered.
- Keep every URL the app serves today reachable at the same path with the same statuses, including API routes that nothing in the repository calls: callers outside the repository may use them.
- Keep third-party services the app already calls (payment, email, analytics, CMS, form services). Their keys move to secrets; the calls stay.
- When two options are open, take the one that keeps current behavior and write the choice into the task. Ask the user only when no option keeps current behavior; if you cannot ask, record a blocker and continue with the rest.
- Keep versions: stay on the framework's major version, and upgrade a minor or patch version only when a tool's supported range requires it. Record each upgrade in `MIGRATION.md`.

## Out of scope

Leave these out of the plan. They are not tasks, blockers or steps for the user.

- New features, new tests, refactors, and dependency upgrades the migration does not need.
- Custom domains, DNS, certificates, the target account and Region: the user decides them at deploy time.
- Optional tuning the app does not need to run (price class, logging, monitoring, retention, alarms).
- The existing deploy path and CI (Vercel, Netlify, GitHub Pages, Docker files, workflows). Leave them in place; the user retires them.
- Cleaning up code the migration did not replace: unused components, old schema files, old deploy scripts. They stay for the user to prune. Code that a task replaced is different: that task deletes it, as "Backend tasks" says.

## Surfaces

Cover the surfaces this app has. Tag each task with the surface it migrates.

- `hosting`: the frontend and its server rendering → the `Hosting` construct in `aws-blocks/index.cdk.ts`. Every app has this surface.
- `api`: HTTP routes and server functions. Three choices for each route, in guide `api-routes`: keep it as the framework's own route when it uses no Building Block; make it an `ApiNamespace` method when the app's own frontend calls it; make it a `RawRoute` when an outside caller needs the exact URL, the raw body or a custom status (webhooks, OAuth callbacks, health checks). Callers in the frontend change with it: guide `client-wiring`.
- `data`: relational data and ORM usage → `Database`. Guide `database`. Key-value data → guide `key-value`.
- `auth`: sign-in, sessions, route protection → `Auth`. Guide `auth`.
- `storage`: uploaded or generated files, writes to the local disk → `FileBucket`. A Lambda function keeps no files between requests. Guide `file-uploads`.
- `jobs`: scheduled work (`vercel.json` crons, cron libraries, timers) → `CronJob`; work that outlives a request → `AsyncJob`. Guide `jobs`.
- `secrets`: every environment variable the server reads → a secret or setting the deployed app can read, plus one step for the user per value. Guide `secrets`.
- `ai`: calls to an LLM provider. Guide `ai`.

Prefer a Building Block to hand-written `aws-cdk-lib` constructs wherever one exists. Limits that change how an app must work on AWS (payload size, request time, no local disk) are in guide `aws-limits`.

## Plan and report: `MIGRATION.md`

Write this file first and keep it current. It is the plan while you work and the handover when you finish.

```markdown
# Migration to AWS Blocks

## Plan
### 1. Migrate backend
- [ ] scaffold: add AWS Blocks to the repository
- [ ] data: <what moves where>
- [ ] auth: <what replaces what>
- [ ] api: <route group> → <ApiNamespace | RawRoute | kept>
### 2. Migrate frontend
- [ ] hosting: Hosting block for <framework, rendering mode>
- [ ] api: call sites of <route group> use the Blocks client
### 3. Validate
- [ ] validate: install, local server, build, synth, check

## Blockers
<what could not be migrated, why, and what the user must decide; "None" when there are none>

## Before deploy
- [ ] secret: <NAME> is <what it is>, read by <where>; set it with <the exact command from guide `secrets`>
- [ ] build-config: <public build-time value the deploy environment must provide>
- [ ] code: <a value only the user knows that the code needs, and the file and line that take it>
- [ ] account: <a one-time step in the AWS account, for example a bootstrap in a second Region>

## After deploy
- [ ] secret: <NAME> is <what it is>, read by <where>; set it with <the exact command or console step from guide `secrets`>
- [ ] external-service: <what to change at which provider, for example a callback URL>
- [ ] user-migration: <what existing users must do>
- [ ] data-copy: <which data to copy from where>

## Validation
| Check | Command | Result |
|---|---|---|
```

- Phases follow the layers in dependency order: backend first (scaffold, then data, auth, API, storage, jobs, secrets), then frontend (hosting, call sites, sign-in UI), then validate. Leave out a phase or task the app has no surface for. An app with no backend surface has two phases: the scaffold and hosting tasks, then validate.
- One task per surface. Split a surface only when it is large: group routes by resource or router file, at most about 8 routes per task. One task per route is too fine.
- A step under "Before deploy" or "After deploy" is something only the user can do. Give its kind, the exact name, what it is, and where the app reads it.
  - "Before deploy": the step needs nothing from the deployed stack, and without it the first deploy stops or the deployed app is broken from its first request. A value that the deploy checks or that the build inlines, a placeholder in the code, a one-time step in the AWS account.
  - "After deploy": the step needs something that the first deploy creates (the app's URL, a secret or a bucket that the stack creates), or it concerns production data and users.
  - Each guide names the section for the steps it asks for. A step in the wrong section costs the user a failed deploy.
  - Write only steps. Leave out a kind the app has no step for, and write "None" under a section that has no step. Config of a provider that the migration replaced is deleted from the code; it gets no step, and neither does a variable that nothing reads any more.

## Scaffold task

The first task. It produces the layout every later task depends on.

1. The scaffolder needs a root `package.json`. A repository without one (hand-written HTML, Hugo, Jekyll) gets `{ "name": "<app-name>", "private": true, "version": "0.0.0" }` first, and a `node_modules/` line in `.gitignore`: the scaffolder adds its own entries to that file, not this one.
2. Keep one lockfile, the one of the package manager the app uses, and remove the others. Two lockfile formats stop the deploy-time bundling with `MultipleLockFilesFound`. Guide `package-managers` covers pnpm, Yarn, Bun and monorepos.
3. From the directory of the app, run the scaffolder once. In a monorepo that is the package that holds the app (`apps/web`), not the workspace root: guide `package-managers`, section "Monorepos".

   ```bash
   npx -y @aws-blocks/create-blocks-app@latest . --template <template> --yes --skip-install
   ```

   `--template nextjs` for a server-rendered Next.js app, `--template default` for every other app. The dot makes it integrate into the existing project. It creates `aws-blocks/` (`index.ts`, `index.cdk.ts`, `index.handler.ts`, `package.json`), `cdk.json` and `.blocks/config.json`, and it adds the `aws-blocks` workspace, the Blocks dependencies, the `cdk-blocks` scripts and `.gitignore` entries to the project. Let it write these files; when `aws-blocks/` or `cdk.json` already exists, stop and tell the user.
4. Add what the scaffolder leaves out when it integrates into an existing project:
   - `aws-cdk` (the CDK command line, `^2`) in the root `devDependencies`. Without it `npx cdk` runs whatever `cdk` is on `PATH`, and an older one fails with `Cloud assembly schema version mismatch`.
   - `typescript` (`^5`) in the root `devDependencies` when the project has none.
   - For pnpm, the `aws-blocks` entry under `packages:` in `pnpm-workspace.yaml`: pnpm does not read the `workspaces` field the scaffolder writes.
5. Replace the demo backend in `aws-blocks/index.ts` with the app's own: `new Scope('<app-name>')`, then the blocks and API namespaces the later tasks add. Write the scope id with letters, digits and hyphens only (`acme-shop` for a package named `@acme/shop`): it is part of the name of every AWS resource of the backend. Any other character passes the local server and synth, and the deploy fails on the first table. An app with no backend surface keeps only the scope. Export only `ApiNamespace` instances (and `authApi`) from this file: an exported function or plain object becomes a public remote endpoint.
6. Keep `aws-blocks/package.json` as written: its `"type": "module"` and `exports` map make `import { api } from 'aws-blocks'` and synth work. Leave the root `package.json` `"type"` as the app has it.
7. Check `.blocks/config.json`: `stackId` names the deployed stacks. When the root package name is generic (`app`, `my-app`, `my-project`, `workspace`), replace the name part of `stackId` with the app's name and keep the 6-character suffix. Keep this file in git.
8. Install with the app's package manager, then confirm `npx --no -- cdk-blocks --version` prints a version.

Scripts after the scaffold: `npm run dev:server` runs `cdk-blocks dev` (the Blocks backend on local mocks plus the app's own dev server, on http://localhost:3000); the app's own `dev`, `build` and `start` scripts stay as they were.

## Hosting task

Always its own task, after the scaffold. Edit the `Hosting` block in `aws-blocks/index.cdk.ts`; keep the rest of the file, including the `HostingPresets` spread and the sandbox conditions. Decide each property from the repository and set no others:

- `framework`: `'nextjs'`, `'nuxt'`, `'astro'`, `'sveltekit'` or `'nitro'` for an app that renders on a server with that framework; `'spa'` for a client-routed app (unknown paths answer with `index.html`); `'static'` for one file per route (hand-written HTML, or a static export or prerendered build such as Next.js `output: 'export'`, Astro static, Docusaurus; unknown paths answer 404). SvelteKit is hosted through `@sveltejs/adapter-node`: synth refuses a `svelte.config.js` that names another adapter (`adapter-vercel`, `adapter-auto`), so switch the config to `adapter-node` and declare the package.
- `buildCommand`: the build, run from the directory of the app through the package manager (`npm run build`). The deploy runs it, so it must not depend on tools that are only on your `PATH`. Leave it out for a site with no build.
- `buildOutputDir`: for `'spa'` and `'static'`, the directory the build writes that holds `index.html`, relative to the directory of the app (`dist`, `out`, `build`). It must be a subdirectory. Of the server-rendering frameworks only Nuxt and other Nitro apps need it: `'.output'`. Without it synth looks for `dist` and stops with `Build output directory not found`.
- Nuxt, and any other Nitro app: turn on response streaming for its Lambda handler, `nitro: { awsLambda: { streaming: true } }` in `nuxt.config.ts` (`awsLambda: { streaming: true }` in `nitro.config.ts`). `Hosting` invokes the server with response streaming. Without the setting the deploy succeeds, and every page and every server route answers 502. The build, synth and the local server do not show it; `blockify-app check` does. One cost: `npm run sandbox:preview` then stops at synth with `StreamingServerNeedsStreamingDoorError`, because the door of a preview sandbox does not stream. Leave the setting on, whatever that error suggests, and say in `MIGRATION.md` that the preview sandbox is not available for this app.
- Astro that renders on a server, when `astro.config` names an adapter (`adapter: node(…)`): make the build, and only the build, bundle every package into the server output. `Hosting` uploads `dist/server` without the app's `node_modules`, and builds a config that names an adapter as it is, so a server that imports a package exits at start (`Cannot find package …`), and every page answers 502 after a deploy that succeeded. Add this entry to `integrations` in `astro.config`:

  ```js
  {
    name: 'bundle-server-dependencies',
    hooks: {
      'astro:config:setup': ({ command, updateConfig }) => {
        if (command === 'build') updateConfig({ vite: { ssr: { noExternal: true } } });
      },
    },
  },
  ```

  Do not set `vite.ssr.noExternal: true` for every command: `astro dev` then fails with `require is not defined`, and every page of the local server hangs. The local server does not show the missing packages. `blockify-app check --server`, in the validate task, starts the server from a copy of what the deploy uploads and does.
- `basePath`: only when the app is served under a sub-path, equal to the framework's own base path setting.
- The local server: `cdk-blocks dev` starts the dev server of Next.js and of Vite by itself. For any other framework, name the app's own dev command in the root `package.json`, on the port the local server proxies to: `"blocks": { "dev": { "frontendCommand": "npx astro dev --port 3100", "frontendPort": 3100 } }`. The command must name that port itself: `cdk-blocks dev` runs it as written and hands it no port. Without a command the local server runs the backend only and answers 404 for every page. A site with no dev server of its own (hand-written HTML) has no command to name: its pages are not served locally. Say so in `MIGRATION.md`, and do not tell the user that `npm run dev:server` shows the site.
- Write the command for the user's terminal, not for your own session. Some dev servers return at once and keep running in the background when a coding agent starts them (Astro 7 does); the local server then starts them again and again. Keep the plain command in `package.json`. For your own check, start the Blocks backend with `npx --no -- cdk-blocks dev --no-frontend` and the framework's dev server beside it.
<!-- when: nextjs -->
- Next.js: read guide `nextjs` before this task. It gives the OpenNext package to declare and the versions that work with each Next.js version, the properties for a static export, and what happens to middleware, edge routes, ISR, `next/image` and `vercel.json`.
<!-- end -->

The generated client, `aws-blocks/client.js`, is not in git. A build needs it only when frontend code imports `aws-blocks`; when no file does, leave the `build` script as it is.

- Next.js, and every app that `Hosting` serves as `'spa'` or `'static'`: `"build": "cdk-blocks generate client && <the app's build>"`.
- `'astro'`, `'nuxt'`, `'nitro'` and `'sveltekit'`: keep the `build` and `prebuild` scripts free of it, and start the `Hosting` `buildCommand` with it instead: `buildCommand: 'npx --no -- cdk-blocks generate client && npm run build'`. For these frameworks the deploy runs the `build` script a second time with CDK's Node condition set, and the generator fails there with `Scope … should be created in the scope of a Stack`. A plain `cdk synth` does not show it; step 4 of "Validate task" does.

Add every directory the build and synth write (`.open-next/`, `.hosting/`, `cdk.out/`, the build output) to `.gitignore`.

## Backend tasks: data, auth, API, storage, jobs, secrets

Write these rules into the tasks they apply to.

- Layout: `aws-blocks/index.ts` creates the scope and exports the API namespaces. When the backend grows past one file, put shared blocks (`scope`, `db`, `auth`, buckets, settings) in `aws-blocks/resources.ts` and each route group in its own module that imports from there; `index.ts` re-exports the namespaces.
- Construct blocks at module scope. Call their methods only inside handlers: a block method that runs while the module loads throws during `cdk synth`.
- Every `ApiNamespace` method is a public endpoint. Start each method that needs a signed-in user with `const user = await auth.requireAuth(context)`, and keep public what was public before.
- Routes become methods: `res.json(data)` becomes `return data` with the same field names; `res.status(code).json({ error })` becomes `throw new ApiError(message, code)` from `@aws-blocks/blocks`, which the client rethrows with the same `.status`. A plain `Error` reaches the client as a 500.
- Read a header the server needs from `context.request.headers`. A value the server used to read for itself (user agent, IP, token) must not become a method argument.
- Dependencies of backend code go into `aws-blocks/package.json`; dependencies of the frontend stay in the root `package.json`.
- Environment: replace each `process.env.NAME` the server reads as guide `secrets` says, and delete reads of config that belonged to a replaced provider.
- Delete what a task replaced, in that task: the old route handlers and server actions, the old client or storage module, and the packages and environment variables that only they used. A route file, a page or a middleware that stays in the framework's directories is still served after the deploy, without the guard or the data it relied on. Say in the task what was deleted.

## Frontend tasks

- Replace each call to an API route that became a method with `api.method(args)` from `import { api } from 'aws-blocks'`. The method returns the parsed result, so the `fetch`, `.json()`, status checks and headers around the old call go away. Guide `client-wiring`.
- In browser code, import Blocks helpers only from `@aws-blocks/blocks/client` and `@aws-blocks/blocks/ui`. The package root has nothing for the browser.
- Replace the sign-in UI only when auth changed. Keep the app's look: build the forms with the app's own components on top of `authApi`. Guide `auth`.
- Leave `BLOCKS_API_URL` unset everywhere. The dev server, the sandbox and the deploy each provide the API location; a value you set makes the local server proxy to it.

## Validate task

The last task. Each step catches failures the others cannot.

1. Install with the app's package manager.
2. Run the local server and use the app. Start `npx --no -- cdk-blocks dev` in the background (`--port <n> --frontend-port <m>` when 3000 or 3100 is taken), wait for `local server running`, then request the home page and at least one URL per migrated surface, and call each group of API methods once the way the app does (through its pages, or with a JSON-RPC request: `POST /aws-blocks/api` with `{"jsonrpc":"2.0","id":1,"method":"api.<method>","params":[...]}`). A status below 500 on every page, and the right data from every surface, is a pass. The home page must answer 200 with the app's own page: a 404 there means the local server started no frontend, and "Hosting task" says how to name one. Only a site with no dev server of its own is exempt; check its pages in step 4, where every page and asset must be in `buildOutputDir`. A 500 is a failed step, also when a value that is not set explains it. A page that required sign-in before must still refuse a request without a session: expect the redirect to sign-in, not a 200. A route that compares a request against a secret must answer as the original did in three cases. First with the secret not configured at all, which is the state of a fresh clone: start the server while `.env.local` has no entry for it and request the route. The original usually answered 401; `getSecret` throws there, so the route needs the `try`/`catch` that guide `secrets` describes. Then put a made-up test value in `.env.local`, restart the server, and request the route with a wrong value and with the right one. Read the server output for errors of the backend and of the frontend dev server. Stop it with `npx --no -- cdk-blocks dev stop`. The local server loads `aws-blocks/index.ts` for real, so it finds wrong imports, block names and options that the build does not.
   A 200 is not yet the page. Astro, Nuxt, SvelteKit and Next.js send the status and the top of the page before a component further down has run, so a page whose server code throws answers 200 and stops in the middle. For each page you request, look for a text from its lower half that the original shows (the last product of a list, the footer), once without any cookie, as a first-time visitor, and once as a signed-in one when the app has sign-in.
3. Build: `npm run build`.
4. Synthesize the way a deploy does: `NODE_OPTIONS=--conditions=cdk npx --no -- cdk synth -q`. `cdk-blocks deploy` sets that variable, and the hosting build of some frameworks behaves differently under it, so a plain `cdk synth` can pass where the deploy stops. Synth runs the hosting build and bundles the backend, and needs no AWS account. Warnings about monitoring, access logging and the stack Region are information.
5. Run `npx --no -- cdk-blocks blockify-app check --server` and fix what it reports. It reads the migrated files, and it starts the server function that the synth of step 4 wrote, from a read-only copy of the directory that the deploy uploads. A server that lacks a package it imports, or a handler that buffers its response where the deploy invokes it with response streaming, passes steps 1 to 4, deploys without an error, and answers 502 on every path. An app that is served as files has no server function and passes.
6. Make no file change after the final build and synth. When one is needed, run both again.

Repair rules:

- When a step fails, fix the cause and run the same step again. Do not make a failure go away by deleting a feature, widening a type to `any`, adding `@ts-ignore`, dropping a dependency or removing the check.
- Errors the original code already had (a type error in a file you did not change) stay as they are; list them in `MIGRATION.md`.
- A step that fails only because a value that only the user holds is missing (an API key of a third-party account, a project URL) is not a code defect. Add no placeholder; record the step as not run and name the value. A secret that the app itself defines (a shared secret for a webhook or a cron route, a signing key) is not such a value: test with a made-up one in `.env.local`.
- After 5 attempts at the same failure, keep the code, run the remaining steps, and record the failure under "Blockers" with the exact error.

## Finish

Complete `MIGRATION.md`: every task ticked or explained, "Blockers", "Before deploy" and "After deploy" with one line per value or action, and the "Validation" table with the command and result of each step. Then tell the user, in a few lines: what moved where, what they must do before the first deploy and after it, and the two commands that come next: `npm run dev:server` to run it locally, and `npm run deploy` when they are ready to deploy.
