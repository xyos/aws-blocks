# Key-value and Redis-style data (Vercel KV, Upstash, Redis)

> Read when: the app uses `@vercel/kv`, `@upstash/redis`, `ioredis`, `redis`, or another key-value store for caches, sessions, counters, rate limits, or queues.

Confirm every detail in `node_modules/@aws-blocks/blocks/docs/bb-kv-store/README.md` and `DESIGN.md` before a task depends on it.

## What KVStore is

- `KVStore` from `@aws-blocks/blocks` is one DynamoDB table with a string key and one JSON value per key. It is a key-value store, not a Redis server: it has no lists, hashes, sets, sorted sets, counters, pub/sub, scripts, or multi-key transactions.
- Methods: `get(key, options?)`, `put(key, value, options?)`, `delete(key, conditions?)`, `scan(options?)`. `put` and `delete` return nothing.
- Values are serialized with `JSON.stringify`. The value type is `string` by default; `new KVStore<Session>(scope, 'sessions')` stores objects; `{ schema }` (Zod, Valibot, ArkType) also validates each `put`.
- One item holds at most 400 KB. A larger value fails with `KVStoreErrors.ItemTooLarge`. Store large payloads in `FileBucket` (`cdk-blocks blockify-app guide file-uploads`).
- `scan()` returns `AsyncIterable<{ key, value }>` over every item. It has no prefix or pattern filter and it reads the whole table, so keep it out of request paths.
- Use one store per kind of entity (`sessions`, `cache`, `rate`), each with its own value type.

```typescript
import { ApiError, KVStore, KVStoreErrors, isBlocksError } from '@aws-blocks/blocks';

const cache = new KVStore<CachedPage>(scope, 'cache', { ttl: true });
await cache.put(`page:${slug}`, page, { ttlSeconds: 300 });
const hit = await cache.get(`page:${slug}`); // null when absent or expired
```

## Expiry

- Turn it on for the store with `{ ttl: true }` (default `false`), then set it on each write: `{ ttlSeconds: 300 }` (relative, seconds, fractions round up) or `{ expiresAt: new Date(...) }` (a `Date` or Unix epoch seconds). Passing both, or epoch milliseconds, throws `ValidationFailedException`.
- Expiry belongs to the write. A later `put` without expiry options removes the expiry; a `put` with them moves it. There is no call that changes the expiry and keeps the value.
- `get` returns `null` and `scan` skips an item as soon as its expiry passes, locally and on AWS. DynamoDB deletes the item later, typically within 48 hours.
- Until that deletion, conditional writes still see the expired item. `put(key, value, { ifNotExists: true })` fails on a key that expired but still exists. For locks and rate-limit windows, put the time window in the key (`rate:${ip}:${Math.floor(Date.now() / 60_000)}`) so each window is a new key.
- Redis `px` values are milliseconds: convert with `Math.ceil(ms / 1000)`. The resolution is one second.

## Conditional writes and counters

- `put` options: `ifNotExists: true` (create only), `ifValueEquals: previous` (compare-and-swap; compared through `JSON.stringify`, so object key order matters). With both set, the write succeeds when the key is absent or the value matches.
- `delete` conditions: `ifExists: true`, `ifValueEquals: expected`.
- A failed condition throws `KVStoreErrors.ConditionalCheckFailed` (`ConditionalCheckFailedException`, HTTP 409). Check it with `isBlocksError(e, KVStoreErrors.ConditionalCheckFailed)`.
- There is no atomic increment. Two requests that `get` then `put` both write the same number and one increment is lost. Use compare-and-swap, and accept that each conflict costs another round trip:

```typescript
const counters = new KVStore<number>(scope, 'counters');

async function incr(key: string): Promise<number> {
  for (let attempt = 0; attempt < 5; attempt++) {
    const current = await counters.get(key, { consistentRead: true });
    try {
      if (current === null) await counters.put(key, 1, { ifNotExists: true });
      else await counters.put(key, current + 1, { ifValueEquals: current });
      return (current ?? 0) + 1;
    } catch (e) {
      if (!isBlocksError(e, KVStoreErrors.ConditionalCheckFailed)) throw e;
    }
  }
  throw new ApiError('Counter is busy, try again', 409, { name: 'CounterBusyException' });
}
```

- For a counter that many requests update at once, or one that must be exact, use `Database`: `UPDATE counters SET n = n + 1 WHERE id = ${id} RETURNING n` is atomic (`cdk-blocks blockify-app guide database`). `DistributedTable` has no partial update either.

## Redis call mapping

| Redis call | AWS Blocks equivalent |
|---|---|
| `get` | `store.get(key)`; add `{ consistentRead: true }` when it follows a write |
| `set` | `store.put(key, value)` |
| `set` with `ex` / `px`, `setex` | `store.put(key, value, { ttlSeconds })` on a store with `{ ttl: true }` |
| `set` with `nx`, `setnx` | `store.put(key, value, { ifNotExists: true })`; catch `ConditionalCheckFailed` |
| `del` | `store.delete(key)`; no deleted-count result |
| `exists` | `(await store.get(key)) !== null` |
| `mget`, `mset` | `Promise.all` over `get` / `put`; not atomic |
| `expire`, `persist` | `get`, then `put` the same value with or without `ttlSeconds`; not atomic |
| `ttl` | No equivalent. Keep the expiry time inside the value when the app reads it |
| `incr`, `decr`, `incrby` | No atomic equivalent. Compare-and-swap loop above, or a `Database` row |
| `hset`, `hget`, `hgetall` | One object per key in `KVStore<T>` (read, change, `put` with `ifValueEquals`), or a `DistributedTable` with the hash name as partition key and the field as sort key |
| `sadd`, `sismember`, `smembers` | `DistributedTable`: set name as partition key, member as sort key; `put`, `get`, `query` |
| `lpush`, `rpush`, `lrange` | `DistributedTable` with a sortable sort key (timestamp plus id) and `query({ order, limit })`, or a `Database` table |
| `lpop`, `rpop`, `brpop` used as a job queue | `AsyncJob` (`cdk-blocks blockify-app guide jobs`) |
| `zadd`, `zrange`, `zrangebyscore`, `zincrby` | No key-value equivalent. A `Database` table with an index on the score |
| `keys`, `scan` with a pattern | `store.scan()` and filter in code (full table read), or a `DistributedTable` query with `beginsWith` on the sort key |
| `publish`, `subscribe` | `Realtime` for server-to-browser push (`rt.publish(namespace, channel, data)`, best-effort). Not a server-to-server bus |
| `multi` / `exec`, `watch`, `eval` (Lua), pipelines that must be atomic | No equivalent. Use a `Database` transaction |
| Streams, geo, HyperLogLog, bitmaps, blocking reads | No equivalent |

- `DistributedTable` supports TTL through `ttl: '<field>'` (a schema field with Unix epoch seconds). Its reads do not filter expired items, so compare the field with the current time on every read. `put` accepts `ifNotExists` or `ifFieldEquals`, `delete` accepts `ifExists` or `ifFieldEquals`, and there is no `update()`: a change is `get`, then `put` of the full item.
- `Database` has no TTL. Store an `expires_at` column, add `WHERE expires_at > now()` to every read, and delete old rows from a `CronJob`.
- When the app depends on an operation marked "No equivalent" and a `Database` rewrite changes its behavior, keep the hosted Redis. Move its URL and token out of `.env` into a secret (`cdk-blocks blockify-app guide secrets`), create the client inside the backend handler, and record the dependency in MIGRATION.md under After deploy.

## Where the code runs

- Construct the store at module scope in `aws-blocks/index.ts`. Call its methods inside an `ApiNamespace` method, a `RawRoute` handler, or a job handler. A call at module scope throws during `cdk synth`: `KVStore.<method>() cannot be called during CDK synth`.
- The frontend, and Next.js server components, route handlers and server actions, reach the data through API methods: `import { api } from 'aws-blocks'`. Move `kv.get(...)` calls from pages, route handlers and middleware into `ApiNamespace` methods.
- Export domain methods (`getSession`, `recordView`) and check the caller in each one. A generic exported `get(key)` / `set(key, value)` lets any client read and overwrite every key.
- Remove `KV_REST_API_URL`, `KV_REST_API_TOKEN`, `UPSTASH_REDIS_REST_URL`, `UPSTASH_REDIS_REST_TOKEN` and `REDIS_URL` once no code reads them.

## Local mock and AWS differences

- Local data is a JSON file in `.bb-data/<fullId>/store.json`. It survives restarts. `rm -rf .bb-data` wipes it.
- The mock is always strongly consistent. On AWS a `get` right after a `put` can return `null` or the old value unless it passes `{ consistentRead: true }` (twice the read cost). `scan` is always eventually consistent. This difference never shows locally: add the option wherever the code reads its own write (sign-up, create-then-read, the counter loop).
- The mock has no throttling and no IAM. It does enforce the 400 KB limit, schema validation, conditional checks, and expiry on read.
- Existing keys in the old store are not copied. Caches refill on their own; for sessions, counters and other durable keys, record a data-copy step (or "users sign in again") in MIGRATION.md under After deploy.
