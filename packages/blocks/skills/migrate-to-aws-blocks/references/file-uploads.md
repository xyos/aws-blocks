# File uploads and downloads with FileBucket

> Read when: the app accepts, stores, lists or serves user files (multipart forms, base64 bodies, `fs.writeFile`, multer, `public/uploads`, or a storage SDK).

Confirm details in `node_modules/@aws-blocks/blocks/docs/bb-file-bucket/README.md` and `DESIGN.md` (section "Mock vs AWS Behavior Differences").

## How bytes move

- File bytes go directly between the browser and S3 over presigned URLs. The backend only signs the URL.
- Reason: every `ApiNamespace` call, server action and route handler is one Lambda invocation with a 6 MB request and response limit. A base64 body leaves about 4.5 MB for the file. A larger upload works under `cdk-blocks dev` and fails after deploy. See `cdk-blocks blockify-app guide aws-limits`.
- Local disk does not persist on Lambda. Only `/tmp` is writable, each instance has its own `/tmp`, and it is lost when the instance is recycled. A file written by one request is absent for the next one. Every `fs.writeFile`, multer disk storage and `public/uploads` write moves to a `FileBucket`.
- An API method returns a handle. The generated client turns it into a live object in the browser:
  - `await bucket.createUploadHandle(key, { contentType?, contentLength?, expiresIn? })` returns a `FileUploadClient`: `upload(body: Blob | File | ArrayBuffer): Promise<void>` and `getUrl(): string`.
  - `await bucket.getFileHandle(key, { expiresIn?, attachment?, versionId? })` returns a `FileDownloadClient`: `download(): Promise<Blob>` and `getUrl(): string`.
  - `putUrl(key, options)` and `getUrl(key, options)` take the same options and return the raw URL string. Use them for `<img src>`, `<a href>` and non-browser callers.
- `upload()` sends a `PUT` with the signed `Content-Type` and throws `Upload failed: <status>` on a non-2xx status. `download()` throws `Download failed: <status>`.
- The handle is hydrated by `@aws-blocks/bb-file-bucket/middleware`, which `aws-blocks/client.js` imports when the backend has a `FileBucket`. Run `npx --no -- cdk-blocks generate client` after you add the first bucket. If the import does not resolve with a strict package manager, see `cdk-blocks blockify-app guide package-managers`.
- Server-side methods: `put(key, body: Buffer | string, { contentType?, metadata?, cacheControl? })`, `get(key)` (returns `{ body: Buffer, contentType, metadata, size }` or `null` for a missing file; it does not throw), `delete(key)`, `deleteBatch(keys)`, `scan({ prefix })`.

## Rewrite an upload route in three steps

1. An API method checks the caller and the input, builds the key on the server, and returns `createUploadHandle(key, { contentType })` together with the key.
2. The browser calls `await handle.upload(file)`.
3. The browser calls a second API method with the key. That method records the upload (database row) or starts processing.

Then remove the multipart, `FormData`, base64 and data-URL parsing and every local-disk write.

Before (Next.js server action that saves to disk):

```ts
'use server';
import { writeFile } from 'node:fs/promises';
export async function uploadAvatar(formData: FormData) {
  const file = formData.get('file') as File;
  await writeFile(`public/uploads/${file.name}`, Buffer.from(await file.arrayBuffer()));
  await db.user.update({ avatar: `/uploads/${file.name}` });
}
```

After (`aws-blocks/index.ts`):

```ts
import { ApiNamespace, FileBucket } from '@aws-blocks/blocks';

const uploads = new FileBucket(scope, 'uploads', {
  allowedContentTypes: ['image/png', 'image/jpeg', 'image/webp'],
  maxUploadBytes: 5 * 1024 * 1024,
  corsRules: [{
    allowedOrigins: ['http://localhost:3000'], // add the deployed origin, see "CORS"
    allowedMethods: ['GET', 'PUT'],
    allowedHeaders: ['Content-Type'],
  }],
});

export const api = new ApiNamespace(scope, 'api', (context) => ({
  async startAvatarUpload(name: string, contentType: string, size: number) {
    const user = await auth.requireAuth(context);
    const key = `avatars/${encodeURIComponent(user.userSub)}/${encodeURIComponent(name)}`;
    const handle = await uploads.createUploadHandle(key, { contentType, contentLength: size, expiresIn: 300 });
    return { key, handle };
  },
  async finishAvatarUpload(name: string) {
    const user = await auth.requireAuth(context);
    const key = `avatars/${encodeURIComponent(user.userSub)}/${encodeURIComponent(name)}`;
    await saveAvatarKey(user.userSub, key); // store the key, not a URL
  },
  async getAvatarUrl() {
    const user = await auth.requireAuth(context);
    const key = await loadAvatarKey(user.userSub);
    return key ? uploads.getUrl(key, { expiresIn: 3600 }) : null;
  },
}));
```

After (client component):

```ts
import { api } from 'aws-blocks';
const { handle } = await api.startAvatarUpload(file.name, file.type, file.size);
await handle.upload(file);
await api.finishAvatarUpload(file.name);
```

- Keep `requireAuth` only where the original route required a signed-in user. See `cdk-blocks blockify-app guide auth` for the user object.
- Server-side processing (resize, PDF text extraction, virus scan) moves to an `AsyncJob` that reads with `bucket.get(key)` and writes the result with `bucket.put(...)`. Submit it from step 3 with the key as payload. See `cdk-blocks blockify-app guide jobs`.
- A small file that the server itself produces (a generated report) can use `bucket.put()` directly, because the bytes never cross the API.

## Keys

- `FileBucket` has no per-object permissions. Any key that a method accepts from the client is reachable by every caller of that method. Build keys on the server under a prefix derived from the signed-in user, and accept only a file name from the client, wrapped in `encodeURIComponent()`.
- Keys are validated the same way locally and on AWS. An invalid key throws `ValidationFailed` (an `ApiError` with status 400; match with `isBlocksError(e, 'ValidationFailed')`).
- Rules: not empty; at most 1,024 bytes in UTF-8; no leading `/`; no empty segment (`a//b`) and no trailing `/`; no `.` or `..` segment (also when spelled `%2e`, `%2f`, `%5c`); no backslash; no control, line-separator or bidirectional formatting characters.
- A user id that contains `//` or `:` (an OIDC issuer URL) produces an empty segment. Wrap it in `encodeURIComponent()`.
- A stored key is not a URL. Store the key in the database and resolve a URL or handle on each read.

## Content type and size

- A presigned upload always signs a `Content-Type`: the `contentType` option, or `application/octet-stream` when it is omitted. An upload that sends a different header gets `403 SignatureDoesNotMatch`, on S3 and on the local dev server. `handle.upload()` sends the signed value. A hand-written `fetch(url, { method: 'PUT' })` must set the same header. To keep the browser file type, pass `contentType: file.type`.
- S3 serves the file with the content type that was signed at upload (or passed to `put()`).
- A presigned `PUT` has no size limit unless you sign one. With `contentLength`, S3 accepts only a body of exactly that size. With the bucket option `maxUploadBytes`, `createUploadHandle` and `putUrl` require `contentLength` and reject a larger value with `ValidationFailed`. If the original app enforced an upload limit, set `maxUploadBytes` to the same value.
- `allowedContentTypes` takes exact types (`'application/pdf'`) or `type/*`. A wildcard does not match types a browser can run (`text/html`, `image/svg+xml`, JavaScript, any `+xml`); list such a type exactly to accept it.
- Presigned uploads carry no custom metadata. A bucket with `objectLock` rejects presigned uploads with `PresignedUploadUnsupported`.

## CORS (fails only after deploy)

- The browser fetches presigned URLs from the S3 origin, so the bucket needs `corsRules` for `upload()`, `download()` and any `fetch()` of a presigned URL. The default is no CORS. The bucket does not inherit the API's allowed origins or the Hosting domain.
- Shape: `{ allowedOrigins: string[]; allowedMethods: ('GET' | 'PUT' | 'POST' | 'DELETE' | 'HEAD')[]; allowedHeaders?: string[]; exposedHeaders?: string[]; maxAge?: number }`.
- `allowedHeaders` must include `Content-Type`, because every cross-origin `PUT` sends a preflight with that header.
- `allowedOrigins` entries are exact origins (scheme, host, port, no trailing slash), or contain one `*` such as `https://*.example.com`.
- A rule with origin `'*'` and `PUT`, `POST` or `DELETE` throws at synth and in local dev. `'*'` with only `GET`/`HEAD` is allowed.
- Local dev accepts every origin, so a missing rule shows no error locally. On AWS the browser reports `blocked by CORS policy: No 'Access-Control-Allow-Origin' header is present on the requested resource`.
- Which origins to list:
  - `http://localhost:3000`, for a local frontend that talks to a deployed sandbox.
  - The deployed origin. If the user has a custom domain, write `https://<domain>` now.
  - Without a custom domain, the origin is the generated `https://<id>.cloudfront.net` value of the stack output `HostingUrl`. It exists only after the first deploy and AWS Blocks cannot inject it into the bucket. Record in `MIGRATION.md` under After deploy: "copy `HostingUrl` into the `corsRules` of bucket `<id>` in `aws-blocks/index.ts`, then deploy again; browser uploads fail until then".
- `<img src>` and `<a href>` with a `getUrl()` URL are plain navigations and need no CORS rule.

## Serving files

- The bucket blocks all public access. Every read uses a presigned URL, including files that the old app served as public static paths.
- Public page: a method without `requireAuth` returns `bucket.getUrl(key)`. Private file: gate the method and check ownership before signing.
- When the old app served files at a URL of its own (`/files/<name>`, `/uploads/<name>`, `/api/download?id=...`), keep that URL. The route handler stays: it calls a backend method that returns `bucket.getUrl(key)` (or `null`) and answers with a `302` redirect to it, or with the original's 404. Links in pages, bookmarks and links in emails keep working, and no page has to carry a presigned URL that expires. Replacing the links with presigned URLs and deleting the route removes a URL the app serves, which a migration must not do.
- URLs expire. `expiresIn` is in seconds, an integer from 1 to 604800 (7 days), default 3600. Resolve URLs at request time. A URL saved in the database or in a statically generated page stops working after it expires.
- For files that users upload, pass `attachment: true` or `attachment: 'name.pdf'` to `getUrl`/`getFileHandle`, or restrict `allowedContentTypes`. An HTML or SVG file shown inline runs script.
- Seed files that the old app shipped in `public/uploads` and that never change can stay in the frontend build as static assets.
- Existing user files need a one-time copy into the bucket. Record it in `MIGRATION.md` under After deploy.

## Listing and deleting

```ts
const files: { path: string; size: number; lastModified: Date }[] = [];
for await (const f of uploads.scan({ prefix: `avatars/${encodeURIComponent(user.userSub)}/` })) files.push(f);
await uploads.delete(key);          // no error when the file is absent
await uploads.deleteBatch(keys);    // validates every key first
```

- `scan()` returns `path`, `size`, `lastModified`. Only `get()` returns `contentType` and `metadata`, and it reads the whole body.
- Versioning is on by default. `delete(key)` adds a delete marker; `get()` then returns `null` and `scan()` omits the key. Old versions expire after 90 days (`noncurrentVersionExpirationDays`). Pass `versioned: false` when the app replaces files often and needs no history.

## Local dev compared with AWS

- The mock stores files in `.bb-data/<fullId>/content/<key>`. `rm -rf .bb-data` wipes them.
- Local presigned URLs point at the dev server: `/.bb-file-bucket/<fullId>/<path>?token=...`. They work only while `cdk-blocks dev` runs.
- Local downloads always carry `Content-Disposition: attachment` and `X-Content-Type-Options: nosniff`, so a file never renders inline when opened directly. S3 sends no `Content-Disposition` unless `attachment` was signed. Test inline rendering in a sandbox.
- CORS rules, lifecycle rules, encryption and IAM have no effect locally.
- S3 stores metadata keys in lowercase; the mock keeps the case. Use lowercase metadata keys.
- No extra environment setting is needed for presigned uploads. The SDK adds an `x-amz-checksum-crc32` query parameter to the URL and S3 accepts the upload with it.
- Local check: call the upload method through the client, `PUT` a file to the returned URL with the signed `Content-Type`, then read it back through the download method.
