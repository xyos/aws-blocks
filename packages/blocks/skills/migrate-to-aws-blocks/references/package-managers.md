# npm, pnpm, Yarn and Bun

> Read when: the app uses pnpm, Yarn or Bun, has more than one lockfile, has a `preinstall` guard, or is a package inside a monorepo.

## Rules that apply to every package manager

- Keep the package manager the repo already uses. Detect it from the `packageManager` field in `package.json`, then from the lockfile.
- Node.js 22 or later (the templates declare `"engines": { "node": ">=22.0.0" }`).
- `npm` and `npx` must be on `PATH` in every case. `cdk.json` runs the CDK app with `npx tsx …`, the sandbox commands run CDK and the app through `npm exec`, and the CLI itself is run as `npx --no -- cdk-blocks <command>`.
- The templates and their end-to-end tests use npm; AWS Blocks has no automated coverage of pnpm, Yarn or Bun. With another manager, apply the sections below and validate with the synth of the playbook's validate task, which runs the build and the bundling that a deploy runs. Record the manager in `MIGRATION.md`.
- Keep `tsx` and `esbuild` in the root `devDependencies` (the scaffold adds them). Synth needs both.

## What the scaffold writes

`npx -y @aws-blocks/create-blocks-app . --template <name> --yes --skip-install`:

- Adds `"aws-blocks"` to `workspaces` in the root `package.json`. An existing array gets the entry appended. A Yarn classic object (`{ "packages": [...], "nohoist": [...] }`) is replaced by the bare `packages` array, so `nohoist` is lost: restore the object form by hand when the repo used `nohoist`.
- Adds `@aws-blocks/blocks`, `aws-cdk-lib`, `constructs`, `tsx`, `esbuild` and `@types/node`. It does not add the `aws-cdk` package (the `cdk` command); the templates carry it in `devDependencies`. Add `"aws-cdk": "^2"` to `devDependencies` when the repo lacks it, so that `npx cdk synth` runs the project's own CLI.
- Writes no `pnpm-workspace.yaml` and no Yarn or Bun configuration.
- Without `--skip-install` it runs `npm install`. In a pnpm, Yarn or Bun repo that creates a `package-lock.json` (a second lockfile) and trips an `only-allow` guard. Pass `--skip-install`, then install with the repo's manager.

## Wire the `aws-blocks` workspace

The frontend imports `aws-blocks` by package name. The import resolves when the package manager links the `aws-blocks/` folder into `node_modules`.

| Manager | Where the workspace is declared | Dependency entry in the importing package |
|---|---|---|
| npm | `workspaces` in `package.json` (scaffold) | none needed; npm links every workspace at the root |
| Yarn 1 | `workspaces` array or object in `package.json` | none needed |
| Yarn 2+ | `workspaces` in `package.json` | `"aws-blocks": "workspace:*"` |
| pnpm | `packages:` in `pnpm-workspace.yaml`; pnpm does not read `workspaces` | `"aws-blocks": "workspace:*"` |
| Bun | `workspaces` in `package.json` | `"aws-blocks": "workspace:*"` |

```yaml
# pnpm-workspace.yaml: keep the existing keys, add the entry
packages:
  - aws-blocks
```

- The table rows other than npm are general package-manager behavior, not behavior that AWS Blocks tests. Confirm with the check below.
- Check after the install: `node -e "console.log(require.resolve('aws-blocks/package.json'))"` from the package that imports it prints a path inside the repo.
- Keep `aws-blocks/package.json` as scaffolded. Its `"type": "module"` and `exports` map are what make `import { api } from 'aws-blocks'` resolve to the generated client.

## One lockfile

- The backend Lambda function is a CDK `NodejsFunction`. At synth, CDK looks for `pnpm-lock.yaml`, `yarn.lock`, `bun.lock`, `bun.lockb` and `package-lock.json` in the working directory, then in each parent, and uses the first directory that has one.
- Two or more in that directory stop synth and deploy with `MultipleLockFilesFound: Multiple package lock files found: … Please specify the desired one with depsLockFilePath`. None in any parent stops them with `Cannot find a package lock file`.
- Keep the lockfile of the repo's manager and delete the others, including a stale `package-lock.json` beside a `pnpm-lock.yaml`. Run the install once so that the lockfile exists before the first synth.
- The lockfile also selects the command that CDK runs esbuild with: `pnpm exec esbuild`, `yarn run esbuild`, `bun run esbuild`, or `npx --no-install esbuild` for `package-lock.json`. That binary must be on `PATH` in the shell that runs synth and deploy. A leftover lockfile of another manager therefore fails on a machine without that manager.
- CDK bundles locally when it can resolve `esbuild` from the project. When it cannot, it falls back to a Docker build, which fails on a machine without Docker. Check that the command for your lockfile (previous bullet) prints a version with `--version` appended. When it does not, fix the install with the repo's manager instead of removing `esbuild`.
- pnpm and the build scripts of dependencies. `esbuild` runs without its script, under pnpm 10 and pnpm 11: `pnpm exec esbuild --version` prints a version either way. So never allow it, and add no script that repairs it.
  - pnpm 10 skips those scripts and prints `Ignored build scripts: esbuild, …` after the install. That message needs no action. For a package that does need its script, list it under `onlyBuiltDependencies:` in `pnpm-workspace.yaml` and run `pnpm rebuild <name>`.
  - pnpm 11 stops the install with `ERR_PNPM_IGNORED_BUILDS` until every such dependency has a decision under `allowBuilds:` in `pnpm-workspace.yaml`. Write `esbuild: false` there. For any other package that the error names, keep what the repository did before the migration.
  - `pnpm approve-builds` asks its questions on a terminal, so it cannot run unattended.
- The backend bundle is one file that esbuild produces (minified, with the `aws-runtime` condition). It does not copy `node_modules`, so the backend needs no hoisted or flat `node_modules` layout.

## Which manager the deploy-time build uses

- `Hosting` runs `buildCommand` once at synth and deploy with `execSync`, through the system shell, in the Hosting `root`, with the environment of the deploy process. The command finds exactly what that shell finds on `PATH`.
- AWS Blocks does not call corepack and does not read `packageManager`. For a pnpm repo, `buildCommand: 'pnpm run build'` works where `pnpm` is on `PATH` (for example after `corepack enable`), and `'npm run build'` works everywhere because `npm run` only starts the script. Choose the form that the deploy machine supports and record the requirement in `MIGRATION.md`.
- A failed build stops the deploy with `Frontend build failed: <buildCommand>` followed by `Ensure the build command is correct and all dependencies are installed.` The real error is in the build output above that line.
- The build receives `BLOCKS_API_URL` when Hosting has an `api`, and `--conditions=cdk` is removed from `NODE_OPTIONS` for it.
- Next.js: Hosting runs `npx @opennextjs/aws build` in the project. When `@opennextjs/aws` is absent it warns and runs `npx --yes @opennextjs/aws@<version>`, which downloads the package. Declare `@opennextjs/aws` in `devDependencies` with the repo's manager so that the build uses the locked version. See `cdk-blocks blockify-app guide nextjs`.
- Astro and SvelteKit: when Hosting has to add an adapter package, it picks the manager from the lockfile in this order: `pnpm-lock.yaml`, `yarn.lock`, `bun.lockb` or `bun.lock`, else npm.

## `preinstall` guards and the `packageManager` pin

- A guard such as `"preinstall": "npx only-allow pnpm"` stays. The lifecycle commands run through `npx` and `npm exec`, which do not run the project's install scripts. An `npm install` in the project trips the guard, and the rules above avoid one.
- Keep an existing `packageManager` pin. It documents the version the lockfile was written with; the binary on `PATH` is the one that runs.

## Monorepos

- AWS Blocks goes into the directory of the app, not into the workspace root. Run the scaffolder, every `cdk-blocks` command and `cdk synth` there (`apps/web`), so that `aws-blocks/`, `cdk.json` and `.blocks/` sit beside the app's `package.json`. From the workspace root the local server would not see the app's framework, and `Hosting` would need its `root` pointed at the app.
- npm workspaces: when the app directory is a workspace of an enclosing root, npm installs at that root and does not read the app's own `"workspaces": ["aws-blocks"]`. `create-blocks-app` then stops before it writes anything, with `Error: <app> is a workspace of the npm workspace root <root>.`, and prints the entry to add. Add `<app>/aws-blocks` to the root `workspaces` and run the command again; it installs at that root.
- The check reads `workspaces` in parent `package.json` files only. In a pnpm monorepo the scaffolder runs without a word: add `<app>/aws-blocks` (`apps/web/aws-blocks`) to `packages:` in the root `pnpm-workspace.yaml` yourself, and `"aws-blocks": "workspace:*"` to the app's `dependencies`. Dependencies that the migration adds (`aws-cdk`, an adapter package) go into the app's `package.json`, not the root's.
- `cdk-blocks` finds the project root by walking up from where it runs to the `package.json` that has an `aws-blocks/` directory; `-C <dir>` sets it explicitly.
- The lockfile lookup starts in the directory where synth runs (the app) and walks up, so in a monorepo the root lockfile is the one CDK uses. Keep exactly one there.
- Leave the other apps and the shared packages of the workspace as they are.

## TypeScript with pnpm

- `The inferred type of '...' cannot be named without a reference to '.pnpm/...'` in `aws-blocks/` (`TS2742`; `TS2883` from TypeScript 7): annotate the export's type (`export const blocksStack: BlocksStack = …` in `aws-blocks/index.cdk.ts`), or set `node-linker=hoisted` in `.npmrc`. A Next.js build reports it, because it typechecks `aws-blocks/` with the app. Source: `node_modules/@aws-blocks/blocks/docs/TROUBLESHOOTING.md`.
