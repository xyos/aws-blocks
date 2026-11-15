---
'@aws-blocks/blocks': minor
'@aws-blocks/create-blocks-app': patch
---

Add `cdk-blocks migrate playbook`, `migrate guide`, `migrate check` and `migrate skill`, for a coding agent that moves an existing app (Next.js, Nuxt, Astro, SvelteKit, a single-page app, a static site, an app with its own Node.js server) onto AWS Blocks in the same repository.

`cdk-blocks migrate playbook` runs in the root of an app that is not on AWS Blocks yet and changes no file. It prints what it detected (framework, rendering mode, package manager, and the API, data, sign-in, storage, job and environment-variable surfaces, each with the file that shows it), the procedure for this app, and the guides to read first. From `.env` files it reads variable names only. It exits 1 with the reason and the fix when the app cannot be migrated as it is: a server-rendered Next.js app on a major version below the range the hosting build supports, or a React Router app in framework mode that renders on a server. For an app whose own server renders the page at `/`, which `Hosting` cannot run, the playbook tells the agent to ask you what the page becomes before it changes a file. In a monorepo it runs in the package that holds the app.

`cdk-blocks migrate guide [name...]` prints one guide per topic (`nextjs`, `api-routes`, `client-wiring`, `database`, `key-value`, `auth`, `file-uploads`, `jobs`, `secrets`, `ai`, `supabase`, `package-managers`, `aws-limits`, `deploy`). `cdk-blocks migrate check` checks a migrated app's files against the playbook's rules and exits 1 when one fails; it runs no build and no synth. Both, and `playbook`, take `--output json`.

The playbook and the guides ship in the package as an Agent Skill, `skills/migrate-to-aws-blocks/`. `cdk-blocks migrate skill <dir>` copies it into a skills directory such as `.claude/skills`.

`create-blocks-app`, when it adds AWS Blocks to an existing project, now ends its output with a pointer to `cdk-blocks migrate playbook`.

`cdk-blocks migrate` without a subcommand is unchanged. Outside an AWS Blocks app, its error now also points to `cdk-blocks migrate playbook`.
