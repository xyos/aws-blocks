---
'@aws-blocks/blocks': minor
'@aws-blocks/create-blocks-app': patch
---

Add `cdk-blocks blockify-app playbook`, `blockify-app guide`, `blockify-app check` and `blockify-app skill`, for a coding agent that moves an existing app (Next.js, Nuxt, Astro, SvelteKit, a single-page app, a static site, an app with its own Node.js server) onto AWS Blocks in the same repository.

`cdk-blocks blockify-app playbook` runs in the root of an app that is not on AWS Blocks yet and changes no file. It prints what it detected (framework, rendering mode, package manager, and the API, data, sign-in, storage, job and environment-variable surfaces, each with the file that shows it), the procedure for this app, and the guides to read first. From `.env` files it reads variable names only. It exits 1 with the reason and the fix when the app cannot be migrated as it is: a server-rendered Next.js app on a major version below the range the hosting build supports, or a React Router app in framework mode that renders on a server. For an app whose own server renders the page at `/`, which `Hosting` cannot run, the playbook tells the agent to ask you what the page becomes before it changes a file. In a monorepo it runs in the package that holds the app.

`cdk-blocks blockify-app guide [name...]` prints one guide per topic (`nextjs`, `api-routes`, `client-wiring`, `database`, `key-value`, `auth`, `file-uploads`, `jobs`, `secrets`, `ai`, `supabase`, `package-managers`, `aws-limits`, `deploy`). `cdk-blocks blockify-app check` checks a migrated app's files against the playbook's rules and exits 1 when one fails; it runs no build and no synth. Both, and `playbook`, take `--output json`.

`cdk-blocks blockify-app check --server`, run after `cdk synth`, also starts each server function that the synth wrote for `Hosting`, from a read-only copy of the directory that the deploy uploads and without AWS. It fails for a server that exits at start because a package it imports is not in that directory, and for a handler that buffers its response where the template invokes it with response streaming: both deploy without an error and answer 502 on every path.

The playbook and the guides ship in the package as an Agent Skill, `skills/migrate-to-aws-blocks/`. `cdk-blocks blockify-app skill <dir>` copies it into a skills directory such as `.claude/skills`.

`create-blocks-app`, when it adds AWS Blocks to an existing project, now ends its output with a pointer to `cdk-blocks blockify-app playbook`.
