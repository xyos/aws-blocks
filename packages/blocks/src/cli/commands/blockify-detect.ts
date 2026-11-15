// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * What `cdk-blocks blockify-app playbook` reads from an app that is not on AWS Blocks
 * yet: the package manager, the framework and how it renders, and the
 * surfaces a migration has to cover (data, auth, storage, jobs, secrets, AI),
 * each with the file or dependency that shows it.
 *
 * Detection reads `package.json`, lockfiles, a few config files and a bounded
 * number of source files. It runs no code of the app and makes no network
 * request. It finds what the listed dependencies and patterns show, so the
 * playbook tells the reader to check the result against the repository.
 */

import { type Dirent, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, posix as posixPath, relative } from 'node:path';

/** The part of the app a signal belongs to; guides are chosen from these. */
export type SignalCategory =
	| 'hosting'
	| 'api'
	| 'data'
	| 'key-value'
	| 'auth'
	| 'storage'
	| 'jobs'
	| 'secrets'
	| 'ai'
	| 'realtime'
	| 'email'
	| 'platform'
	| 'package-manager';

export interface Signal {
	/** A stable name: `prisma`, `next-edge-runtime`, `vercel-cron`. */
	id: string;
	category: SignalCategory;
	/** Where it was seen: a dependency name, or a path relative to the app root. */
	evidence: string;
}

export type PackageManager = 'npm' | 'pnpm' | 'yarn' | 'bun';

export type Framework =
	| 'nextjs'
	| 'nuxt'
	| 'astro'
	| 'sveltekit'
	| 'remix'
	| 'react-router'
	| 'tanstack-start'
	| 'gatsby'
	| 'docusaurus'
	| 'angular'
	| 'vite'
	| 'create-react-app'
	| 'static-html'
	| 'server-only'
	| 'unknown';

/** How the app reaches the browser today: rendered per request, built to files, or one client-routed page. */
export type Rendering = 'ssr' | 'static' | 'spa' | 'none' | 'unknown';

export interface AppProfile {
	/** `package.json#name`, or `null` without one. */
	name: string | null;
	hasPackageJson: boolean;
	/** The app already has an `aws-blocks/` directory. */
	blocks: boolean;
	packageManager: PackageManager;
	/** Lockfiles at the app root. More than one breaks the deploy-time bundling. */
	lockfiles: string[];
	framework: Framework;
	/** The dependency whose version is the framework's (`next`, `vite`), or `null` when no package shows the framework. */
	frameworkPackage: string | null;
	/**
	 * The framework's version: the installed one when `node_modules` or the npm
	 * lockfile has it, else the range in `package.json` as written (`^15.5.0`); `null` without one.
	 */
	frameworkVersion: string | null;
	rendering: Rendering;
	/** `package.json#scripts.build`, or `null`. */
	buildScript: string | null;
	/** `package.json#scripts.start`, or `null`. */
	startScript: string | null;
	/** Names of the environment variables the app reads or documents, sorted. Values are never read. */
	envVars: string[];
}

export interface Detection {
	app: AppProfile;
	signals: Signal[];
}

interface PackageJson {
	name?: unknown;
	packageManager?: unknown;
	scripts?: Record<string, unknown>;
	dependencies?: Record<string, unknown>;
	devDependencies?: Record<string, unknown>;
	workspaces?: unknown;
}

/** Directories that hold no app source, skipped at any depth. */
const SKIPPED_DIRS: ReadonlySet<string> = new Set([
	'node_modules',
	'.git',
	'dist',
	'build',
	'out',
	'coverage',
	'cdk.out',
	'aws-blocks',
	'.next',
	'.nuxt',
	'.output',
	'.svelte-kit',
	'.astro',
	'.vite',
	'.turbo',
	'.cache',
	'.vercel',
	'.netlify',
	'.open-next',
	'.bb-data',
	'.blocks-sandbox',
]);

/** Source files whose text is scanned. */
const SOURCE_FILE = /\.(?:[cm]?[jt]sx?|vue|svelte|astro)$/;

/** At most this many source files are read, so a large repository costs a bounded scan. */
const MAX_SCANNED_FILES = 3000;

/** Larger files are generated or vendored code. */
const MAX_SCANNED_BYTES = 512 * 1024;

const LOCKFILES: Readonly<Record<string, PackageManager>> = {
	'package-lock.json': 'npm',
	'npm-shrinkwrap.json': 'npm',
	'pnpm-lock.yaml': 'pnpm',
	'yarn.lock': 'yarn',
	'bun.lock': 'bun',
	'bun.lockb': 'bun',
};

/** Packages that are an HTTP server of their own: with no frontend framework, the app is a server only. */
const NODE_SERVER = /^(?:express|fastify|hono|koa|@nestjs\/core|@hapi\/hapi)$/;

/** A dependency that shows a migration surface. */
interface DependencyRule {
	match: RegExp;
	id: string;
	category: SignalCategory;
}

const DEPENDENCY_RULES: readonly DependencyRule[] = [
	// Relational data
	{ match: /^(?:@prisma\/client|prisma)$/, id: 'prisma', category: 'data' },
	{ match: /^drizzle-(?:orm|kit)$/, id: 'drizzle', category: 'data' },
	{ match: /^pg$/, id: 'pg', category: 'data' },
	{ match: /^postgres$/, id: 'postgres-js', category: 'data' },
	{ match: /^@vercel\/postgres$/, id: 'vercel-postgres', category: 'data' },
	{ match: /^@neondatabase\/serverless$/, id: 'neon', category: 'data' },
	{ match: /^(?:mysql2?|@planetscale\/database)$/, id: 'mysql', category: 'data' },
	{ match: /^(?:better-sqlite3|sqlite3|@libsql\/client)$/, id: 'sqlite', category: 'data' },
	{ match: /^(?:mongoose|mongodb)$/, id: 'mongodb', category: 'data' },
	{ match: /^(?:kysely|knex|typeorm|sequelize|@mikro-orm\/core)$/, id: 'sql-query-builder', category: 'data' },
	{ match: /^firebase(?:-admin)?$/, id: 'firebase', category: 'data' },
	// Key-value
	{ match: /^@vercel\/kv$/, id: 'vercel-kv', category: 'key-value' },
	{ match: /^@upstash\/redis$/, id: 'upstash-redis', category: 'key-value' },
	{ match: /^(?:ioredis|redis)$/, id: 'redis', category: 'key-value' },
	// Auth
	{ match: /^(?:next-auth|@auth\/.+)$/, id: 'authjs', category: 'auth' },
	{ match: /^better-auth$/, id: 'better-auth', category: 'auth' },
	{ match: /^@clerk\/.+$/, id: 'clerk', category: 'auth' },
	{ match: /^(?:@auth0\/.+|auth0)$/, id: 'auth0', category: 'auth' },
	{ match: /^(?:passport|passport-.+)$/, id: 'passport', category: 'auth' },
	{ match: /^(?:lucia|iron-session|express-session|cookie-session)$/, id: 'sessions', category: 'auth' },
	{ match: /^@supabase\/(?:supabase-js|ssr|auth-helpers-.+)$/, id: 'supabase', category: 'platform' },
	// Files
	{ match: /^(?:multer|formidable|busboy|express-fileupload)$/, id: 'multipart-uploads', category: 'storage' },
	{ match: /^@vercel\/blob$/, id: 'vercel-blob', category: 'storage' },
	{ match: /^(?:uploadthing|@uploadthing\/.+)$/, id: 'uploadthing', category: 'storage' },
	{
		match: /^(?:@aws-sdk\/client-s3|@google-cloud\/storage|cloudinary)$/,
		id: 'object-storage-sdk',
		category: 'storage',
	},
	// Jobs
	{ match: /^(?:node-cron|cron|node-schedule|agenda)$/, id: 'in-process-cron', category: 'jobs' },
	{ match: /^(?:bullmq|bull|bee-queue|pg-boss)$/, id: 'job-queue', category: 'jobs' },
	{ match: /^(?:inngest|@trigger\.dev\/sdk|@upstash\/qstash)$/, id: 'hosted-jobs', category: 'jobs' },
	// AI
	{
		match: /^(?:openai|@anthropic-ai\/sdk|@google\/generative-ai|replicate|cohere-ai)$/,
		id: 'llm-sdk',
		category: 'ai',
	},
	{ match: /^(?:ai|@ai-sdk\/.+)$/, id: 'vercel-ai-sdk', category: 'ai' },
	{ match: /^(?:langchain|@langchain\/.+|llamaindex)$/, id: 'llm-framework', category: 'ai' },
	// Webhooks and raw HTTP
	{ match: /^(?:stripe|svix|@octokit\/webhooks)$/, id: 'webhooks', category: 'api' },
	// Servers
	{ match: NODE_SERVER, id: 'node-server', category: 'api' },
	{ match: /^(?:@trpc\/server|graphql|@apollo\/server|graphql-yoga)$/, id: 'rpc-or-graphql', category: 'api' },
	// Realtime and email
	{ match: /^(?:socket\.io|ws|pusher|ably|@liveblocks\/.+)$/, id: 'websockets', category: 'realtime' },
	{ match: /^(?:resend|nodemailer|@sendgrid\/mail|postmark|mailgun\.js)$/, id: 'email', category: 'email' },
	// Platform packages that do nothing, or need a replacement, off their platform
	{
		match: /^@vercel\/(?:analytics|speed-insights|og|edge-config|flags)$/,
		id: 'vercel-platform-package',
		category: 'platform',
	},
	{ match: /^@netlify\/.+$/, id: 'netlify-platform-package', category: 'platform' },
	{ match: /^@replit\/.+$/, id: 'replit-platform-package', category: 'platform' },
];

/** A pattern in source text that shows a migration surface. One signal per pattern, with the first file that has it. */
interface SourceRule {
	pattern: RegExp;
	id: string;
	category: SignalCategory;
	/** Only checked for this framework. */
	framework?: Framework;
	/** Only checked when the app runs code on a server: it renders on one, or has a Node.js server of its own. */
	server?: true;
}

const SOURCE_RULES: readonly SourceRule[] = [
	{ pattern: /\bruntime\s*[:=]\s*['"]edge['"]/, id: 'next-edge-runtime', category: 'hosting', framework: 'nextjs' },
	{ pattern: /^\s*['"]use server['"]/m, id: 'next-server-actions', category: 'api', framework: 'nextjs' },
	{
		pattern:
			/\b(?:export\s+const\s+revalidate\s*=|revalidatePath\(|revalidateTag\(|unstable_cache\(|next:\s*\{\s*revalidate)/,
		id: 'next-revalidation',
		category: 'hosting',
		framework: 'nextjs',
	},
	{ pattern: /\bgetServerSideProps\b/, id: 'next-get-server-side-props', category: 'hosting', framework: 'nextjs' },
	{ pattern: /from\s+['"]next\/image['"]/, id: 'next-image', category: 'hosting', framework: 'nextjs' },
	{
		pattern: /\b(?:writeFile(?:Sync)?|createWriteStream|appendFile(?:Sync)?|mkdir(?:Sync)?)\s*\(/,
		id: 'local-disk-writes',
		category: 'storage',
	},
	{ pattern: /\bsetInterval\s*\(/, id: 'in-process-timer', category: 'jobs' },
	// A module-level `Map` or `Set` that starts empty is filled by requests: a cart, sessions, a rate limit. One
	// that is built from data (`new Map(products.map(…))`) is a lookup table, and is left alone.
	{
		pattern:
			/^(?:export\s+)?(?:const|let|var)\s+\w+(?:\s*:[^=\n]+)?\s*=\s*new\s+(?:Map|Set)\s*(?:<[^\n]*>)?\s*\(\s*\)/m,
		id: 'in-memory-state',
		category: 'key-value',
		server: true,
	},
	{ pattern: /\bnew\s+WebSocket(?:Server)?\s*\(/, id: 'websockets', category: 'realtime' },
	{ pattern: /text\/event-stream|new\s+ReadableStream\s*\(/, id: 'streaming-responses', category: 'api' },
	// A page that the app's own HTTP server renders: `res.render('home')` (Express), `ctx.render('home')` (Koa),
	// `reply.view('home')` (Fastify), or a `view engine` setting.
	{
		pattern: /\b(?:res|reply|ctx)\.(?:render|view)\s*\(\s*['"`]|\.set\(\s*['"]view engine['"]/,
		id: 'server-rendered-views',
		category: 'hosting',
	},
];

/**
 * Files that are HTTP endpoints by the framework's routing convention. Next.js
 * is listed whatever it renders; the others only for an app that renders on a
 * server, since a static build runs such a file once, at build time
 * (`src/pages/rss.xml.js` of an Astro blog).
 */
const ROUTE_FILES: Partial<Record<Framework, { pattern: RegExp; id: string; staticToo?: true }>> = {
	nextjs: {
		pattern: /(?:^|\/)(?:app\/.*\/route|pages\/api\/.+)\.[cm]?[jt]sx?$/,
		id: 'next-route-handlers',
		staticToo: true,
	},
	nuxt: { pattern: /(?:^|\/)server\/(?:api|routes)\/.+\.[cm]?[jt]s$/, id: 'nuxt-server-routes' },
	sveltekit: { pattern: /(?:^|\/)src\/routes\/(?:.+\/)?\+server\.[jt]s$/, id: 'sveltekit-endpoints' },
	astro: { pattern: /(?:^|\/)src\/pages\/.+\.[cm]?[jt]s$/, id: 'astro-endpoints' },
};

/** `process.env.NAME`, `process.env['NAME']`, `import.meta.env.NAME` and `Deno.env.get('NAME')`. */
const ENV_READ =
	/(?:process\.env|import\.meta\.env)\.([A-Z][A-Z0-9_]*)|process\.env\[['"]([A-Z][A-Z0-9_]*)['"]\]|Deno\.env\.get\(['"]([A-Z][A-Z0-9_]*)['"]\)/g;

/** Variables the runtime or the build tool sets; they are not app configuration. */
const AMBIENT_ENV: ReadonlySet<string> = new Set([
	'NODE_ENV',
	'PORT',
	'HOST',
	'HOSTNAME',
	'CI',
	'TZ',
	'PWD',
	'HOME',
	'PATH',
	'DEV',
	'PROD',
	'SSR',
	'MODE',
	'BASE_URL',
	'NEXT_RUNTIME',
	'NEXT_PHASE',
]);

function readText(path: string): string | undefined {
	try {
		const stats = statSync(path);
		if (!stats.isFile() || stats.size > MAX_SCANNED_BYTES) return undefined;
		return readFileSync(path, 'utf-8');
	} catch {
		return undefined;
	}
}

function isDirectory(path: string): boolean {
	return statSync(path, { throwIfNoEntry: false })?.isDirectory() === true;
}

function isFile(path: string): boolean {
	return statSync(path, { throwIfNoEntry: false })?.isFile() === true;
}

/** The first of `names` that is a file under `root`, relative to it. */
function firstFile(root: string, names: readonly string[]): string | undefined {
	return names.find((name) => isFile(join(root, name)));
}

/** The JSON object in the file at `path`, of any size, or `undefined` when it is missing or is not one. */
function readJsonObject(path: string): Record<string, unknown> | undefined {
	try {
		const parsed: unknown = JSON.parse(readFileSync(path, 'utf-8').replace(/^\uFEFF/, ''));
		return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
			? (parsed as Record<string, unknown>)
			: undefined;
	} catch {
		return undefined;
	}
}

/** The version of dependency `name` that is installed, or that the npm lockfile pins. */
function installedVersion(root: string, name: string): string | undefined {
	const installed = readJsonObject(join(root, 'node_modules', name, 'package.json'))?.version;
	if (typeof installed === 'string') return installed;
	const packages = readJsonObject(join(root, 'package-lock.json'))?.packages;
	if (typeof packages !== 'object' || packages === null) return undefined;
	const entry: unknown = Object.hasOwn(packages, `node_modules/${name}`)
		? (packages as Record<string, unknown>)[`node_modules/${name}`]
		: undefined;
	return typeof entry === 'object' && entry !== null && 'version' in entry && typeof entry.version === 'string'
		? entry.version
		: undefined;
}

/** The source files under `root`, relative to it with `/` separators, in directory order; at most {@link MAX_SCANNED_FILES}. */
function sourceFiles(root: string): string[] {
	const files: string[] = [];
	const walk = (dir: string): void => {
		let entries: Dirent[];
		try {
			entries = readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
		} catch {
			return;
		}
		for (const entry of entries) {
			if (files.length >= MAX_SCANNED_FILES) return;
			const path = join(dir, entry.name);
			if (entry.isDirectory()) {
				if (!SKIPPED_DIRS.has(entry.name)) walk(path);
			} else if (entry.isFile() && SOURCE_FILE.test(entry.name)) {
				files.push(relative(root, path).split('\\').join('/'));
			}
		}
	};
	walk(root);
	return files;
}

/**
 * The first source file of the app, outside `aws-blocks/`, whose text matches
 * `pattern`; relative to `root`. Files whose path matches `skip` are not read.
 */
export function findInSources(root: string, pattern: RegExp, skip?: RegExp): string | undefined {
	return sourceFiles(root).find((file) => !skip?.test(file) && pattern.test(readText(join(root, file)) ?? ''));
}

/** The package manager that `manifest` pins (`"packageManager": "pnpm@10.1.0"`), if it pins one. */
function pinnedManager(manifest: PackageJson | undefined): PackageManager | undefined {
	const pinned =
		typeof manifest?.packageManager === 'string'
			? /^(npm|pnpm|yarn|bun)@/.exec(manifest.packageManager)?.[1]
			: undefined;
	return pinned as PackageManager | undefined;
}

/**
 * The package manager of the workspace that `root` is a package of: the pin or
 * the lockfile of the nearest directory above it, up to the root of the git
 * repository. Outside a git repository nothing above `root` is read, since a
 * lockfile there need not belong to this app.
 */
function workspaceManager(root: string): PackageManager | undefined {
	const above: string[] = [];
	for (let dir = dirname(root); dir !== dirname(dir) && above.length < 8; dir = dirname(dir)) {
		above.push(dir);
		if (statSync(join(dir, '.git'), { throwIfNoEntry: false }) !== undefined) {
			for (const candidate of above) {
				const lockfile = Object.keys(LOCKFILES).find((name) => isFile(join(candidate, name)));
				const manager =
					pinnedManager(readJsonObject(join(candidate, 'package.json')) as PackageJson | undefined) ??
					(lockfile ? LOCKFILES[lockfile] : undefined);
				if (manager) return manager;
			}
			return undefined;
		}
	}
	return undefined;
}

function detectPackageManager(
	root: string,
	pkg: PackageJson | undefined,
): Pick<AppProfile, 'packageManager' | 'lockfiles'> {
	const lockfiles = Object.keys(LOCKFILES).filter((name) => isFile(join(root, name)));
	const own = pinnedManager(pkg) ?? (lockfiles[0] ? LOCKFILES[lockfiles[0]] : undefined);
	// A package of a monorepo has no lockfile of its own.
	return { packageManager: own ?? workspaceManager(root) ?? 'npm', lockfiles };
}

/** The value of a string option in a config file's text: `basePath: '/docs'` gives `/docs`. */
function configString(text: string, key: string): string | undefined {
	return new RegExp(`\\b${key}\\s*:\\s*(['"\`])([^'"\`]*)\\1`).exec(text)?.[2];
}

interface FrameworkResult {
	framework: Framework;
	/** The dependency that shows the framework, whose version is the framework's. */
	dependency: string | null;
	rendering: Rendering;
	signals: Signal[];
}

function detectNext(root: string): FrameworkResult {
	const signals: Signal[] = [];
	const add = (id: string, evidence: string) => signals.push({ id, category: 'hosting', evidence });
	const config = firstFile(root, ['next.config.ts', 'next.config.mjs', 'next.config.js', 'next.config.cjs']);
	const configText = config ? (readText(join(root, config)) ?? '') : '';
	const output = configString(configText, 'output');
	const basePath = configString(configText, 'basePath');
	if (config && output === 'export') add('next-static-export', config);
	if (config && basePath) add('next-base-path', `${config} (basePath: '${basePath}')`);
	if (config && /\btrailingSlash\s*:\s*true\b/.test(configText)) add('next-trailing-slash', config);
	for (const dir of ['app', 'src/app']) if (isDirectory(join(root, dir))) add('next-app-router', `${dir}/`);
	for (const dir of ['pages', 'src/pages']) if (isDirectory(join(root, dir))) add('next-pages-router', `${dir}/`);
	const middleware = firstFile(
		root,
		['middleware', 'src/middleware', 'proxy', 'src/proxy'].flatMap((base) => [`${base}.ts`, `${base}.js`]),
	);
	if (middleware) add('next-middleware', middleware);
	return { framework: 'nextjs', dependency: 'next', rendering: output === 'export' ? 'static' : 'ssr', signals };
}

function detectFramework(root: string, deps: Readonly<Record<string, string>>): FrameworkResult {
	const result = (framework: Framework, rendering: Rendering, dependency: string | null): FrameworkResult => ({
		framework,
		dependency,
		rendering,
		signals: [],
	});
	if (deps.next !== undefined) return detectNext(root);
	if (deps.nuxt !== undefined) return result('nuxt', 'ssr', 'nuxt');
	if (deps['@sveltejs/kit'] !== undefined) {
		return result('sveltekit', deps['@sveltejs/adapter-static'] !== undefined ? 'static' : 'ssr', '@sveltejs/kit');
	}
	if (deps.astro !== undefined) {
		const ssr = Object.keys(deps).some((name) => /^@astrojs\/(?:node|vercel|netlify|cloudflare)$/.test(name));
		return result('astro', ssr ? 'ssr' : 'static', 'astro');
	}
	if (deps['@tanstack/react-start'] !== undefined || deps['@tanstack/start'] !== undefined) {
		return result(
			'tanstack-start',
			'ssr',
			deps['@tanstack/react-start'] !== undefined ? '@tanstack/react-start' : '@tanstack/start',
		);
	}
	if (Object.keys(deps).some((name) => name.startsWith('@remix-run/')))
		return result('remix', 'ssr', '@remix-run/react');
	if (deps['@react-router/dev'] !== undefined) {
		// Framework mode renders on a server unless its config turns that off (`ssr: false`, "SPA mode").
		const config = firstFile(
			root,
			['ts', 'mts', 'js', 'mjs'].map((extension) => `react-router.config.${extension}`),
		);
		const spaMode = config !== undefined && /\bssr\s*:\s*false\b/.test(readText(join(root, config)) ?? '');
		return result('react-router', spaMode ? 'spa' : 'ssr', '@react-router/dev');
	}
	if (deps.gatsby !== undefined) return result('gatsby', 'static', 'gatsby');
	if (deps['@docusaurus/core'] !== undefined) return result('docusaurus', 'static', '@docusaurus/core');
	if (deps['@angular/core'] !== undefined)
		return result('angular', deps['@angular/ssr'] !== undefined ? 'ssr' : 'spa', '@angular/core');
	if (deps.vite !== undefined) return result('vite', 'spa', 'vite');
	if (deps['react-scripts'] !== undefined) return result('create-react-app', 'spa', 'react-scripts');
	if (isFile(join(root, 'index.html'))) return result('static-html', 'static', null);
	if (Object.keys(deps).some((name) => NODE_SERVER.test(name))) return result('server-only', 'none', null);
	return result('unknown', 'unknown', null);
}

/** Signals from the files that deployment platforms and data tools keep at the app root. */
function fileSignals(root: string): Signal[] {
	const signals: Signal[] = [];
	const vercel = readText(join(root, 'vercel.json'));
	if (vercel !== undefined) {
		signals.push({ id: 'vercel-config', category: 'platform', evidence: 'vercel.json' });
		if (/"crons"\s*:/.test(vercel))
			signals.push({ id: 'vercel-cron', category: 'jobs', evidence: 'vercel.json (crons)' });
		if (/"(?:rewrites|redirects|headers)"\s*:/.test(vercel)) {
			signals.push({
				id: 'vercel-routing',
				category: 'hosting',
				evidence: 'vercel.json (rewrites, redirects or headers)',
			});
		}
	}
	const platformFiles: readonly [string, string][] = [
		['netlify.toml', 'netlify-config'],
		['.replit', 'replit-config'],
		['wrangler.toml', 'cloudflare-config'],
		['fly.toml', 'fly-config'],
		['render.yaml', 'render-config'],
		['Procfile', 'procfile'],
		['Dockerfile', 'dockerfile'],
	];
	for (const [file, id] of platformFiles) {
		if (isFile(join(root, file))) signals.push({ id, category: 'platform', evidence: file });
	}
	if (isDirectory(join(root, 'supabase', 'functions'))) {
		signals.push({ id: 'supabase-edge-functions', category: 'api', evidence: 'supabase/functions/' });
	}
	if (isDirectory(join(root, 'supabase', 'migrations'))) {
		signals.push({ id: 'supabase-migrations', category: 'platform', evidence: 'supabase/migrations/' });
	}
	if (isFile(join(root, 'prisma', 'schema.prisma'))) {
		signals.push({ id: 'prisma-schema', category: 'data', evidence: 'prisma/schema.prisma' });
	}
	const drizzle = firstFile(root, ['drizzle.config.ts', 'drizzle.config.js', 'drizzle.config.mjs']);
	if (drizzle) signals.push({ id: 'drizzle-config', category: 'data', evidence: drizzle });
	if (isDirectory(join(root, 'amplify')))
		signals.push({ id: 'amplify-backend', category: 'platform', evidence: 'amplify/' });
	return signals;
}

/** The variable names that an env example file documents; values are not read. */
function envFileNames(root: string): string[] {
	const names: string[] = [];
	for (const file of ['.env.example', '.env.sample', '.env.template', '.env.local.example']) {
		const text = readText(join(root, file));
		if (text === undefined) continue;
		for (const line of text.split(/\r?\n/)) {
			const name = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/.exec(line)?.[1];
			if (name) names.push(name);
		}
	}
	return names;
}

/**
 * Detect what the app at `root` is built with and which surfaces a migration to
 * AWS Blocks has to cover. Never throws for a missing or unreadable file: what
 * cannot be read is not reported.
 */
export function detectApp(root: string): Detection {
	const pkg = readJsonObject(join(root, 'package.json')) as PackageJson | undefined;
	const deps: Record<string, string> = {};
	for (const group of [pkg?.devDependencies, pkg?.dependencies]) {
		for (const [name, range] of Object.entries(group ?? {})) if (typeof range === 'string') deps[name] = range;
	}
	const { packageManager, lockfiles } = detectPackageManager(root, pkg);
	const framework = detectFramework(root, deps);
	const signals: Signal[] = [...framework.signals];
	const seen = new Set(signals.map((signal) => signal.id));
	const add = (signal: Signal): void => {
		if (seen.has(signal.id)) return;
		seen.add(signal.id);
		signals.push(signal);
	};

	if (lockfiles.length > 1) {
		add({ id: 'multiple-lockfiles', category: 'package-manager', evidence: lockfiles.join(', ') });
	}
	if (packageManager !== 'npm') {
		add({
			id: `${packageManager}-package-manager`,
			category: 'package-manager',
			evidence: lockfiles[0] ?? 'package.json (packageManager)',
		});
	}
	if (pkg?.workspaces !== undefined || isFile(join(root, 'pnpm-workspace.yaml'))) {
		add({
			id: 'workspaces',
			category: 'package-manager',
			evidence: pkg?.workspaces !== undefined ? 'package.json (workspaces)' : 'pnpm-workspace.yaml',
		});
	}
	for (const name of Object.keys(deps).sort()) {
		const rule = DEPENDENCY_RULES.find((candidate) => candidate.match.test(name));
		if (rule) add({ id: rule.id, category: rule.category, evidence: `${name} in package.json` });
	}
	for (const signal of fileSignals(root)) add(signal);

	const envVars = new Set(envFileNames(root));
	const runsOnServer = framework.rendering === 'ssr' || seen.has('node-server');
	const sourceRules = SOURCE_RULES.filter(
		(rule) =>
			(rule.framework === undefined || rule.framework === framework.framework) &&
			(rule.server !== true || runsOnServer),
	);
	const routes = ROUTE_FILES[framework.framework];
	const routeFiles = routes !== undefined && (routes.staticToo === true || framework.rendering === 'ssr');
	for (const file of sourceFiles(root)) {
		const text = readText(join(root, file));
		if (text === undefined) continue;
		for (const rule of sourceRules) {
			if (!seen.has(rule.id) && rule.pattern.test(text))
				add({ id: rule.id, category: rule.category, evidence: file });
		}
		for (const match of text.matchAll(ENV_READ)) envVars.add(match[1] ?? match[2] ?? match[3]);
		// Framework route files are the app's HTTP API.
		if (routeFiles && routes.pattern.test(file)) {
			add({ id: routes.id, category: 'api', evidence: posixPath.dirname(file) });
		}
	}
	for (const name of AMBIENT_ENV) envVars.delete(name);
	const names = [...envVars].sort();
	if (names.length > 0) {
		add({
			id: 'environment-variables',
			category: 'secrets',
			evidence: `${names.length} variable name${names.length === 1 ? '' : 's'} read or documented`,
		});
	}

	const script = (name: string): string | null => {
		const value = pkg?.scripts?.[name];
		return typeof value === 'string' ? value : null;
	};
	return {
		app: {
			name: typeof pkg?.name === 'string' ? pkg.name : null,
			hasPackageJson: pkg !== undefined,
			blocks: isDirectory(join(root, 'aws-blocks')),
			packageManager,
			lockfiles,
			framework: framework.framework,
			frameworkPackage: framework.dependency,
			frameworkVersion:
				framework.dependency === null
					? null
					: (installedVersion(root, framework.dependency) ?? deps[framework.dependency] ?? null),
			rendering: framework.rendering,
			buildScript: script('build'),
			startScript: script('start'),
			envVars: names,
		},
		signals,
	};
}
