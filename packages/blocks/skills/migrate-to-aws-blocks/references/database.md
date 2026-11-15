# Relational data with the Database block

> Read when: the app stores data in PostgreSQL through Prisma, Drizzle, `pg`, `postgres`, `@vercel/postgres`, Neon, or raw SQL.

Confirm every detail in `node_modules/@aws-blocks/blocks/docs/bb-data/README.md` and `DESIGN.md` before a task depends on it.

## Choose the block

- Default for this migration: `Database` from `@aws-blocks/blocks`. On AWS it is Aurora Serverless v2 PostgreSQL reached through the RDS Data API. Locally it is PGlite (WASM PostgreSQL). The existing schema, column types, ids, foreign keys and transactions stay the same.
- `DistributedDatabase` (Aurora DSQL) has no idle cost, but it has no foreign keys, Row Level Security, triggers or PL/pgSQL, and a transaction can change at most 3,000 rows. ORM-generated DDL needs changes. Use it only when the user asks for it (`docs/bb-distributed-data/README.md`).
- `new Database(scope, 'main', { connection: fromExisting({ connectionString }) })` keeps the current external PostgreSQL (Supabase, Neon) and its data. `migrationsPath` is rejected with it. Use it only when the user wants to keep that database; see `cdk-blocks blockify-app guide supabase`.
- A preview package `@aws-blocks/bb-database` also exports a `Database`. The umbrella does not export it. Import `Database` from `@aws-blocks/blocks`.

## Constructor and options

```typescript
import { Database, DatabaseErrors, isBlocksError, sql } from '@aws-blocks/blocks';

const db = new Database(scope, 'main', { migrationsPath: './aws-blocks/migrations', minCapacity: 0 });
```

- `migrationsPath` is resolved from the directory where `cdk` and the dev server run (the project root), so it includes the `aws-blocks/` segment. Write it as a literal string: the backend is bundled for Lambda and `import.meta.url` points at the bundle there.
- `minCapacity` (default `0.5` ACU) and `maxCapacity` (default `2`). The playbook's decision for a migrated app is `minCapacity: 0`: the cluster pauses after about 5 idle minutes and bills no compute while paused. The price is that the call that wakes it fails while the cluster resumes, so with `0` every database call goes through the retry helper in "Cold resume" below. At the default `0.5` there is no pause and the cluster bills while idle; use it when the user wants no slow first request, and record the choice in MIGRATION.md either way.
- `postgresVersion` defaults to `'16.13'` and must look like `MAJOR.MINOR`. Keep the default.
- `removalPolicy`: `'destroy' | 'retain' | 'snapshot'`. When omitted, the stack preset decides: production retains the cluster, sandbox destroys it.
- `extensions: ['postgis']` or `['pgvector']` loads the extension in local PGlite only (each needs its own npm package). Aurora has them natively. The migration still runs `CREATE EXTENSION`.
- Other options: `databaseName`, `pointInTimeRecovery`, `secretRotation`, `storageEncryptionKeyArn`, `subnets`, `schema`, `rlsPolicy`. Set them only when the app needs them.
- Storage encryption is on only when `cdk.json` has `"context": { "@aws-blocks/bb-data:encryptStorageByDefault": true }`. Without it, synth warns `@aws-blocks/bb-data:StorageEncryptionOptIn`. Add the flag before the first deploy. Adding or removing it after a deploy replaces the cluster with a new, empty one.
- Construct the block at module scope. Call its methods only inside handlers: a query at module scope throws during `cdk synth`.

## ORMs and drivers are replaced

- On AWS the app reaches the cluster only through the RDS Data API (HTTPS). The cluster accepts no socket from the app, so Prisma, Drizzle, `pg`, `postgres`, `@vercel/postgres` and the Neon driver cannot connect.
- AWS Blocks ships no Prisma or Drizzle adapter. Rewrite every query with the `sql` tag or with Kysely, then remove the ORM client, its generate step in `package.json` scripts, and `DATABASE_URL`.
- Keep the ORM schema file until the SQL migrations are written; it is the source for them.

## Queries

- `db.query<T>(q)` returns `T[]`. `db.queryOne<T>(q)` returns `T | null`. `db.execute(q)` returns `{ rowCount }`. Use `query`/`queryOne` with `RETURNING` to read back inserted rows.
- `db.transaction(async (tx) => { ... })` gives `tx.query`, `tx.queryOne`, `tx.execute`. It commits when the callback returns and rolls back when it throws.
- Every query is a `sql` tagged template. Each `${value}` becomes a bind parameter (`$1`, `$2`). A plain string fails with `Invalid query: use the sql tagged template`.
- `sql` does not compose. A `sql` fragment, a column name, a table name or `ASC`/`DESC` inside `${}` is sent as a parameter value. Write each query complete. For optional filters use one of these:

```typescript
// One query; a null parameter turns the filter off.
await db.query<Post>(sql`
  SELECT * FROM posts
  WHERE (${status}::text IS NULL OR status = ${status})
  ORDER BY created_at DESC LIMIT ${limit}`);
```

- For a dynamic sort column, branch to complete queries or use Kysely.
- Raw queries bypass Row Level Security. `db.withRLS({ userId })` scopes queries to a user; the roles must exist and be granted (README, "Row Level Security").

## Kysely (optional, for dynamic queries)

```typescript
import { createKyselyAdapter } from '@aws-blocks/bb-data';
const kysely = createKyselyAdapter<Schema>(db); // safe at module scope
```

- `createKyselyAdapter` comes from `@aws-blocks/bb-data`; the umbrella does not export it. Add `@aws-blocks/bb-data` and `kysely` to the dependencies. `kysely` must satisfy `>=0.28.12 <0.30.0`.
- Mark serial ids and columns with a `DEFAULT` as `Generated<T>` in the schema interface, so inserts type-check.
- Kysely uses the same engine, so the errors and type differences below apply.

## Migrations

- Files are `aws-blocks/migrations/*.sql`. They run in lexicographic file-name order: use `001_`, `002_` prefixes.
- Each file runs once, in one transaction, and is recorded by file name in the `_migrations` table. A change to an applied file has no effect. Add a new file for each schema change. There are no down migrations.
- Start from the SQL the ORM already produced:
  - Prisma: copy each `prisma/migrations/*/migration.sql` in order. Without that folder, generate one script with `npx prisma migrate diff` (from empty, to the schema file, `--script`; `--help` shows the flag names of the installed version).
  - Drizzle: copy `drizzle/*.sql` in order. The `--> statement-breakpoint` lines are SQL comments and can stay.
  - No generated SQL: translate the schema to `CREATE TABLE` statements with the same table names, column names, types, defaults, indexes and constraints.
- Keep table and column names exactly as the production database has them, so the data copy is a plain copy.
- `gen_random_uuid()` works on both engines without an extension.
- Seeds: put reference data in a later migration file with `INSERT ... ON CONFLICT DO NOTHING`. Convert a seed script (`prisma/seed.ts`) to SQL or to an API method.
- Local: migrations start when the backend loads and every query waits for them. AWS: a Lambda custom resource applies them during `cdk deploy`, only when a migration file changed.
- The dev server is the main local check: a failing file is logged as `[migrations] Failed: <file>` and every query then rejects. The `db` commands check the files without the server:

```bash
npx --no -- cdk-blocks db migrate aws-blocks/migrations   # apply pending files to local PGlite
npx --no -- cdk-blocks db status aws-blocks/migrations    # list applied and pending files
```

- Pass the directory: the default is `./migrations`. These commands use a PGlite store at the root of `.bb-data/`, while the running app keeps its database in `.bb-data/<fullId>/`. They prove that the files apply in order; they do not change the database the dev server reads.

## Deployed and local values differ

Local checks pass while the deployed app fails on these. Handle each one in code.

| Value | AWS (Data API) | Local (PGlite) |
|---|---|---|
| `timestamp`, `timestamptz`, `date` result | string | `Date` |
| `bigint` result, `count(*)` | number | number (a `BigInt` above 2^53) |
| `numeric` / `decimal` result | string | string |
| `json` / `jsonb`, array columns | parsed value, JS array | same |
| `bytea` result | `Buffer` | `Uint8Array` |
| `tsvector` in the select list | the query fails | returned |
| `Date` parameter | sent as ISO text, no type hint | converted by PGlite |
| object or array parameter | sent as JSON text | converted by PGlite |

- Type timestamp fields as `string | Date` and convert them in one function before they leave the API. JSON turns a local `Date` into an ISO string, so the browser sees two formats when this step is missing.
- Cast counts and sums in SQL: `SELECT count(*)::int AS n`. Parse `numeric` with `Number()` only when precision allows.
- Parameters carry no type hints on AWS. Add a cast where the column is not text: `${date}::timestamptz`, `${id}::uuid`, `${JSON.stringify(obj)}::jsonb`. The cast is valid on both engines.
- For a list parameter, send JSON and expand it in SQL, because a JS array reaches Aurora as JSON text:

```typescript
sql`SELECT * FROM users WHERE id IN (SELECT jsonb_array_elements_text(${JSON.stringify(ids)}::jsonb))`
```

- PGlite uses one connection and has no Data API limits and no cold start. Bound every list query with `LIMIT`; see `cdk-blocks blockify-app guide aws-limits`.

## Errors

| `DatabaseErrors.*` | Cause | HTTP |
|---|---|---|
| `UniqueConstraintViolation` | duplicate key (23505) | 409 |
| `ForeignKeyViolation` | missing or still-referenced row (23503) | 409 |
| `CheckViolation`, `NotNullViolation` | 23514, 23502 | 400 |
| `PermissionDenied` | RLS rejection or missing grant (42501) | 403 |
| `SerializationFailure` | serialization conflict (40001), retriable | 409 |
| `ConnectionFailed` | cluster unreachable, resuming, or credential rotating | 500 |
| `TransactionFailed` | callback threw a non-database error, or commit failed | 500 |
| `QueryFailed` | everything else (syntax error, missing table) | 500 |

- Match with `isBlocksError(e, DatabaseErrors.UniqueConstraintViolation)`, then throw `new ApiError(message, status, { name })` for the status the original endpoint returned.
- The client sees a fixed message. The driver text is in `e.cause` on the server only.
- A database error inside `db.transaction()` aborts the transaction; the next statement fails with `QueryFailed`. Catch outside `transaction()`.
- An `ApiError` (or any non-database error) thrown inside the `db.transaction()` callback reaches the caller as `TransactionFailed` (500) with the original error as `cause`. Return a value from the callback and throw the `ApiError` after it, so a 404 stays a 404.
- Only `ConnectionFailed` and `SerializationFailure` are worth a retry.

## Cold resume with `minCapacity: 0`

- The call that wakes a paused cluster fails with `ConnectionFailed` (cause name `DatabaseResumingException`). The block does not retry it. A retry a few seconds later succeeds. Deploy-time migrations do retry.
- The block retries only a refused credential during secret rotation (3 attempts, about 9 s), and only outside transactions.
- With `minCapacity: 0`, wrap each database call, or the whole `db.transaction(...)`, in this helper. API Gateway ends a request at 29 s, so keep the deadline below that. Job handlers can use a longer deadline.

```typescript
export async function withDbRetry<T>(fn: () => Promise<T>, deadline = Date.now() + 20_000): Promise<T> {
  for (;;) {
    try {
      return await fn();
    } catch (e) {
      if (!isBlocksError(e, DatabaseErrors.ConnectionFailed) || Date.now() + 1_000 > deadline) throw e;
      await new Promise((resolve) => setTimeout(resolve, 1_000));
    }
  }
}
```

## Where the code runs

- Database code lives in `aws-blocks/` and runs in the Blocks backend. The block grants Data API access to the backend execution role and reads the cluster from environment variables the backend receives (`BLOCKS_<id>_CLUSTER_ARN`, `_SECRET_ARN`, `_DATABASE`).
- Next.js server components, route handlers and server actions call `ApiNamespace` methods: `import { api } from 'aws-blocks'`. In server code that import resolves to the generated RPC client, so `db` is never available there. See `cdk-blocks blockify-app guide nextjs` and `client-wiring`.
- Move each server-side ORM call into an `ApiNamespace` method that checks the caller, and return plain JSON values.

## Local data and production data

- Local data persists in `.bb-data/`. `rm -rf .bb-data` wipes it and the next start applies all migrations again. Keep `.bb-data/` in `.gitignore`.
- The migration does not move existing production rows. Aurora has no socket endpoint for `pg_dump` or `psql`, so the copy runs through the backend (a one-off API method or job that inserts batches) or the Data API.
- Record in MIGRATION.md under After deploy: copy the data table by table in foreign-key order, then reset each sequence (`SELECT setval(pg_get_serial_sequence('users','id'), (SELECT max(id) FROM users))`), then remove the old `DATABASE_URL`.
