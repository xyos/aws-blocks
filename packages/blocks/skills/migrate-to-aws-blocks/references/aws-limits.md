# Lambda and API Gateway limits that change app behavior

> Read when: the app sends or returns large bodies, runs requests longer than a few seconds, keeps state in memory or on disk, streams responses, or serves WebSockets.

Local dev has none of these limits: `cdk-blocks dev` runs one long-lived Node.js process with a normal disk. Code that passes every local check can fail after deploy, so check each item by reading the code.

## Request path on AWS

- Backend API (`ApiNamespace`, `RawRoute`, auth routes): API Gateway REST API, then the backend Lambda function (default 2048 MB).
- Next.js and other SSR pages, server actions and route handlers: CloudFront, then an API Gateway REST API in streaming mode, then the SSR Lambda function. Hosting defaults are 1024 MB and a 30-second timeout; the `nextjs` template sets the same values in `compute: { memorySize, timeout }` in `aws-blocks/index.cdk.ts`.
- Static assets: CloudFront from S3, without Lambda.
- Sources: `node_modules/@aws-blocks/blocks/docs/core/README.md` (section "API Gateway"), `docs/hosting/README.md`, <https://docs.aws.amazon.com/lambda/latest/dg/gettingstarted-limits.html>, <https://docs.aws.amazon.com/apigateway/latest/developerguide/limits.html>.

## Limits, symptoms and responses

| Limit | Symptom after deploy | Migration response |
|---|---|---|
| Lambda accepts a 6 MB request per invocation. API Gateway allows 10 MB, so the lower Lambda limit applies. | Upload, form post or large JSON save fails with a 4xx or 5xx gateway error; small inputs work. | Send files to `FileBucket` with a presigned URL (`cdk-blocks migrate guide file-uploads`). Split large JSON writes into pages. |
| Base64 adds one third. A binary body in JSON-RPC or a data URL fits about 4.5 MB of file in 6 MB. | A "5 MB" upload limit in the app fails near 4.5 MB. | Same as above. If the app states an upload limit, enforce it with `maxUploadBytes` on the bucket. |
| A backend API response is one buffered Lambda response of at most 6 MB. | Export, report or "list everything" call returns a 5xx error once the data grows. | Paginate. Write large results to a `FileBucket` and return a download URL. |
| API Gateway ends a backend API request at 29 seconds. AWS Blocks answers first, at 28 seconds, with HTTP 504 `Request timed out` (`HandlerTimeoutError` for RPC calls, `code: 'HANDLER_TIMEOUT'` for a `RawRoute`). | Slow method returns 504; the client throws. Work in progress is aborted. | Start an `AsyncJob`, return its `jobId`, and poll (`cdk-blocks migrate guide jobs`). In a `RawRoute`, pass `ctx.request.signal` to `fetch` and SDK calls so they stop at the deadline. |
| The SSR function times out at 30 seconds by default. | Page, server action or route handler returns a 5xx error after about 30 seconds. | Move the slow work to an API method plus `AsyncJob`. Raise `compute.timeout` on `Hosting` only for a measured need, and tell the user. |
| Response streaming works for SSR pages through the default CloudFront door. Backend API methods return one complete response. | A streamed route handler (SSE, AI token stream) moved to an `ApiNamespace` method arrives all at once, or hits the 29-second limit. | Keep page streaming in the framework. For server push and token streams use `Realtime` or the `Agent` block (`cdk-blocks migrate guide ai`). |
| No WebSocket upgrade on API or SSR routes. The connection gets HTTP 200 in place of 101. | `ws`, socket.io or SSE server code connects locally and never connects on AWS. | Use the `Realtime` block (`docs/bb-realtime/README.md`). A browser that connects to a third-party WebSocket service is unaffected. |
| No shared memory. Each concurrent request can run in a different function instance, and instances are recycled. | Rate-limit maps, in-memory sessions, caches and counters reset or disagree between requests. | Move the state to `KVStore`, `DistributedTable` or `Database` (`cdk-blocks migrate guide key-value`). A module-level cache of read-only data is fine. |
| No persistent disk. The code directory is read-only; only `/tmp` is writable (512 MB by default), per instance, and lost on recycle. | `EROFS: read-only file system`, or a file written by one request is missing in the next; SQLite or JSON-file data disappears. | Files go to `FileBucket`, data to a data block. Use `/tmp` only for scratch files inside one request. |
| Work after the response is not guaranteed. The function is frozen when the handler returns. | Emails, webhooks or logs sent "in the background" are sometimes lost or arrive late. | `await` the work before returning, or submit an `AsyncJob`. |
| Timers do not run between requests. | `setInterval` and node-cron jobs never fire, or fire rarely. | `CronJob` (`cdk-blocks migrate guide jobs`). |
| Cold start. The first request to a new instance loads all code and opens new connections. | First request after idle time, or during a traffic spike, is slower by a second or more. | Create clients lazily and once per module. Avoid heavy top-level work. Hosting has `compute.warmup` and `compute.provisionedConcurrency` when the user asks for it. |
| CloudFront error pages apply to every path. | With a custom 403/404 page, an API that returns real 4xx statuses (`httpErrorStatus: true`) fails synth with `HttpErrorStatusErrorPagesError`. | Leave `httpErrorStatus` off, which is the default; the typed client reads errors from the JSON body. |

## Hosting doors other than the default

- `frontDoor: { kind: 'apiGateway' }` (used by `HostingPresets.preview`) buffers SSR responses: about 6 MB per response, no streaming, a 29-second timeout, and static files over about 4.5 MB fail synth with `AssetExceedsProxyLimit`.
- The ALB door caps request and response bodies at 1 MB. Details are in `docs/hosting/README.md`, section "Size and time limits".

## How to check without deploying

- Search the code for: `fs.writeFile`, `multer`, `formData()`, `arrayBuffer()`, `toString('base64')`, module-level `new Map()`, `setInterval`, `WebSocket`, `ReadableStream`, `text/event-stream`, unbounded `findMany()`/`SELECT *` returns.
- For each hit, decide which row applies and apply the response. Where the behavior changes for users (a lower effective upload size, polling in place of a long request), record it in `MIGRATION.md`.
