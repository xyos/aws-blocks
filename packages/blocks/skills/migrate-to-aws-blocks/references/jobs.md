# Scheduled and background jobs (CronJob, AsyncJob)

> Read when: the app has `vercel.json` crons, node-cron, `setInterval` work, a queue library (BullMQ, Inngest), or a request that starts work it does not wait for.

Confirm details in `node_modules/@aws-blocks/blocks/docs/bb-cron-job/README.md`, `docs/bb-async-job/README.md` and `docs/bb-compute/README.md`.

## CronJob

```ts
import { CronJob } from '@aws-blocks/blocks';

new CronJob(scope, 'cleanup', {
  schedule: 'cron(0 3 * * ? *)',     // or 'rate(10 minutes)'
  timezone: 'America/New_York',      // optional IANA name, default 'UTC'
  handler: async (event) => {        // event.scheduledTime (ISO 8601), event.jobName, event.input
    await deleteExpiredLinks();
  },
});
```

- Options: `schedule` and `handler` (required); `enabled` (default `true`), `description`, `timezone`, `input` (static payload, arrives as `event.input`), `compute`, `timeoutSeconds`.
- A `CronJob` has no runtime methods. Declare it at the top level of `aws-blocks/index.ts`; the schedule calls the handler.
- The handler runs in the backend, next to the API methods, and uses other blocks directly (`Database`, `FileBucket`, `KVStore`).
- On AWS each job is one EventBridge Scheduler schedule that invokes the backend function. Delivery is at least once, and a run that exceeds the interval overlaps the next run. Write the handler so that a repeated or concurrent run is harmless.
- A handler that throws is retried two more times by Lambda. After that the error is only in the logs.

## Schedule syntax

- `rate(<n> minute|minutes|hour|hours|day|days)`: lowercase, singular for 1 (`rate(1 minute)`, `rate(5 minutes)`). The minimum is 1 minute. `rate(30 seconds)` and `rate(1 minutes)` are rejected.
- `cron(minute hour day-of-month month day-of-week year)`: six fields. One of day-of-month and day-of-week must be `?`. Day-of-week is `1-7` with `1` = Sunday, or `SUN`-`SAT`.
- Convert a 5-field expression (Vercel, node-cron, crontab, GitHub Actions): append ` *` for the year, put `?` in the day field that was `*` (day-of-week when both were `*`), and change numeric weekdays, because 5-field cron uses `0` = Sunday.

| 5-field | AWS Blocks |
|---|---|
| `0 3 * * *` | `cron(0 3 * * ? *)` |
| `*/15 * * * *` | `cron(0/15 * * * ? *)` or `rate(15 minutes)` |
| `0 9 * * 1-5` | `cron(0 9 ? * MON-FRI *)` |
| `30 2 1 * *` | `cron(30 2 1 * ? *)` |
| `0 0 * * 0` | `cron(0 0 ? * SUN *)` |

- Vercel crons run in UTC, which is also the `CronJob` default. node-cron uses the server time zone unless the code passes one; carry that zone into `timezone`.
- Validation happens when the job is constructed, so a wrong schedule stops `cdk-blocks dev` and `npx cdk synth`:
  - `InvalidScheduleExpression`: `"<expr>" is not a valid schedule — expected "rate(<n> minutes|hours|days)" or a 6-field "cron(...)" expression`. A 5-field expression inside `cron(...)` gives this error.
  - `InvalidTimezoneExpression`: the `timezone` is not an IANA name.
  - `ScheduleNotSupportedInMock` (local only): the expression uses `L`, `W`, `#` or a year other than `*`. It deploys, but local dev cannot start with it. Use an equivalent plain expression where one exists.
- Synth checks only that a `cron(...)` has six fields. Local dev also checks field ranges, so run `cdk-blocks dev` to catch a bad field before deploy.

## Local dev

- `cdk-blocks dev` runs every job in the dev server process on its schedule and prints `[CronJob:<id>] scheduled: ...` or `next fire: ...` at start, then `[CronJob:<id>] triggered at <time>` for each run.
- A failed handler is logged and not retried locally.
- To exercise a handler now, export its logic as a function and call it from a temporary API method, or set `schedule: 'rate(1 minute)'` for the test and restore the real schedule afterwards.
- `enabled: false` registers the job without running it.

## Vercel crons

- Hosting does not schedule `vercel.json` `crons`. When Hosting builds the app (deploy or a full synth), it prints: `vercel.json declares N cron job(s), but the hosting construct wires no scheduler — these will NEVER fire. Provision the schedule separately via AWS EventBridge (or a scheduled CloudWatch rule invoking your endpoint).`
- Create one `CronJob` per `crons` entry with the converted schedule.
- Move the logic of the cron route (`app/api/cron/<name>/route.ts`) into a function in `aws-blocks/` and call it from the `CronJob` handler. The handler runs in the backend function, outside the Next.js server, so replace Next.js-only calls (`revalidatePath`, `cookies()`) and ORM clients with blocks. See `cdk-blocks migrate guide database`.
- The old route and its `CRON_SECRET` check:
  - If only the Vercel scheduler called it, delete the route and remove `CRON_SECRET` from the environment list. The job needs no secret, because nothing outside AWS can invoke it.
  - If an external caller also uses the URL (a monitoring service, a manual trigger), keep the route and its secret check, and make it call the same shared function. The route runs in the Next.js server function, so declare the secret as a Hosting value and record it in `MIGRATION.md` under Before deploy. See `cdk-blocks migrate guide secrets`.
- The warning stays while `vercel.json` has `crons`. Remove the entries when the app leaves Vercel; keep them when the user still deploys there, and say in `MIGRATION.md` that the warning is expected.

## In-process timers

- `setInterval` or node-cron that changes durable data (delete expired rows, send digests, sync an API) becomes a `CronJob` with the same period. Reason: a Lambda instance is frozen between requests and recycled at any time, so a timer in the process does not fire reliably.
- `setInterval` that only prunes in-memory state (rate-limit map, cache) has nothing durable to do. Remove it together with the in-memory state, or move the state to a `KVStore` with a TTL. See `cdk-blocks migrate guide key-value`.
- `setTimeout(() => work(), delay)` after a response becomes `job.submit(payload, { delaySeconds })`.

## AsyncJob

```ts
import { AsyncJob } from '@aws-blocks/blocks';

const reportJob = new AsyncJob(scope, 'report', {
  trackStatus: true,                 // only when the app polls for the result
  handler: async (payload: { reportId: string }, ctx) => { /* ctx.jobId, ctx.receiveCount, ctx.sentAt */ },
});

// in an ApiNamespace method:
const { jobId } = await reportJob.submit({ reportId });   // returns when the job is queued
```

- Use it for work that a request starts and does not wait for: email, file processing, reports, webhooks fan-out, anything that can pass the 29-second API limit.
- Work that continues after the response (a promise that is not awaited, `waitUntil`, `after()`) is not guaranteed to finish on Lambda. Submit a job before the method returns.
- Options: `handler` (required); `schema` (Zod or another Standard Schema, checked on submit); `maxRetries` (default 3, total deliveries including the first, then the dead-letter queue); `batchSize` (default 10); `maxBatchingWindowSeconds` (default 5); `trackStatus` (default `false`); `compute`; `timeoutSeconds`.
- `submit(payload, { delaySeconds })` accepts a delay of 0 to 900 seconds. `submitBatch(payloads)` accepts up to 10,000 payloads.
- A serialized payload over 256 KB throws `PayloadTooLargeException`, locally too. Pass ids and `FileBucket` keys, and load the data in the handler.
- Delivery is at least once. The handler must be safe to run twice. With `batchSize` above 1, a timeout redelivers the whole batch; set `batchSize: 1` for work that is expensive to repeat.
- With the default batching window a job can start up to 5 seconds after `submit`. Set `maxBatchingWindowSeconds: 0` for work the user waits for.
- The handler returns nothing. Write the result where the app reads it (a database row, a `FileBucket` object).
- Polling: with `trackStatus: true`, an API method returns `await reportJob.getStatus(jobId)`: `{ state: 'queued' | 'processing' | 'complete' | 'failed', attempts, error?, transitions, ... }`, or `null` for an unknown id. Records expire 24 hours after the last change. Without the option the call throws `StatusNotTrackedException`.
- `waitUntilComplete(jobId)` defaults to a 30-second timeout, which is longer than an API call may run. Inside an API method, return the `jobId` and let the client poll `getStatus`.
- A delivery killed by a timeout or by memory exhaustion records no `failed` state; the status stays `processing`. Have the client stop polling after a deadline.
- Locally the queue is in-process: retries, the payload limit and status tracking behave the same, and dead-lettered jobs are printed to the console.

## Timeouts and Compute

- By default jobs run on the app's default compute: a Lambda function with 2048 MB and a 15-minute timeout. An API call is still cut at 29 seconds; the 15 minutes apply to `CronJob` and `AsyncJob` runs.
- Give a job its own function when it needs different memory: `const heavy = new Compute(scope, 'heavy', { type: 'serverless', memory: 4096, maxTimeoutSeconds: 900 })`, then `compute: heavy` on the job. `maxTimeoutSeconds` is at most 900.
- Work longer than 15 minutes needs `new Compute(scope, 'worker', { type: 'container', size: { vcpu: 1, memory: 2048 }, scaling: { minInstances: 1, maxInstances: 2 } })` plus `timeoutSeconds` on the job. A container with `minInstances: 1` is billed around the clock, so add it only when the original app has such work, and note it in `MIGRATION.md`.
- Compute placement has no effect locally: every handler runs in the dev server without a timeout. A job that runs 20 minutes locally is killed at 15 minutes on Lambda.

## Queue libraries

| Original | AWS Blocks |
|---|---|
| BullMQ / Bull `queue.add(name, data)` + `Worker` | `job.submit(data)` + the `AsyncJob` `handler`; one `AsyncJob` per queue or job name. Remove the Redis connection. |
| `queue.add(..., { delay })` | `submit(data, { delaySeconds })`, at most 900 seconds. For a longer delay store a due time and let a `CronJob` submit due work. |
| `attempts: n` | `maxRetries: n` |
| Repeatable jobs, `inngest.createFunction({ cron })` | `CronJob` |
| Inngest `inngest.send(event)` + `createFunction({ event })` | `submit(payload)` + `AsyncJob`; remove the `/api/inngest` route |
| Multi-step functions (`step.run`, `step.sleep`) | One `AsyncJob` per step; each handler submits the next step. Record any behavior you could not keep in `MIGRATION.md` under Blockers. |
| Job progress, `job.getState()` | `trackStatus: true` + `getStatus(jobId)` |
