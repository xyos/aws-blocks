---
name: migrate-to-aws-blocks
description: Moves an existing web app onto AWS Blocks in the same repository - hosting, API routes, database, sign-in, file uploads, scheduled jobs and secrets. Use when the user asks to migrate, move, port or deploy an existing app (Next.js, a Vite or other single-page app, a static site, an Express-style server, an app on Vercel, Netlify, Replit or Supabase) to AWS with AWS Blocks, or to add AWS Blocks hosting to an app that was built without it. Not for creating a new AWS Blocks app, and not for upgrading an app that already runs on AWS Blocks.
license: Apache-2.0
compatibility: Requires Node.js 22 or later, the app's package manager, git, and network access to the npm registry. Deploying needs AWS credentials; the migration itself does not.
metadata:
  package: "@aws-blocks/blocks"
---

# Migrate an app to AWS Blocks

You move an existing web app onto AWS Blocks in place: the same repository and the same product, on a new hosting and server runtime. The work is a plan you write for this repository, carried out and then proved with the local server, the build and a CDK synth. You do not deploy unless the user asked for it.

## Start

1. In the root of the app, run the playbook command. It reads the repository, changes nothing, and needs no installed dependencies and no AWS account:

   ```bash
   npx -y -p @aws-blocks/blocks cdk-blocks migrate playbook
   ```

   It prints what it detected (framework, rendering mode, package manager, and the data, sign-in, storage, job and secret surfaces, each with the file that shows it), the procedure with the sections that apply to this app, and the guides to read first. Follow that output: it comes from the version of AWS Blocks the app will install, so it is the current text when it differs from this skill's copy.
2. If the command says the app cannot be migrated as it is, stop: tell the user the reason and what they can do about it. Do not remove the blocker yourself, for example by upgrading the framework to a new major version. That changes the product, so it is the user's decision, also when you were asked to work without asking.
3. If the command cannot run (no network access, or a published version without the command), read [the playbook](references/playbook.md) in this skill and follow it. A line between `<!-- when: … -->` and `<!-- end -->` applies only to an app that has that surface.

## Commands

Once the scaffold task has installed `@aws-blocks/blocks` in the app, run the commands as `npx --no -- cdk-blocks …`:

- `cdk-blocks migrate playbook`: the procedure for this app. Run it again after a long pause to re-read it.
- `cdk-blocks migrate guide <name>...`: one or more of the guides below, in full. Without a name it lists them.
- `cdk-blocks migrate check`: checks the migrated files against the playbook's rules. Run it in the validate task and fix what it reports.

## Guides

Each guide covers one surface: what it becomes on AWS Blocks, what differs between the local server and AWS, and what to record for the user. Read a guide before you write the task for its surface.

| Guide | Read when the app |
|---|---|
| [nextjs](references/nextjs.md) | uses Next.js |
| [api-routes](references/api-routes.md) | has HTTP endpoints: route handlers, an Express-style server, server actions, webhooks |
| [client-wiring](references/client-wiring.md) | has frontend code that calls its own API |
| [database](references/database.md) | stores data in PostgreSQL or another SQL database, through an ORM or a driver |
| [key-value](references/key-value.md) | uses Vercel KV, Upstash or Redis |
| [auth](references/auth.md) | signs users in itself: Auth.js, better-auth, Clerk, Passport, sessions |
| [file-uploads](references/file-uploads.md) | accepts, stores or serves files, or writes to the local disk |
| [jobs](references/jobs.md) | runs scheduled or background work: `vercel.json` crons, cron libraries, timers, queues |
| [secrets](references/secrets.md) | reads environment variables on the server or at build time |
| [ai](references/ai.md) | calls an LLM provider |
| [supabase](references/supabase.md) | uses Supabase |
| [package-managers](references/package-managers.md) | uses pnpm, Yarn or Bun, or is part of a monorepo |
| [aws-limits](references/aws-limits.md) | moves large payloads, streams responses, holds connections open, or runs long requests |
| [deploy](references/deploy.md) | is to be deployed now, because the user asked |

After the install, the documentation of every Building Block is in `node_modules/@aws-blocks/blocks/docs/<package>/README.md`. Confirm each block name, option and method there before a task depends on it.

## Rules for every migration

- Write the plan into `MIGRATION.md` at the repository root first, and finish by completing it: blockers, the steps only the user can do before and after the first deploy, and the result of each validation step.
- Keep behavior: the same rendering mode, the same URLs and statuses, the same third-party services, the same major version of the framework.
- When nothing keeps a behavior (a page that the app's own server renders at `/` is the known case), what replaces it is the user's choice, also when you were told to work without asking. Ask, or stop before the scaffold with the question under "Blockers" in `MIGRATION.md`.
- Code that uses a Building Block runs in the backend in `aws-blocks/`. The framework's own server code calls it through `import { api } from 'aws-blocks'`.
- Stay local: no deploy and no command that needs an AWS account unless the user asked. Keep secret values out of the repository, out of `MIGRATION.md` and off command lines.
- Fix the cause of a failed step. Deleting a feature, widening a type or removing a check to get past it is not a fix.
