// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { OPENNEXT_VERIFIED_RANGE } from './commands/blockify-check.js';
import {
	GUIDE_TAGS,
	listGuides,
	NEXT_SUPPORTED_RANGE,
	rangeStanding,
	SKILL_DIR,
	selectSections,
} from './commands/blockify-playbook.js';
import { SERVER_FUNCTION_PATH } from './commands/blockify-server.js';
import { runCli } from './test-helpers.js';

const created: string[] = [];
after(() => {
	for (const dir of created) rmSync(dir, { recursive: true, force: true });
});

/** Write `files` to a fresh temporary directory; returns it. */
function writeApp(files: Record<string, string>): string {
	const root = mkdtempSync(join(tmpdir(), 'blocks-blockify-app-'));
	created.push(root);
	for (const [path, text] of Object.entries(files)) {
		mkdirSync(dirname(join(root, path)), { recursive: true });
		writeFileSync(join(root, path), text);
	}
	return root;
}

function pkg(dependencies: Record<string, string>, extra: Record<string, unknown> = {}): string {
	return `${JSON.stringify({ name: 'notes-app', scripts: { build: 'next build', start: 'next start' }, dependencies, ...extra }, null, 2)}\n`;
}

/** A server-rendered Next.js app with the given `next` version and extra files. */
function nextApp(next: string, files: Record<string, string> = {}, dependencies: Record<string, string> = {}): string {
	return writeApp({
		'package.json': pkg({ next, react: '19.0.0', ...dependencies }),
		'package-lock.json': '{}\n',
		'app/page.tsx': 'export default function Home() { return null }\n',
		...files,
	});
}

interface Playbook {
	app: {
		framework: string;
		frameworkVersion: string | null;
		rendering: string;
		packageManager: string;
		envVars: string[];
	};
	signals: { id: string; category: string; evidence: string }[];
	blockers: { id: string }[];
	notes: string[];
	guides: { name: string; recommended: boolean }[];
	playbook: string | null;
}

async function playbookOf(root: string): Promise<{ code: number; result: Playbook }> {
	const run = await runCli(['blockify-app', 'playbook', '--output', 'json'], { cwd: root });
	return { code: run.code, result: JSON.parse(run.stdout) as Playbook };
}

const recommended = (result: Playbook): string[] =>
	result.guides.filter((guide) => guide.recommended).map((guide) => guide.name);

describe('cdk-blocks blockify-app playbook', () => {
	it('keeps the sections and recommends the guides for the surfaces the app has, and no others', async () => {
		const plain = await playbookOf(nextApp('16.4.2'));
		assert.strictEqual(plain.code, 0);
		assert.deepStrictEqual(recommended(plain.result), ['nextjs']);
		assert.doesNotMatch(plain.result.playbook ?? '', /goes to the `Database` block/);
		assert.doesNotMatch(plain.result.playbook ?? '', /is replaced by the `Auth` block/);
		assert.doesNotMatch(plain.result.playbook ?? '', /stays on Supabase/);

		const full = await playbookOf(
			nextApp(
				'16.4.2',
				{
					'prisma/schema.prisma': 'model Note { id Int @id }\n',
					'vercel.json': '{"crons":[{"path":"/api/x","schedule":"0 3 * * *"}]}\n',
				},
				{ '@prisma/client': '^6.0.0', 'next-auth': '^4.24.0' },
			),
		);
		assert.match(full.result.playbook ?? '', /goes to the `Database` block/);
		assert.match(full.result.playbook ?? '', /is replaced by the `Auth` block/);
		assert.doesNotMatch(full.result.playbook ?? '', /stays on Supabase/);
		for (const guide of ['auth', 'database', 'jobs', 'nextjs'])
			assert.ok(recommended(full.result).includes(guide), guide);

		const supabase = await playbookOf(nextApp('16.4.2', {}, { '@supabase/supabase-js': '^2.0.0' }));
		assert.match(supabase.result.playbook ?? '', /stays on Supabase/);
		assert.ok(recommended(supabase.result).includes('supabase'));
	});

	it('leaves no section marker in the text it prints', async () => {
		const { result } = await playbookOf(nextApp('16.4.2', {}, { pg: '^8.0.0' }));
		assert.doesNotMatch(result.playbook ?? '', /<!--/);
	});

	it('refuses a server-rendered Next.js major below the supported range, with exit 1 and no playbook', async () => {
		const root = nextApp('14.2.35');
		const { code, result } = await playbookOf(root);
		assert.strictEqual(code, 1);
		assert.strictEqual(result.playbook, null);
		assert.deepStrictEqual(
			result.blockers.map((blocker) => blocker.id),
			['next-major-unsupported'],
		);
		const text = await runCli(['blockify-app', 'playbook'], { cwd: root });
		assert.strictEqual(text.code, 1);
		assert.match(text.stdout, /Next\.js 14\.2\.35/);
		assert.doesNotMatch(text.stdout, /## Scaffold task/);
	});

	it('does not refuse a static export of the same Next.js version: it has no server to host', async () => {
		const root = nextApp('14.2.35', { 'next.config.mjs': "export default { output: 'export' }\n" });
		const { code, result } = await playbookOf(root);
		assert.strictEqual(code, 0);
		assert.strictEqual(result.app.rendering, 'static');
		assert.deepStrictEqual(result.blockers, []);
	});

	it('refuses React Router framework mode while it renders on a server, and not once the app turned that off', async () => {
		const app = (config: string): string =>
			writeApp({
				'package.json': pkg(
					{ 'react-router': '^7.0.0', '@react-router/node': '^7.0.0' },
					{ devDependencies: { '@react-router/dev': '^7.0.0' }, scripts: { build: 'react-router build' } },
				),
				'package-lock.json': '{}\n',
				'react-router.config.ts': `export default { ${config} };\n`,
			});
		const server = await playbookOf(app('ssr: true'));
		assert.strictEqual(server.code, 1);
		assert.strictEqual(server.result.playbook, null);
		assert.deepStrictEqual(
			server.result.blockers.map((blocker) => blocker.id),
			['ssr-framework-unsupported'],
		);
		// Server rendering is the framework's default: a config that does not mention it is refused too.
		assert.strictEqual((await playbookOf(app(''))).code, 1);

		const spa = await playbookOf(app('ssr: false'));
		assert.strictEqual(spa.code, 0);
		assert.strictEqual(spa.result.app.rendering, 'spa');
		assert.deepStrictEqual(spa.result.blockers, []);
	});

	it("sends a page that the app's own server renders to the user's decision, and leaves a JSON server alone", async () => {
		const server = (handler: string): string =>
			writeApp({
				'package.json': pkg({ express: '^4.21.0', ejs: '^3.1.10' }, { scripts: { start: 'node server.js' } }),
				'package-lock.json': '{}\n',
				'server.js': `const app = require('express')()\napp.get('/', (req, res) => ${handler})\napp.listen(3000)\n`,
			});
		const rendered = await playbookOf(server("res.render('index', { entries: [] })"));
		assert.strictEqual(rendered.code, 0);
		assert.ok(rendered.result.signals.some((signal) => signal.id === 'server-rendered-views'));
		assert.ok(rendered.result.notes.some((note) => note.includes('seen in server.js')));
		assert.match(rendered.result.playbook ?? '', /Pages that the app's own server renders/);

		const json = await playbookOf(server('res.json({ entries: [] })'));
		assert.ok(!json.result.signals.some((signal) => signal.id === 'server-rendered-views'));
		assert.doesNotMatch(json.result.playbook ?? '', /Pages that the app's own server renders/);
	});

	it('names the data that server code keeps in memory between requests, and not a lookup table or browser code', async () => {
		const astro = (files: Record<string, string>, onServer = true): string =>
			writeApp({
				'package.json': pkg(
					{ astro: '^5.0.0', ...(onServer ? { '@astrojs/node': '^9.0.0' } : {}) },
					{ scripts: { build: 'astro build' } },
				),
				'package-lock.json': '{}\n',
				'src/pages/index.astro': '<h1>Shop</h1>\n',
				...files,
			});
		const state = {
			// Built from data: a lookup table.
			'src/models/db.ts': 'const byId = new Map(products.map((product) => [product.id, product]));\n',
			'src/models/session.ts':
				'// Normally this would be in a database.\nexport const carts = new Map<string, Item[]>();\n',
		};
		const { result } = await playbookOf(astro(state));
		assert.deepStrictEqual(
			result.signals.filter((signal) => signal.id === 'in-memory-state'),
			[{ id: 'in-memory-state', category: 'key-value', evidence: 'src/models/session.ts' }],
		);
		assert.match(result.playbook ?? '', /keeps in a module-level `Map` or `Set` between requests/);
		for (const guide of ['aws-limits', 'key-value']) assert.ok(recommended(result).includes(guide), guide);

		const lookupOnly = await playbookOf(astro({ 'src/models/db.ts': state['src/models/db.ts'] }));
		assert.ok(!lookupOnly.result.signals.some((signal) => signal.id === 'in-memory-state'));
		assert.doesNotMatch(lookupOnly.result.playbook ?? '', /module-level `Map`/);
		// In an app that is built to static files the same line runs in the browser, or once at build time.
		const staticSite = await playbookOf(astro(state, false));
		assert.ok(!staticSite.result.signals.some((signal) => signal.id === 'in-memory-state'));
	});

	it('counts the endpoint files of Nuxt, SvelteKit and Astro as API routes when the app renders on a server', async () => {
		const app = (dependencies: Record<string, string>, file: string): string =>
			writeApp({
				'package.json': pkg(dependencies, { scripts: { build: 'build' } }),
				'package-lock.json': '{}\n',
				[file]: 'export const GET = () => new Response("[]")\n',
			});
		const cases: [Record<string, string>, string, string][] = [
			[{ nuxt: '^4.0.0' }, 'server/api/feeds.get.ts', 'nuxt-server-routes'],
			[{ '@sveltejs/kit': '^2.0.0' }, 'src/routes/api/tags/+server.js', 'sveltekit-endpoints'],
			[{ astro: '^5.0.0', '@astrojs/node': '^9.0.0' }, 'src/pages/api/cart.ts', 'astro-endpoints'],
		];
		for (const [dependencies, file, id] of cases) {
			const { result } = await playbookOf(app(dependencies, file));
			assert.ok(
				result.signals.some((signal) => signal.id === id && signal.category === 'api'),
				id,
			);
			assert.ok(recommended(result).includes('api-routes'), id);
		}
		// A static Astro build runs such a file once, at build time: it writes a file and is no endpoint.
		const blog = await playbookOf(app({ astro: '^5.0.0' }, 'src/pages/rss.xml.js'));
		assert.deepStrictEqual(
			blog.result.signals.filter((signal) => signal.category === 'api'),
			[],
		);
	});

	it('says that a repository has no package.json, and that it found no surface', async () => {
		const { code, result } = await playbookOf(writeApp({ 'index.html': '<h1>Menu</h1>\n' }));
		assert.strictEqual(code, 0);
		assert.strictEqual(result.app.framework, 'static-html');
		assert.match(result.playbook ?? '', /- App: \(no package\.json\); package manager: npm\./);
		assert.match(result.playbook ?? '', /- Surfaces found: none\./);
	});

	it('sends the root of a monorepo to the package of the app, and reads the package manager of that package from the root', async () => {
		const root = writeApp({
			'package.json':
				'{"name":"shop","private":true,"packageManager":"pnpm@10.20.0","scripts":{"build":"turbo run build"}}\n',
			'pnpm-lock.yaml': "lockfileVersion: '9.0'\n",
			'pnpm-workspace.yaml': 'packages:\n  - apps/*\n',
			'apps/web/package.json': pkg({ next: '16.4.2', react: '19.0.0' }),
			'apps/web/app/page.tsx': 'export default function Home() { return null }\n',
		});
		execFileSync('git', ['init', '-q'], { cwd: root });

		const atRoot = await playbookOf(root);
		assert.strictEqual(atRoot.result.app.framework, 'unknown');
		assert.ok(atRoot.result.notes.some((note) => note.includes('-C <that directory> blockify-app playbook')));

		const inApp = await playbookOf(join(root, 'apps', 'web'));
		assert.strictEqual(inApp.result.app.framework, 'nextjs');
		assert.strictEqual(inApp.result.app.packageManager, 'pnpm');
	});

	it('asks for an upgrade inside the major when the version is below its floor, and for none at the floor', async () => {
		const below = await playbookOf(nextApp('16.3.3'));
		assert.strictEqual(below.code, 0);
		assert.ok(below.result.notes.some((note) => /at least 16\.4\.1/.test(note)));
		const at = await playbookOf(nextApp('16.4.1'));
		assert.ok(!at.result.notes.some((note) => /Upgrade "next"/.test(note)));
	});

	it('reads the installed version before the range in package.json', async () => {
		const root = nextApp('^16.0.0', { 'node_modules/next/package.json': '{"name":"next","version":"16.4.2"}\n' });
		const { result } = await playbookOf(root);
		assert.strictEqual(result.app.frameworkVersion, '16.4.2');
		assert.ok(!result.notes.some((note) => /Upgrade "next"/.test(note)));
	});

	it('reports the names of environment variables and never a value from an env file', async () => {
		const root = nextApp('16.4.2', {
			'.env.example':
				'DATABASE_URL=postgres://example-user:example-value@db.example/app\nSTRIPE_KEY=sk_example_value\n',
			'.env': 'STRIPE_KEY=sk_live_must_not_appear\n',
			'.env.local': 'SESSION_SECRET=local_must_not_appear\n',
			'app/api/pay/route.ts':
				'export async function POST() { return Response.json({ k: process.env.STRIPE_KEY?.length }) }\n',
		});
		const json = await runCli(['blockify-app', 'playbook', '--output', 'json'], { cwd: root });
		const text = await runCli(['blockify-app', 'playbook'], { cwd: root });
		const result = JSON.parse(json.stdout) as Playbook;
		assert.deepStrictEqual(result.app.envVars, ['DATABASE_URL', 'STRIPE_KEY']);
		for (const output of [json.stdout, text.stdout]) {
			for (const value of [
				'sk_live_must_not_appear',
				'local_must_not_appear',
				'sk_example_value',
				'example-value',
			]) {
				assert.ok(!output.includes(value), value);
			}
		}
	});

	it('changes no file of the app', async () => {
		const root = nextApp('16.4.2', {}, { pg: '^8.0.0' });
		const before = readdirSync(root, { recursive: true }).sort();
		await runCli(['blockify-app', 'playbook'], { cwd: root });
		assert.deepStrictEqual(readdirSync(root, { recursive: true }).sort(), before);
	});
});

describe('rangeStanding', () => {
	it('places a version inside the range, below the floor of its major, or on an unsupported major', () => {
		const range = '>=15.5.28 <16 || >=16.4.1';
		assert.deepStrictEqual(rangeStanding('15.5.28', range), { standing: 'supported' });
		assert.deepStrictEqual(rangeStanding('15.5.27', range), { standing: 'upgrade', to: '15.5.28' });
		assert.deepStrictEqual(rangeStanding('16.4.0', range), { standing: 'upgrade', to: '16.4.1' });
		assert.deepStrictEqual(rangeStanding('^16.4.2', range), { standing: 'supported' });
		assert.deepStrictEqual(rangeStanding('17.0.0', range), { standing: 'supported' });
		assert.deepStrictEqual(rangeStanding('14.2.35', range), { standing: 'unsupported', lowest: '15.5.28' });
		assert.strictEqual(rangeStanding('latest', range), undefined);
	});
});

describe('selectSections', () => {
	it('keeps a section when one of its tags is present, and the text outside sections always', () => {
		const text = [
			'a',
			'<!-- when: data auth -->',
			'b',
			'<!-- end -->',
			'c',
			'<!-- when: jobs -->',
			'd',
			'<!-- end -->',
			'e',
		].join('\n');
		assert.strictEqual(selectSections(text, new Set(['auth'])), 'a\nb\nc\ne');
		assert.strictEqual(selectSections(text, new Set()), 'a\nc\ne');
	});
});

describe('cdk-blocks blockify-app guide', () => {
	it('lists every guide without a name, and prints the named guides in order', async () => {
		const list = await runCli(['blockify-app', 'guide', '--output', 'json'], { cwd: tmpdir() });
		const listed: { guides: { name: string }[] } = JSON.parse(list.stdout);
		const names = listed.guides.map((guide) => guide.name);
		assert.deepStrictEqual(
			names,
			listGuides().map((guide) => guide.name),
		);
		assert.ok(!names.includes('playbook'));

		const two = await runCli(['blockify-app', 'guide', 'database', 'auth'], { cwd: tmpdir() });
		assert.strictEqual(two.code, 0);
		const database = two.stdout.indexOf('# Relational data');
		assert.ok(database === 0 && two.stdout.indexOf('\n# ', 1) > database);
	});

	it('exits 2 for an unknown guide and suggests the closest name', async () => {
		const run = await runCli(['blockify-app', 'guide', 'databse'], { cwd: tmpdir() });
		assert.strictEqual(run.code, 2);
		assert.match(run.stderr, /Did you mean "database"\?/);
		assert.strictEqual(run.stdout, '');
	});
});

/** A Next.js app migrated as the playbook says. Tests break one rule at a time. */
function migratedApp(edit: (files: Record<string, string>) => void = () => {}): string {
	const files: Record<string, string> = {
		'package.json': pkg(
			{ next: '16.4.2', react: '19.0.0', '@aws-blocks/blocks': '^0.9.0' },
			{
				scripts: { build: 'cdk-blocks generate client && next build', 'dev:server': 'cdk-blocks dev' },
				devDependencies: {
					'@opennextjs/aws': '4.1.14',
					'aws-cdk': '^2',
					'aws-cdk-lib': '^2.275.0',
					constructs: '^10.8.1',
					tsx: '^4.23.15',
					esbuild: '^0.28.2',
				},
				workspaces: ['aws-blocks'],
			},
		),
		'package-lock.json': '{}\n',
		'.gitignore':
			'node_modules\n.next\n.open-next/\n.hosting/\ncdk.out/\n.bb-data/\n.blocks-sandbox\naws-blocks/client.js\n',
		'.blocks/config.json': '{"stackId":"notes-app-a1b2c3"}\n',
		'cdk.json': '{"app":"npx tsx -C cdk aws-blocks/index.cdk.ts"}\n',
		'aws-blocks/package.json':
			'{"name":"aws-blocks","type":"module","exports":{".":{"types":"./index.ts","default":"./index.ts"}}}\n',
		'aws-blocks/index.ts':
			"import { ApiNamespace, Scope } from '@aws-blocks/blocks';\nconst scope = new Scope('notes-app');\nexport const api = new ApiNamespace(scope, 'api', () => ({ async list() { return []; } }));\n",
		'aws-blocks/index.handler.ts': 'export {};\n',
		'aws-blocks/index.cdk.ts':
			"new Hosting(blocksStack, 'Hosting', { framework: 'nextjs', buildCommand: 'npm run build', api: blocksStack });\n",
		'app/page.tsx':
			"import { api } from 'aws-blocks';\nexport default async function Home() { return (await api.list()).length }\n",
		'MIGRATION.md':
			'# Migration to AWS Blocks\n\n## Plan\n- [x] scaffold\n\n## Blockers\nNone\n\n## Before deploy\nNone\n\n## After deploy\nNone\n\n## Validation\n| Check | Command | Result |\n',
	};
	edit(files);
	const root = writeApp(files);
	execFileSync('git', ['init', '-q'], { cwd: root });
	return root;
}

/** Commit the app as it is, as the user's last commit before the migration. */
function commit(root: string): void {
	const git = ['-c', 'user.email=test@example.com', '-c', 'user.name=test', '-c', 'commit.gpgsign=false'];
	execFileSync('git', [...git, 'add', '-A'], { cwd: root });
	execFileSync('git', [...git, 'commit', '-qm', 'app'], { cwd: root });
}

interface CheckOutput {
	ok: boolean;
	checks: { id: string; ok: boolean; fix: string | null }[];
}

async function failedChecks(root: string): Promise<{ code: number; failed: string[] }> {
	const run = await runCli(['blockify-app', 'check', '--output', 'json'], { cwd: root });
	const result = JSON.parse(run.stdout) as CheckOutput;
	assert.strictEqual(result.ok, run.code === 0);
	for (const check of result.checks) assert.strictEqual(check.fix === null, check.ok, check.id);
	return { code: run.code, failed: result.checks.filter((check) => !check.ok).map((check) => check.id) };
}

describe('cdk-blocks blockify-app check', () => {
	it('passes an app migrated as the playbook says', async () => {
		assert.deepStrictEqual(await failedChecks(migratedApp()), { code: 0, failed: [] });
	});

	it('stops at the scaffold when the app has none, and names the scaffold command', async () => {
		const root = nextApp('16.4.2');
		const run = await runCli(['blockify-app', 'check'], { cwd: root });
		assert.strictEqual(run.code, 1);
		assert.match(run.stdout, /FAIL {2}scaffold/);
		assert.match(run.stdout, /create-blocks-app@latest \. --template nextjs/);
		assert.deepStrictEqual((await failedChecks(root)).failed, ['scaffold']);
	});

	const broken: [string, string, (files: Record<string, string>) => void][] = [
		[
			'an OpenNext range that can leave the verified versions',
			'opennext',
			(files) => {
				files['package.json'] = files['package.json'].replace(
					'"@opennextjs/aws": "4.1.14"',
					'"@opennextjs/aws": "^4.1.14"',
				);
			},
		],
		[
			'a missing CDK command line',
			'dependencies',
			(files) => {
				files['package.json'] = files['package.json'].replace('"aws-cdk": "^2",', '');
			},
		],
		[
			'the demo API of the scaffolder',
			'backend',
			(files) => {
				files['aws-blocks/index.ts'] +=
					'export const demo = new ApiNamespace(scope, "demo", () => ({ async greet(name: string) { return name; } }));\n';
			},
		],
		[
			'an exported function, which would become a public endpoint',
			'backend',
			(files) => {
				files['aws-blocks/index.ts'] += 'export async function deleteAll() {}\n';
			},
		],
		[
			'a scope id that the name of an AWS resource cannot hold',
			'backend',
			(files) => {
				files['aws-blocks/index.ts'] = files['aws-blocks/index.ts'].replace("'notes-app'", "'@acme/notes'");
			},
		],
		[
			'a frontend that imports the client without a build that generates it',
			'client',
			(files) => {
				files['package.json'] = files['package.json'].replace(
					'cdk-blocks generate client && next build',
					'next build',
				);
			},
		],
		[
			'BLOCKS_API_URL in an env file',
			'api-url',
			(files) => {
				files['.env.local'] = 'BLOCKS_API_URL=http://localhost:3001/aws-blocks/api\n';
			},
		],
		[
			'an ignored stack id file',
			'gitignore',
			(files) => {
				files['.gitignore'] += '.blocks/\n';
			},
		],
		[
			'a build directory that git would track',
			'gitignore',
			(files) => {
				files['.gitignore'] = files['.gitignore'].replace('.open-next/\n', '');
			},
		],
		[
			'a node_modules directory that git would track',
			'gitignore',
			(files) => {
				files['.gitignore'] = files['.gitignore'].replace('node_modules\n', '');
			},
		],
		[
			'a Hosting block for another framework',
			'hosting',
			(files) => {
				files['aws-blocks/index.cdk.ts'] = files['aws-blocks/index.cdk.ts'].replace("'nextjs'", "'spa'");
			},
		],
		[
			'an unticked task in the plan',
			'report',
			(files) => {
				files['MIGRATION.md'] = files['MIGRATION.md'].replace(
					'- [x] scaffold',
					'- [x] scaffold\n- [ ] hosting',
				);
			},
		],
		[
			'a report without the steps before the first deploy',
			'report',
			(files) => {
				files['MIGRATION.md'] = files['MIGRATION.md'].replace('## Before deploy\nNone\n\n', '');
			},
		],
		[
			'a report without the steps after the first deploy',
			'report',
			(files) => {
				files['MIGRATION.md'] = files['MIGRATION.md'].replace('## After deploy\nNone\n\n', '');
			},
		],
	];
	for (const [what, id, edit] of broken) {
		it(`fails ${id} for ${what}`, async () => {
			assert.deepStrictEqual(await failedChecks(migratedApp(edit)), { code: 1, failed: [id] });
		});
	}

	it('wants the client generated in the Hosting buildCommand, not in the build script, for a framework that Hosting builds through an adapter', async () => {
		const astro = (build: string, buildCommand: string, page: string): string =>
			migratedApp((files) => {
				files['package.json'] = pkg(
					{ astro: '^5.1.0', '@astrojs/node': '^9.0.0', '@aws-blocks/blocks': '^0.9.0' },
					{
						scripts: { build, 'dev:server': 'cdk-blocks dev' },
						devDependencies: {
							'aws-cdk': '^2',
							'aws-cdk-lib': '^2.275.0',
							constructs: '^10.8.1',
							tsx: '^4.23.15',
							esbuild: '^0.28.2',
						},
						workspaces: ['aws-blocks'],
					},
				);
				files['aws-blocks/index.cdk.ts'] =
					`new Hosting(blocksStack, 'Hosting', { framework: 'astro', buildCommand: '${buildCommand}', api: blocksStack });\n`;
				delete files['app/page.tsx'];
				files['src/pages/index.astro'] = page;
			});
		const failed = async (root: string) => (await failedChecks(root)).failed;
		const importing =
			"---\nimport { api } from 'aws-blocks';\nconst items = await api.list();\n---\n<p>{items.length}</p>\n";
		const generate = 'npx --no -- cdk-blocks generate client && npm run build';

		// The deploy runs the build script again under CDK, where the generator fails.
		assert.deepStrictEqual(
			await failed(astro('cdk-blocks generate client && astro build', 'npm run build', importing)),
			['client'],
		);
		assert.deepStrictEqual(await failed(astro('astro build', 'npm run build', importing)), ['client']);
		assert.deepStrictEqual(await failed(astro('astro build', generate, importing)), []);
		// Nothing imports the client: the build needs none, and a generator in the script still breaks the deploy.
		assert.deepStrictEqual(await failed(astro('astro build', 'npm run build', '<p>static</p>\n')), []);
		assert.deepStrictEqual(
			await failed(astro('cdk-blocks generate client && astro build', 'npm run build', '<p>static</p>\n')),
			['client'],
		);
	});

	it('wants the Nitro handler of a Nuxt app to stream, as Hosting invokes it', async () => {
		const nuxt = (config: string, hosting = ''): string =>
			migratedApp((files) => {
				files['package.json'] = pkg(
					{ nuxt: '^4.0.0', '@aws-blocks/blocks': '^0.9.0' },
					{
						scripts: { build: 'nuxt build', 'dev:server': 'cdk-blocks dev' },
						devDependencies: {
							'aws-cdk': '^2',
							'aws-cdk-lib': '^2.275.0',
							constructs: '^10.8.1',
							tsx: '^4.23.15',
							esbuild: '^0.28.2',
						},
						workspaces: ['aws-blocks'],
					},
				);
				files['aws-blocks/index.cdk.ts'] =
					`new Hosting(blocksStack, 'Hosting', { framework: 'nuxt', buildCommand: 'npm run build', buildOutputDir: '.output', ${hosting}api: blocksStack });\n`;
				delete files['app/page.tsx'];
				files['app/app.vue'] = '<template><NuxtPage /></template>\n';
				files['nuxt.config.ts'] = `export default defineNuxtConfig({ ${config} });\n`;
			});
		const failed = async (root: string) => (await failedChecks(root)).failed;
		assert.deepStrictEqual(await failed(nuxt('devtools: { enabled: true }')), ['hosting']);
		assert.deepStrictEqual(await failed(nuxt('nitro: { awsLambda: { streaming: false } }')), ['hosting']);
		assert.deepStrictEqual(await failed(nuxt('nitro: { awsLambda: { streaming: true } }')), []);
		// A door the app chose itself may invoke the server buffered: the check has nothing to say.
		assert.deepStrictEqual(
			await failed(nuxt('devtools: { enabled: true }', "frontDoor: { kind: 'apiGateway' }, ")),
			[],
		);
	});

	it('wants an Astro server that names its own adapter to bundle the packages it imports', async () => {
		const astro = (config: string): string =>
			migratedApp((files) => {
				files['package.json'] = pkg(
					{ astro: '^5.1.0', '@astrojs/node': '^9.0.0', '@aws-blocks/blocks': '^0.9.0' },
					{
						scripts: { build: 'astro build', 'dev:server': 'cdk-blocks dev' },
						devDependencies: {
							'aws-cdk': '^2',
							'aws-cdk-lib': '^2.275.0',
							constructs: '^10.8.1',
							tsx: '^4.23.15',
							esbuild: '^0.28.2',
						},
						workspaces: ['aws-blocks'],
					},
				);
				files['aws-blocks/index.cdk.ts'] =
					"new Hosting(blocksStack, 'Hosting', { framework: 'astro', buildCommand: 'npm run build', api: blocksStack });\n";
				delete files['app/page.tsx'];
				files['src/pages/index.astro'] = '<p>shop</p>\n';
				files['astro.config.mjs'] = `export default defineConfig({ output: 'server', ${config} });\n`;
			});
		const failed = async (root: string) => (await failedChecks(root)).failed;
		// Hosting builds this config as it is, and uploads dist/server without node_modules.
		assert.deepStrictEqual(await failed(astro("adapter: node({ mode: 'standalone' })")), ['hosting']);
		assert.deepStrictEqual(
			await failed(astro("adapter: node({ mode: 'standalone' }), vite: { ssr: { noExternal: ['cookie'] } }")),
			['hosting'],
		);
		// The form the playbook gives: an integration that turns it on for the build alone, since it breaks `astro dev`.
		const hook =
			"integrations: [{ name: 'bundle-server-dependencies', hooks: { 'astro:config:setup': ({ command, updateConfig }) => {\n" +
			"\tif (command === 'build') updateConfig({ vite: { ssr: { noExternal: true } } });\n} } }]";
		assert.deepStrictEqual(await failed(astro(`adapter: node({ mode: 'standalone' }), ${hook}`)), []);
		assert.deepStrictEqual(
			await failed(astro("adapter: node({ mode: 'standalone' }), vite: { ssr: { noExternal: true } }")),
			[],
		);
		// Without an adapter in the config, Hosting adds its own and bundles everything.
		assert.deepStrictEqual(await failed(astro('integrations: []')), []);
	});

	it('fails framework-version when the major version of the framework changed since the last commit', async () => {
		const root = migratedApp((files) => {
			files['package.json'] = files['package.json'].replace('"next": "16.4.2"', '"next": "15.5.28"');
		});
		commit(root);
		assert.deepStrictEqual(await failedChecks(root), { code: 0, failed: [] });
		const pkgPath = join(root, 'package.json');
		// A patch upgrade inside the major is allowed; a new major is not.
		writeFileSync(pkgPath, readFileSync(pkgPath, 'utf-8').replace('"next": "15.5.28"', '"next": "15.5.30"'));
		assert.deepStrictEqual(await failedChecks(root), { code: 0, failed: [] });
		writeFileSync(pkgPath, readFileSync(pkgPath, 'utf-8').replace('"next": "15.5.30"', '"next": "16.4.2"'));
		assert.deepStrictEqual(await failedChecks(root), { code: 1, failed: ['framework-version'] });
	});

	it('fails server-env for a variable that server code reads and the Hosting block does not declare', async () => {
		const route =
			'export async function GET(r: Request) { return Response.json({ ok: r.headers.get("x") === process.env.CRON_SECRET }) }\n';
		const unset = migratedApp((files) => {
			files['app/api/cron/route.ts'] = route;
		});
		assert.deepStrictEqual(await failedChecks(unset), { code: 1, failed: ['server-env'] });
		const declared = migratedApp((files) => {
			files['app/api/cron/route.ts'] = route;
			files['aws-blocks/index.cdk.ts'] = files['aws-blocks/index.cdk.ts'].replace(
				'api: blocksStack',
				"api: blocksStack, environment: { CRON_SECRET: secret('CRON_SECRET') }",
			);
			files['MIGRATION.md'] = files['MIGRATION.md'].replace(
				'## Before deploy\nNone',
				'## Before deploy\n- [ ] secret: `CRON_SECRET` guards the cron route; set it with `cdk-blocks secret set CRON_SECRET`',
			);
		});
		assert.deepStrictEqual(await failedChecks(declared), { code: 0, failed: [] });
		// The config of a tool and a script are not part of the deployed app.
		const tooling = migratedApp((files) => {
			files['drizzle.config.ts'] = 'export default { dbCredentials: { url: process.env.DATABASE_URL } }\n';
			files['scripts/seed.ts'] = 'console.log(process.env.SEED_TOKEN)\n';
		});
		assert.deepStrictEqual(await failedChecks(tooling), { code: 0, failed: [] });
		// A public build-time value is inlined by the build: it needs no declaration.
		const inlined = migratedApp((files) => {
			files['app/site.ts'] = 'export const site = process.env.NEXT_PUBLIC_SITE_URL\n';
		});
		assert.deepStrictEqual(await failedChecks(inlined), { code: 0, failed: [] });
	});

	it('fails before-deploy for a Hosting value that the report does not list before the first deploy', async () => {
		const withValue = (report: (text: string) => string) =>
			migratedApp((files) => {
				files['aws-blocks/index.cdk.ts'] =
					"await Hosting.create(blocksStack, 'Hosting', { framework: 'nextjs', api: blocksStack, environment: { REVALIDATE_SECRET: secret('REVALIDATE_SECRET'), FLAGS: config('FLAGS') } });\n";
				files['MIGRATION.md'] = report(files['MIGRATION.md']);
			});
		// The deploy stops on a value that is not set: listing it under "After deploy" sends the user into that failure.
		const after = withValue((text) =>
			text.replace(
				'## After deploy\nNone',
				'## After deploy\n- [ ] secret: REVALIDATE_SECRET\n- [ ] config: FLAGS',
			),
		);
		assert.deepStrictEqual(await failedChecks(after), { code: 1, failed: ['before-deploy'] });
		// A longer name that contains the key does not count as naming it.
		const partial = withValue((text) =>
			text.replace(
				'## Before deploy\nNone',
				'## Before deploy\n- [ ] secret: `REVALIDATE_SECRET_V2`\n- [ ] config: `FLAGS`',
			),
		);
		const run = await runCli(['blockify-app', 'check'], { cwd: partial });
		assert.strictEqual(run.code, 1);
		assert.match(run.stdout, /declares REVALIDATE_SECRET, but "Before deploy" in MIGRATION\.md does not name it/);
		const before = withValue((text) =>
			text.replace(
				'## Before deploy\nNone',
				'## Before deploy\n- [ ] secret: `REVALIDATE_SECRET`\n- [ ] config: `FLAGS`',
			),
		);
		assert.deepStrictEqual(await failedChecks(before), { code: 0, failed: [] });
	});

	it('fails report when MIGRATION.md is missing', async () => {
		const root = migratedApp();
		rmSync(join(root, 'MIGRATION.md'));
		assert.deepStrictEqual((await failedChecks(root)).failed, ['report']);
	});
});

/** The logical id of the function in {@link synthesizedApp}. */
const SERVER_FUNCTION = 'HostingComputedefaultFunction35E53DE1';

/**
 * A migrated app with the `cdk.out` that synth writes for a server-rendered
 * app: one template with the function and the method that invokes it, and the
 * directory of the function's code. `extra` adds files to the app itself.
 */
function synthesizedApp(
	fn: { handler: string; code: Record<string, string>; variables?: Record<string, unknown>; streamed: boolean },
	extra: Record<string, string> = {},
): string {
	const template = {
		Resources: {
			[SERVER_FUNCTION]: {
				Type: 'AWS::Lambda::Function',
				Properties: {
					Code: { S3Bucket: 'assets', S3Key: 'c0ffee.zip' },
					Handler: fn.handler,
					Environment: { Variables: fn.variables ?? {} },
				},
				Metadata: { 'aws:cdk:path': 'notes-app-a1b2c3-prod/Hosting/Hosting/Compute-default/Function/Resource' },
			},
			HostingCdnSsrRestApiANYFE7537E7: {
				Type: 'AWS::ApiGateway::Method',
				Properties: {
					HttpMethod: 'ANY',
					Integration: {
						Type: 'AWS_PROXY',
						...(fn.streamed ? { ResponseTransferMode: 'STREAM' } : {}),
						Uri: {
							'Fn::Join': [
								'',
								[
									'arn:aws:apigateway:us-east-1:lambda:path/functions/',
									{ 'Fn::GetAtt': [SERVER_FUNCTION, 'Arn'] },
									fn.streamed ? '/response-streaming-invocations' : '/invocations',
								],
							],
						},
					},
				},
			},
		},
	};
	return migratedApp((files) => {
		files['cdk.out/notes-app-a1b2c3-prod.template.json'] = JSON.stringify(template);
		for (const [path, text] of Object.entries(fn.code)) files[`cdk.out/asset.c0ffee/${path}`] = text;
		Object.assign(files, extra);
	});
}

/** The `server-bundle` checks of `blockify-app check --server`, and the ids of every failed check. */
async function serverChecks(
	root: string,
): Promise<{ code: number; failed: string[]; server: { ok: boolean; message: string; fix: string | null }[] }> {
	const run = await runCli(['blockify-app', 'check', '--server', '--output', 'json'], { cwd: root });
	const result = JSON.parse(run.stdout) as {
		ok: boolean;
		checks: { id: string; ok: boolean; message: string; fix: string | null }[];
	};
	assert.strictEqual(result.ok, run.code === 0);
	return {
		code: run.code,
		failed: result.checks.filter((check) => !check.ok).map((check) => check.id),
		server: result.checks.filter((check) => check.id === 'server-bundle'),
	};
}

describe('cdk-blocks blockify-app check --server', () => {
	/** A server that imports a package and answers every request with 200. */
	const SERVER = {
		'server/run.sh': '#!/bin/sh\nexec node server/entry.mjs\n',
		'server/entry.mjs':
			"import 'left-pad-fixture';\nimport http from 'node:http';\nhttp.createServer((_, res) => res.end('ok')).listen(Number(process.env.PORT), '127.0.0.1');\n",
	};
	const PACKAGE = {
		'node_modules/left-pad-fixture/package.json': '{"name":"left-pad-fixture","main":"index.js"}\n',
		'node_modules/left-pad-fixture/index.js': 'module.exports = {};\n',
	};
	const WEB_ADAPTER = { AWS_LAMBDA_EXEC_WRAPPER: '/opt/bootstrap', PORT: '8080' };

	it('does not start a server without the flag', async () => {
		const root = synthesizedApp({ handler: 'server/run.sh', code: SERVER, variables: WEB_ADAPTER, streamed: true });
		assert.deepStrictEqual(await failedChecks(root), { code: 0, failed: [] });
	});

	it('fails when there is no synth output to read, and names the synth step', async () => {
		const { code, failed, server } = await serverChecks(migratedApp());
		assert.deepStrictEqual({ code, failed }, { code: 1, failed: ['server-bundle'] });
		assert.match(server[0].fix ?? '', /cdk synth/);
	});

	it('passes an app that Hosting serves as files: it has no server function', async () => {
		const root = migratedApp((files) => {
			files['cdk.out/notes-app-a1b2c3-prod.template.json'] = JSON.stringify({
				Resources: { Bucket: { Type: 'AWS::S3::Bucket', Properties: {} } },
			});
		});
		assert.deepStrictEqual((await serverChecks(root)).failed, []);
	});

	it("fails a server whose package is in the app's node_modules and not in the uploaded files, and passes once it is uploaded", {
		skip: process.platform === 'win32',
	}, async () => {
		// The package resolves from cdk.out upwards, as it does in every local check; the deploy uploads the directory alone.
		const missing = synthesizedApp(
			{ handler: 'server/run.sh', code: SERVER, variables: WEB_ADAPTER, streamed: true },
			PACKAGE,
		);
		const { code, failed, server } = await serverChecks(missing);
		assert.deepStrictEqual({ code, failed }, { code: 1, failed: ['server-bundle'] });
		assert.match(server[0].message, /exits at start.*left-pad-fixture/);

		const uploaded = Object.fromEntries(Object.entries(PACKAGE).map(([path, text]) => [`server/${path}`, text]));
		const bundled = synthesizedApp({
			handler: 'server/run.sh',
			code: { ...SERVER, ...uploaded },
			variables: WEB_ADAPTER,
			streamed: true,
		});
		const started = await serverChecks(bundled);
		assert.deepStrictEqual(started.failed, []);
		assert.match(started.server[0].message, /answers GET \/ with 200/);
	});

	it('fails a handler that buffers its response where the template invokes it with streaming, and the reverse', async () => {
		const buffered = { 'index.mjs': "export const handler = async () => ({ statusCode: 200, body: 'ok' });\n" };
		const streaming = {
			'index.mjs':
				'export const handler = awslambda.streamifyResponse(async (_event, stream) => {\n\tawslambda.HttpResponseStream.from(stream, { statusCode: 200 }).end();\n});\n',
		};
		const run = (code: Record<string, string>, streamed: boolean) =>
			serverChecks(synthesizedApp({ handler: 'index.handler', code, streamed }));

		const mismatch = await run(buffered, true);
		assert.deepStrictEqual(mismatch.failed, ['server-bundle']);
		assert.match(mismatch.server[0].message, /buffered response.*502/);
		assert.match(mismatch.server[0].fix ?? '', /streaming: true/);

		assert.deepStrictEqual((await run(streaming, false)).failed, ['server-bundle']);
		assert.deepStrictEqual((await run(streaming, true)).failed, []);
		assert.deepStrictEqual((await run(buffered, false)).failed, []);
	});

	it('fails a handler that does not load from the uploaded files', async () => {
		const { failed, server } = await serverChecks(
			synthesizedApp({
				handler: 'index.handler',
				code: {
					'index.mjs':
						"import 'left-pad-fixture';\nexport const handler = async () => ({ statusCode: 200 });\n",
				},
				streamed: false,
			}),
		);
		assert.deepStrictEqual(failed, ['server-bundle']);
		assert.match(server[0].message, /does not load.*left-pad-fixture/);
	});
});

describe('cdk-blocks blockify-app skill', () => {
	it('copies the skill under its own name, and refuses to replace a copy without --force', async () => {
		const root = writeApp({ 'package.json': '{}\n' });
		const run = await runCli(['blockify-app', 'skill', '.claude/skills'], { cwd: root });
		assert.strictEqual(run.code, 0);
		const copy = join(root, '.claude', 'skills', 'migrate-to-aws-blocks');
		assert.strictEqual(
			readFileSync(join(copy, 'SKILL.md'), 'utf-8'),
			readFileSync(join(SKILL_DIR, 'SKILL.md'), 'utf-8'),
		);
		assert.ok(existsSync(join(copy, 'references', 'playbook.md')));

		writeFileSync(join(copy, 'SKILL.md'), 'edited by the user\n');
		const again = await runCli(['blockify-app', 'skill', '.claude/skills'], { cwd: root });
		assert.strictEqual(again.code, 1);
		assert.strictEqual(readFileSync(join(copy, 'SKILL.md'), 'utf-8'), 'edited by the user\n');
		const forced = await runCli(['blockify-app', 'skill', '.claude/skills', '--force'], { cwd: root });
		assert.strictEqual(forced.code, 0);
		assert.notStrictEqual(readFileSync(join(copy, 'SKILL.md'), 'utf-8'), 'edited by the user\n');
	});
});

describe('the migrate-to-aws-blocks skill', () => {
	const skill = readFileSync(join(SKILL_DIR, 'SKILL.md'), 'utf-8');
	const frontmatter = /^---\n([\s\S]*?)\n---\n/.exec(skill)?.[1] ?? '';
	const guides = listGuides().map((guide) => guide.name);

	it('meets the Agent Skills format: a name equal to its directory, and a description within the limit', () => {
		const name = /^name: (.+)$/m.exec(frontmatter)?.[1];
		const description = /^description: (.+)$/m.exec(frontmatter)?.[1] ?? '';
		assert.strictEqual(name, 'migrate-to-aws-blocks');
		assert.ok(SKILL_DIR.replace(/[\\/]$/, '').endsWith(name));
		assert.match(name, /^[a-z0-9]+(?:-[a-z0-9]+)*$/);
		assert.ok(name.length <= 64);
		assert.ok(
			description.length > 0 && description.length <= 1024,
			`description has ${description.length} characters`,
		);
	});

	it('links every guide from SKILL.md, and decides for every guide when it is recommended', () => {
		for (const guide of guides)
			assert.ok(skill.includes(`(references/${guide}.md)`), `SKILL.md does not link ${guide}`);
		assert.deepStrictEqual(Object.keys(GUIDE_TAGS).sort(), guides);
	});

	it('names only guides that exist, and closes every conditional section', () => {
		const pages = readdirSync(join(SKILL_DIR, 'references')).map((file) =>
			readFileSync(join(SKILL_DIR, 'references', file), 'utf-8'),
		);
		for (const page of pages) {
			for (const match of page.matchAll(/cdk-blocks blockify-app guide ([a-z-]+)`/g)) {
				assert.ok(guides.includes(match[1]), `no guide "${match[1]}"`);
			}
		}
		const playbook = readFileSync(join(SKILL_DIR, 'references', 'playbook.md'), 'utf-8');
		for (const match of playbook.matchAll(/[Gg]uide `([a-z-]+)`/g))
			assert.ok(guides.includes(match[1]), `no guide "${match[1]}"`);
		assert.strictEqual(playbook.match(/<!-- when: /g)?.length, playbook.match(/<!-- end -->/g)?.length);
	});
});

describe('version ranges copied from @aws-blocks/hosting', () => {
	// Compiled to dist/cli/, so the hosting package is three levels up and one across.
	const adapter = readFileSync(
		fileURLToPath(new URL('../../../hosting/src/adapters/nextjs.ts', import.meta.url)),
		'utf-8',
	);
	const constant = (name: string): string | undefined =>
		new RegExp(`export const ${name} = '([^']+)'`).exec(adapter)?.[1];

	it('match the ranges the hosting adapter builds with', () => {
		assert.strictEqual(NEXT_SUPPORTED_RANGE, constant('OPENNEXT_FALLBACK_NEXT_PEER_RANGE'));
		assert.strictEqual(OPENNEXT_VERIFIED_RANGE, constant('VERIFIED_OPENNEXT_RANGE'));
	});

	it('finds the server function by the construct ids that Hosting gives it', () => {
		const source = (file: string): string =>
			readFileSync(fileURLToPath(new URL(`../../../hosting/src/constructs/${file}`, import.meta.url)), 'utf-8');
		assert.match(source('hosting_construct.ts'), /new ComputeConstruct\(this, `Compute-\$\{name\}`/);
		assert.match(source('compute_construct.ts'), /new LambdaFunction\(this, 'Function'/);
		assert.match('app-prod/Hosting/Hosting/Compute-default/Function/Resource', SERVER_FUNCTION_PATH);
		assert.doesNotMatch('app-prod/Hosting/Hosting/Cdn/RouteStoreKeys/Fn/Resource', SERVER_FUNCTION_PATH);
	});
});
