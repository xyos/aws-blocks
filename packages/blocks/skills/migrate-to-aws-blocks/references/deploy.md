# Deploying, verifying and handing over

> Read when: the user asked you to deploy the migrated app to AWS, or you are writing the final handover in `MIGRATION.md`.

## Before any AWS command

- Deploy only when the user asked for it. A deploy creates billable resources in the user's account. Without that request, stop after the local validation and write the handover.
- Local validation must be green first: install, `cdk-blocks dev` with HTTP requests, the app's build, and the synth of the playbook's validate task (`NODE_OPTIONS=--conditions=cdk npx --no -- cdk synth -q`, which runs the frontend build as the deploy will).
- Show the target and get the user's confirmation:

```bash
npx --no -- cdk-blocks whoami                  # identity, Region, project root, stack names; deploys nothing
npx --no -- cdk-blocks whoami --output json    # {account, arn, credentials, region, projectRoot, stacks: {sandbox, production}}
```

- `whoami` uses the identity and Region that `deploy` uses, with `.env.production` applied. `--profile <name>` and `--region <region>` select another target for any command.
- Stack names come from `stackId` in `.blocks/config.json`: production is `<stackId>-prod`, a sandbox is `<stackId>-<username>-<random>`.

## Preflight messages

`sandbox` and `deploy` check credentials and the CDK bootstrap before they synthesize.

| Message | Cause | Action |
|---|---|---|
| `AWS credentials could not be verified` | Missing or expired credentials. The message names the profile, the Region and the fix (`aws login --profile <name>`, `aws sso login --profile <name>`) | Signing in opens a browser. Ask the user, then run the command again. When it first lists `aws configure set region …`, that changes the user's AWS config: include it in the question |
| `CDK is not bootstrapped in Region <region> of account <account-id>` | The SSM parameter `/cdk-bootstrap/<qualifier>/version` does not exist | The message prints `npx cdk bootstrap aws://<account-id>/<region> --app=`. It creates the `CDKToolkit` stack with IAM roles, once per account and Region. Ask the user before you run it |

- The commands then print `Deployment target: <credentials>, Region <region>`, the account name and the plan. `not available` for the name or plan is not an error. The deploy does not pause: when the target is not the one the user confirmed, stop the command.
- When the output has a link to `https://settings.aws.com/billing`, give it to the user. Leave spend limits to the user.

## Choose the command

| Command | What it deploys | Use for |
|---|---|---|
| `npx --no -- cdk-blocks sandbox deploy` | Your personal sandbox stack, backend only, then exits. The frontend is not hosted | Checking the backend against real AWS services |
| `npx --no -- cdk-blocks sandbox preview` | The same sandbox stack plus a hosted preview of the frontend; prints the preview URL and exits | A shareable temporary URL |
| `npx --no -- cdk-blocks deploy --wait-live` | The production stack `<stackId>-prod`, with Hosting behind CloudFront | The real app |

- `cdk-blocks sandbox` without a subcommand watches for changes and runs a local server; it does not exit. Use `sandbox deploy` in an agent shell.
- The sandbox uses `BlocksPresets.sandbox`: resources are deleted with the stack, deletion protection is off, logs are kept one week, throttling is 200 requests/s.
- The preview uses `HostingPresets.preview`: API Gateway serves it with no CloudFront, server responses are buffered (about 6 MB each), image optimization and incremental regeneration are off. A streaming route or an optimized image that fails there can still work in production.
- Preview and sandbox are one stack. A later plain `sandbox deploy` removes the preview, and adding it again gives a new URL.
- A first production deploy can take 10 minutes or more, which is longer than many shell timeouts. Run it in the background and wait for the result line:

```bash
npx --no -- cdk-blocks deploy --wait-live > deploy.log 2>&1 &
# success ends with:  BLOCKS_DEPLOYED url=<frontend> api=<backend>
```

- `--wait-live` holds the result until CloudFront serves the new build (budget `--wait-live-timeout=<seconds>`, default 180). When the wait fails, the deploy itself succeeded and the command exits 1.
- A closed terminal or one `SIGTERM` does not stop a running deploy on POSIX. Stop it with Ctrl-C or a second `SIGTERM`.

## Read the result

```bash
npx --no -- cdk-blocks deploy --output json        # {apiUrl, url, stack, account, region, live}
URL=$(npx --no -- cdk-blocks deploy --query url)   # one field, raw
API_URL=$(npx --no -- cdk-blocks sandbox deploy --query apiUrl)
```

- Results go to stdout; progress, CloudFormation events and the failure reason go to stderr. After a failed deploy no result is printed: search stderr (or `deploy.log`) for the reason.
- Exit codes: `0` success, `1` failed, `2` usage error or a confirmation that the run could not give, `130` interrupted, `143` stopped by `SIGTERM`.
- `sandbox deploy` prints `BLOCKS_DEPLOYED api=<backend>` and writes the API URL to `.blocks-sandbox/config.json`.

## Secrets and config

- List what the app declares, then set each value. A secret value is never accepted on the command line: the command prompts for it, or reads it with `--value-stdin`.

```bash
npx --no -- cdk-blocks secret list
npx --no -- cdk-blocks secret set STRIPE_SECRET_KEY        # hidden prompt; the user types the value
npx --no -- cdk-blocks config set FEATURE_FLAGS '{"beta":true}'
```

- Ask the user to run `secret set` themselves, so that the value stays out of your transcript. `--stage <name>` scopes a value to one stage; without it the value is shared.
- Hosting values (`secret()`, `config()`) are set before the first deploy: under `Hosting.create` the deploy stops with `UnresolvedSecretError` until each one exists, and under `new Hosting` it succeeds and the first read fails. `Secret` and `AppSetting` values are set after the first deploy, which creates them. Guide `secrets` has both.

## Smoke-check the deployed URL

```bash
curl -s "$URL/.blocks-sandbox/config.json"       # expect {"apiUrl": "...", "environment": "production"}
curl -s -o /dev/null -w '%{http_code}\n' "$URL/"  # expect 200 (or a redirect to sign-in)
curl -s -X POST "$URL/aws-blocks/api" -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","method":"api.<method>","params":[],"id":1}'
```

- `method` is `<export name>.<method>` from `aws-blocks/index.ts`. An RPC error returns HTTP 200 with an `error` object in the body, so read the body.
- Then check, in this order: one deep link (client-side routing), one page that reads data, sign-in, one upload, and each route that calls a secret-backed service.

## Common first-deploy failures

| Symptom | Cause | Fix |
|---|---|---|
| `Frontend build failed: <command>` | `buildCommand` failed in the deploy shell: a tool missing from `PATH`, or a build-time env value absent | Read the build output above the line; see `cdk-blocks blockify-app guide package-managers` |
| `MultipleLockFilesFound` | Two lockfiles in the project root | Keep one lockfile |
| Deployed config body is `{"_placeholder":true}` | The build-time stub was not replaced | Run the deploy again |
| Local checks pass, deployed calls fail with access denied, a 504 after 29 seconds, or a CORS error on upload | Mocks do not enforce IAM, API Gateway limits or bucket CORS | See `cdk-blocks blockify-app guide aws-limits` and `file-uploads` |
| Sign-in returns to the old origin or fails on callback | The identity provider does not list the new origin | Add the deployed URL at the provider; see `cdk-blocks blockify-app guide auth` |
| A model call fails with a use-case or AWS Marketplace message | One-time Amazon Bedrock account steps | See `cdk-blocks blockify-app guide ai` |
| `cdk-blocks destroy` exits 2 | No terminal and no `--yes` | Ask the user, then pass `--yes` |

More: `node_modules/@aws-blocks/blocks/docs/TROUBLESHOOTING.md`.

## Teardown, retained resources and cost

```bash
npx --no -- cdk-blocks sandbox destroy --yes   # your sandbox stack only; never production
npx --no -- cdk-blocks destroy --yes           # the production stack; ask the user first
```

- Deleting the production stack deletes the user's data path. Run `destroy` only on the user's explicit request for this stack.
- `BlocksPresets.production` sets `removalPolicy: RETAIN` and `deletionProtection: true`, with point-in-time recovery, secret rotation and one-year log retention. Stateful resources (tables, buckets, the user pool) therefore remain in the account after `destroy` and keep their data and their cost. Tell the user that they remain; deleting them is a manual step after deletion protection is turned off. Each block's README under `node_modules/@aws-blocks/blocks/docs/` states what it retains.
- A production stack with a `Database` does not finish `destroy`. The Aurora cluster and its subnet group are kept, and CloudFormation then cannot delete the security group and the subnets that the cluster uses: after about 35 minutes the stack is `DELETE_FAILED` (`resource sg-... has a dependent object`), and the command retries with the same result. Do not start it and wait. Tell the user that removing such an app means deleting the cluster first, which deletes its data (turn off deletion protection, delete the cluster, then its subnet group), and running `destroy` after that. Values written with `cdk-blocks secret set` and `config set` are outside the stack and also remain.
- `BlocksPresets.sandbox` sets `removalPolicy: DESTROY`, so `sandbox destroy` removes the data too.
- Cost while deployed: a `Database` (Aurora) has an idle cost at a minimum of 0.5 ACU, or a cold start when it scales from zero. An `Agent` bills model tokens and runtime while a session is active. The other blocks bill per request and per stored byte. A sandbox left running costs the same as these resources in production: destroy it when the check is done.

## Handover: what `MIGRATION.md` lists

- **What moved**: each surface (hosting, API, data, auth, files, jobs, secrets, LLM calls) with the block that replaced it, and each surface that stayed on its provider.
- **Validation**: the commands you ran and their results; failures the original code already had.
- **Blockers**: everything that stopped a step and needs the user (a missing value, a decision, a version that cannot be met).
- **Before deploy**: Hosting secrets and config keys to set (names only), public build-time values that the deploy environment must provide, placeholders in the code that take a value only the user has, and one-time account steps (Amazon Bedrock model access, a bootstrap in a second Region).
- **After deploy**: `Secret` and `AppSetting` values to set (names only), callback and redirect URLs to add at identity providers, bucket CORS origins, user re-enrollment, data and file copies, DNS or custom domain work, and the old hosting to retire.
- **If deployed**: account, Region, stack name, URL, API URL, whether it was a sandbox or production, and the teardown command.
- **Deploy requirements**: Node.js version, the package manager that must be on `PATH`, the `buildCommand`.
