// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * `cdk-blocks blockify-app check`: the rules of the migration playbook that the
 * files of a migrated app show, checked without running the app. Each check
 * names the rule it stands for, and a failed one says how to fix it.
 *
 * It reads files and asks git which paths are ignored. It runs no build, no
 * synth and no dev server: the playbook's validate task does those.
 */

import { spawnSync } from 'node:child_process';
import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { type Detection, detectApp, escapeRegExp, findInSources } from './blockify-detect.js';
import { NEXT_SUPPORTED_RANGE, rangeStanding, scaffoldCommand } from './blockify-playbook.js';

export interface Check {
	/** A stable name: `scaffold`, `dependencies`, `report`. */
	id: string;
	ok: boolean;
	/** What was found. */
	message: string;
	/** How to make a failed check pass; `null` for a check that passed. */
	fix: string | null;
}

/** The `--output json` result of `cdk-blocks blockify-app check`. */
export interface CheckResult {
	ok: boolean;
	checks: Check[];
}

/** The files the scaffolder creates; every later check reads them. */
const SCAFFOLD_FILES = [
	'aws-blocks/index.ts',
	'aws-blocks/index.cdk.ts',
	'aws-blocks/index.handler.ts',
	'aws-blocks/package.json',
	'cdk.json',
	'.blocks/config.json',
] as const;

/** What `cdk-blocks` and `cdk synth` need installed in the app. */
const REQUIRED_PACKAGES = ['@aws-blocks/blocks', 'aws-cdk', 'aws-cdk-lib', 'constructs', 'tsx', 'esbuild'] as const;

/**
 * The `@opennextjs/aws` versions that `Hosting` is verified with. It must equal
 * `VERIFIED_OPENNEXT_RANGE` in `@aws-blocks/hosting` (`src/adapters/nextjs.ts`);
 * a test compares the two.
 */
export const OPENNEXT_VERIFIED_RANGE = '>=3.10.0 <3.11.0 || >=4.0.0 <4.2.0';

/**
 * Files that are not part of the deployed app: the config of a build or data
 * tool (`drizzle.config.ts`, `next.config.mjs`), scripts and tests. A variable
 * that only they read is not needed on AWS.
 */
const NOT_DEPLOYED_CODE =
	/(?:^|\/)(?:[^/]+\.config\.[cm]?[jt]s|(?:scripts|tests?|__tests__|e2e|prisma|drizzle)\/.*)$|\.(?:test|spec)\.[cm]?[jt]sx?$/;

/** The sections that the playbook's `MIGRATION.md` template has. */
const REPORT_SECTIONS = ['## Plan', '## Blockers', '## Before deploy', '## After deploy', '## Validation'] as const;

/** Paths that the install, the build, synth and the local server write. They belong in `.gitignore`. */
const GENERATED_PATHS = [
	'node_modules/.bin',
	'.bb-data/data',
	'cdk.out/manifest.json',
	'.blocks-sandbox/config.json',
	'.hosting/build',
] as const;

/** Where a Nuxt app (`nitro: { … }`) or a Nitro app sets the options of its Lambda handler. */
const NITRO_CONFIG_FILES = ['ts', 'mts', 'js', 'mjs'].flatMap((extension) => [
	`nuxt.config.${extension}`,
	`nitro.config.${extension}`,
]);

const NITRO_STREAMING_ON = /\bawsLambda\s*:\s*\{[^}]*\bstreaming\s*:\s*true\b/;

/**
 * Whether the Astro config names an adapter itself and leaves the packages
 * that its server imports outside the bundle. `Hosting` builds such a config
 * as it is and uploads `dist/server` without `node_modules`. The setting is
 * found wherever the config has it: as a property, or in the hook of an
 * integration that turns it on for the build alone.
 */
function astroServerNeedsNodeModules(root: string): boolean {
	const config = ['mjs', 'ts', 'js', 'mts']
		.map((extension) => readText(join(root, `astro.config.${extension}`)))
		.find((text) => text !== undefined);
	return config !== undefined && /\badapter\s*:/.test(config) && !/\bnoExternal\s*:[^\n,}]*\btrue\b/.test(config);
}

interface PackageJson {
	scripts?: Record<string, unknown>;
	dependencies?: Record<string, unknown>;
	devDependencies?: Record<string, unknown>;
	workspaces?: unknown;
	type?: unknown;
	exports?: unknown;
}

function readText(path: string): string | undefined {
	try {
		return readFileSync(path, 'utf-8');
	} catch {
		return undefined;
	}
}

function readJson(path: string): Record<string, unknown> | undefined {
	try {
		const parsed: unknown = JSON.parse((readText(path) ?? '').replace(/^\uFEFF/, ''));
		return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
			? (parsed as Record<string, unknown>)
			: undefined;
	} catch {
		return undefined;
	}
}

/** Whether `range`, as `package.json` declares it, stays inside {@link OPENNEXT_VERIFIED_RANGE}. */
function openNextVerified(range: string): boolean {
	const match = /^[~=v]?\s*(\d+)\.(\d+)(?:\.\d+)?/.exec(range.trim());
	if (!match) return false;
	const [major, minor] = [Number(match[1]), Number(match[2])];
	return (major === 3 && minor === 10) || (major === 4 && minor <= 1);
}

/** The major version in a dependency range as `package.json` writes it: `^15.5.0` and `15.5.28` give 15. */
function majorOf(range: unknown): number | undefined {
	const match = typeof range === 'string' ? /(\d+)(?:\.\d+)*/.exec(range) : null;
	return match ? Number(match[1]) : undefined;
}

/**
 * The range that the last commit declares for dependency `name`: `undefined`
 * outside a git work tree, without a commit, or when that commit does not declare it.
 */
function committedRange(root: string, name: string): string | undefined {
	const shown = spawnSync('git', ['show', 'HEAD:./package.json'], { cwd: root, encoding: 'utf-8' });
	if (shown.error || shown.status !== 0) return undefined;
	try {
		const pkg: PackageJson = JSON.parse(shown.stdout.replace(/^\uFEFF/, ''));
		const range = pkg.dependencies?.[name] ?? pkg.devDependencies?.[name];
		return typeof range === 'string' ? range : undefined;
	} catch {
		return undefined;
	}
}

/**
 * Whether git ignores `path` in the work tree at `root`: `undefined` outside a
 * git work tree or without git, where the question has no answer.
 */
function gitIgnores(root: string, path: string): boolean | undefined {
	const result = spawnSync('git', ['check-ignore', '-q', '--', path], { cwd: root, stdio: 'ignore' });
	if (result.error || (result.status !== 0 && result.status !== 1)) return undefined;
	return result.status === 0;
}

/** The checks that need the scaffold in place. */
function checkApp(root: string, { app, signals }: Detection): Check[] {
	const checks: Check[] = [];
	const pass = (id: string, message: string) => checks.push({ id, ok: true, message, fix: null });
	const fail = (id: string, message: string, fix: string) => checks.push({ id, ok: false, message, fix });
	const has = (id: string) => signals.some((signal) => signal.id === id);

	const pkg = (readJson(join(root, 'package.json')) ?? {}) as PackageJson;
	const declared: Record<string, unknown> = { ...pkg.devDependencies, ...pkg.dependencies };
	const scripts = pkg.scripts ?? {};
	const backend = readText(join(root, 'aws-blocks', 'index.ts')) ?? '';
	const infra = readText(join(root, 'aws-blocks', 'index.cdk.ts')) ?? '';
	const nextSsr = app.framework === 'nextjs' && app.rendering === 'ssr';

	const backendPkg = (readJson(join(root, 'aws-blocks', 'package.json')) ?? {}) as PackageJson;
	const exportsMap = backendPkg.exports as Record<string, unknown> | undefined;
	if (backendPkg.type === 'module' && typeof exportsMap === 'object' && exportsMap !== null && '.' in exportsMap) {
		pass('backend-package', 'aws-blocks/package.json has "type": "module" and its "exports" map');
	} else {
		fail(
			'backend-package',
			'aws-blocks/package.json lost "type": "module" or its "exports" map',
			'restore both as the scaffolder wrote them: import { api } from "aws-blocks" and cdk synth resolve through them',
		);
	}

	const stackId = readJson(join(root, '.blocks', 'config.json'))?.stackId;
	if (typeof stackId === 'string' && stackId !== '')
		pass('stack-id', `.blocks/config.json names the stacks "${stackId}"`);
	else
		fail(
			'stack-id',
			'.blocks/config.json has no string "stackId"',
			'set "stackId" to "<app-name>-<6 characters>"; deploy names the stacks after it',
		);

	const missing = REQUIRED_PACKAGES.filter((name) => declared[name] === undefined);
	if (missing.length === 0) pass('dependencies', `package.json declares ${REQUIRED_PACKAGES.join(', ')}`);
	else {
		fail(
			'dependencies',
			`package.json does not declare ${missing.join(', ')}`,
			`add ${missing.join(', ')} to the root package.json (aws-cdk as "^2" in devDependencies), then install`,
		);
	}

	if (app.packageManager === 'pnpm') {
		const workspace = readText(join(root, 'pnpm-workspace.yaml')) ?? '';
		if (/^\s*-\s*['"]?(?:\.\/)?aws-blocks\/?['"]?\s*$/m.test(workspace))
			pass('workspace', 'pnpm-workspace.yaml lists aws-blocks');
		else
			fail(
				'workspace',
				'pnpm-workspace.yaml does not list aws-blocks',
				'add "- aws-blocks" under "packages:" in pnpm-workspace.yaml; pnpm does not read package.json "workspaces"',
			);
	} else {
		// Yarn classic writes `{ "packages": [...] }`.
		const declaredWorkspaces: unknown = pkg.workspaces;
		const workspaces =
			typeof declaredWorkspaces === 'object' && declaredWorkspaces !== null && 'packages' in declaredWorkspaces
				? declaredWorkspaces.packages
				: declaredWorkspaces;
		if (
			Array.isArray(workspaces) &&
			workspaces.some((entry) => entry === 'aws-blocks' || entry === './aws-blocks')
		) {
			pass('workspace', 'package.json "workspaces" lists aws-blocks');
		} else {
			fail(
				'workspace',
				'package.json "workspaces" does not list aws-blocks',
				'add "aws-blocks" to "workspaces" in the root package.json, then install',
			);
		}
	}

	if (has('multiple-lockfiles')) {
		fail(
			'lockfile',
			`lockfiles of more than one package manager: ${app.lockfiles.join(', ')}`,
			`keep the lockfile of ${app.packageManager} and delete the others; two formats stop the deploy with MultipleLockFilesFound`,
		);
	} else {
		pass('lockfile', app.lockfiles.length === 0 ? 'no lockfile yet' : `one lockfile: ${app.lockfiles[0]}`);
	}

	// A scope id is part of the name of every AWS resource of the backend (`<stack>-<scope>-<block>`).
	const badScopes = [...backend.matchAll(/\bnew Scope\(\s*(['"`])(.*?)\1/g)]
		.map((match) => match[2])
		.filter((id) => !/^[A-Za-z][A-Za-z0-9-]*$/.test(id));
	if (/\basync greet\(name: string\)/.test(backend) || /\basync subscribeTodos\(\)/.test(backend)) {
		fail(
			'backend',
			"aws-blocks/index.ts still has the scaffolder's demo API",
			"replace the demo with the app's own backend, or with only `new Scope('<app-name>')` when the app has no backend",
		);
	} else if (/^export\s+(?:default\b|(?:async\s+)?function\b|class\b)/m.test(backend)) {
		fail(
			'backend',
			'aws-blocks/index.ts exports a function, a class or a default',
			'export only ApiNamespace instances (and authApi): any other exported function or object becomes a public remote endpoint',
		);
	} else if (badScopes.length > 0) {
		fail(
			'backend',
			`aws-blocks/index.ts names a scope "${badScopes[0]}"`,
			'write it with letters, digits and hyphens only ("acme-shop" for a package named "@acme/shop"): the id becomes part of ' +
				'the name of every AWS resource of the backend, and a table or a function with "@", "/", "." or a space in its ' +
				'name fails the deploy, after the local server and synth have passed',
		);
	} else {
		pass('backend', 'aws-blocks/index.ts has no demo API and exports no bare function');
	}

	const framework = /\bframework\s*:\s*['"]([a-z]+)['"]/.exec(infra)?.[1];
	if (!/\b(?:new Hosting\(|Hosting\.create\()/.test(infra)) {
		fail(
			'hosting',
			'aws-blocks/index.cdk.ts creates no Hosting block',
			'keep the Hosting block that the scaffolder wrote and set its properties for this app',
		);
	} else if (/\bbuildOutputDir\s*:\s*['"]\.?\/?['"]/.test(infra)) {
		fail(
			'hosting',
			'Hosting buildOutputDir is the repository root',
			'point buildOutputDir at the subdirectory the build writes (dist, out, build)',
		);
	} else if (nextSsr && framework !== 'nextjs') {
		fail(
			'hosting',
			`the app renders with Next.js on the server, but Hosting framework is ${framework === undefined ? 'not set' : `"${framework}"`}`,
			"set framework: 'nextjs' on the Hosting block",
		);
	} else if (
		has('next-static-export') &&
		(framework !== 'static' || !/\bbuildOutputDir\s*:\s*['"]out['"]/.test(infra))
	) {
		fail(
			'hosting',
			'the app is a Next.js static export, but Hosting is not set up for one',
			"set framework: 'static' and buildOutputDir: 'out' on the Hosting block",
		);
	} else if (
		(framework === 'nuxt' || framework === 'nitro') &&
		// Another door than the default one decides for itself how it invokes the server.
		!/\bfrontDoor\s*:/.test(infra) &&
		!NITRO_CONFIG_FILES.some((file) => NITRO_STREAMING_ON.test(readText(join(root, file)) ?? ''))
	) {
		fail(
			'hosting',
			`Hosting framework is "${framework}", and neither nuxt.config nor nitro.config turns on awsLambda.streaming`,
			'set nitro: { awsLambda: { streaming: true } } in nuxt.config.ts (awsLambda: { streaming: true } in nitro.config.ts): ' +
				'Hosting invokes the server with response streaming, and without the setting the deploy succeeds and every page answers 502. ' +
				'The build, synth and the local server do not show it',
		);
	} else if (framework === 'astro' && astroServerNeedsNodeModules(root)) {
		fail(
			'hosting',
			'astro.config names an adapter and does not bundle the packages that the server imports',
			'make the build, and only the build, bundle them: add an integration to astro.config whose ' +
				'"astro:config:setup" hook calls updateConfig({ vite: { ssr: { noExternal: true } } }) when command is "build" ' +
				'(the Hosting task of the playbook has the snippet; set for every command, the option breaks astro dev). ' +
				'Hosting uploads dist/server without node_modules, and builds a config that names an adapter as it is: ' +
				'the server exits at start ("Cannot find package …"), and every page answers 502 after a deploy that succeeded',
		);
	} else {
		pass(
			'hosting',
			framework === undefined
				? 'aws-blocks/index.cdk.ts creates the Hosting block'
				: `Hosting framework is "${framework}"`,
		);
	}

	if (nextSsr) {
		const openNext = declared['@opennextjs/aws'];
		if (typeof openNext !== 'string') {
			fail(
				'opennext',
				'package.json does not declare @opennextjs/aws',
				`add @opennextjs/aws to devDependencies, at a version inside ${OPENNEXT_VERIFIED_RANGE} whose "next" peer range accepts the app's Next.js`,
			);
		} else if (!openNextVerified(openNext)) {
			fail(
				'opennext',
				`@opennextjs/aws "${openNext}" can resolve outside the verified range ${OPENNEXT_VERIFIED_RANGE}`,
				'pin an exact version or a "~" range inside the verified range',
			);
		} else {
			pass('opennext', `@opennextjs/aws "${openNext}" is inside the verified range`);
		}
		const next =
			app.frameworkVersion === null ? undefined : rangeStanding(app.frameworkVersion, NEXT_SUPPORTED_RANGE);
		if (next?.standing === 'supported')
			pass('next-version', `Next.js ${app.frameworkVersion} is inside ${NEXT_SUPPORTED_RANGE}`);
		else if (next?.standing === 'upgrade')
			fail(
				'next-version',
				`Next.js ${app.frameworkVersion} is below ${next.to}`,
				`upgrade "next" to at least ${next.to}, inside the same major version`,
			);
		else
			fail(
				'next-version',
				`Next.js ${app.frameworkVersion ?? '(unknown version)'} is outside ${NEXT_SUPPORTED_RANGE}`,
				'a server-rendered app needs a Next.js version inside that range; record it under Blockers in MIGRATION.md',
			);
	}

	// A migration keeps the framework's major version: a new major changes the product, which is the user's decision.
	if (app.frameworkPackage !== null) {
		const before = committedRange(root, app.frameworkPackage);
		const [was, now] = [majorOf(before), majorOf(declared[app.frameworkPackage])];
		if (was !== undefined && now !== undefined && was !== now) {
			fail(
				'framework-version',
				`${app.frameworkPackage} was "${before}" in the last commit and is "${String(declared[app.frameworkPackage])}" now: the major version changed during the migration`,
				`restore ${app.frameworkPackage} to major version ${was}, and record under Blockers in MIGRATION.md that the user must decide on the upgrade. ` +
					'If the user made this upgrade, ask them to commit it before the migration',
			);
		} else {
			pass('framework-version', `${app.frameworkPackage} is on the same major version as in the last commit`);
		}
	}

	// On AWS the framework's server function receives only the variables that Hosting `environment` declares.
	// A variable that server code still reads, and that nothing provides, is undefined there while it works locally.
	if (app.rendering === 'ssr') {
		const unset = app.envVars
			.filter((name) => !/^(?:NEXT_PUBLIC_|VITE_|PUBLIC_|BLOCKS_|AWS_)/.test(name))
			.filter((name) => !new RegExp(`(?:\\b|['"])${escapeRegExp(name)}['"]?\\s*:`).test(infra))
			.map((name) => ({
				name,
				file: findInSources(
					root,
					new RegExp(`process\\.env(?:\\.${escapeRegExp(name)}\\b|\\[['"]${escapeRegExp(name)}['"]\\])`),
					NOT_DEPLOYED_CODE,
				),
			}))
			.filter((read): read is { name: string; file: string } => read.file !== undefined);
		if (unset.length === 0) {
			pass('server-env', 'every environment variable that server code reads is declared on the Hosting block');
		} else {
			fail(
				'server-env',
				`server code reads ${unset.map((read) => `${read.name} (${read.file})`).join(', ')}, which the deployed app will not have`,
				'declare each one in the Hosting block "environment" (secret(), config() or a plain value), or remove the code that reads it; ' +
					'guide "secrets" has the rules',
			);
		}
	}

	// Hosting runs the build of Astro, Nuxt and other Nitro apps and SvelteKit a second time, inside the framework
	// adapter, and `cdk-blocks deploy` sets CDK's Node condition for that run: the client generator fails there.
	const hostingFramework = /\bframework\s*:\s*['"]([a-z]+)['"]/.exec(infra)?.[1] ?? '';
	const adapterBuilds = ['astro', 'nuxt', 'nitro', 'sveltekit'].includes(hostingFramework);
	const inScripts = ['prebuild', 'build'].some((name) => /generate[ -]client/.test(String(scripts[name] ?? '')));
	const inBuildCommand = /\bbuildCommand\s*:\s*(['"`])[^'"`]*generate[ -]client/.test(infra);
	const importer = findInSources(root, /(?:from\s+|import\s*\(\s*)['"]aws-blocks['"]/);
	if (adapterBuilds && inScripts) {
		fail(
			'client',
			`the "build" or "prebuild" script runs "cdk-blocks generate client", and Hosting builds this app as "${hostingFramework}"`,
			'take it out of the scripts: the deploy runs them a second time under CDK and the generator fails there ' +
				'("Scope … should be created in the scope of a Stack"). ' +
				(importer === undefined
					? 'No frontend file imports aws-blocks, so the build needs no client.'
					: "Put it into the Hosting block instead: buildCommand: 'npx --no -- cdk-blocks generate client && npm run build'."),
		);
	} else if (importer !== undefined) {
		if (inScripts || inBuildCommand)
			pass('client', 'the build generates aws-blocks/client.js before it compiles the frontend');
		else
			fail(
				'client',
				`${importer} imports aws-blocks, but the build does not generate the client`,
				adapterBuilds
					? "start the Hosting buildCommand with it: buildCommand: 'npx --no -- cdk-blocks generate client && npm run build'; aws-blocks/client.js is not in git"
					: 'make the build script start with "cdk-blocks generate client && ": aws-blocks/client.js is not in git',
			);
	}

	const tracked = gitIgnores(root, '.blocks/config.json');
	if (tracked === undefined) {
		pass('gitignore', 'not a git work tree: ignore rules were not checked');
	} else {
		const unignored = [...GENERATED_PATHS, ...(nextSsr ? ['.open-next/cache'] : [])].filter(
			(path) => gitIgnores(root, path) === false,
		);
		if (tracked)
			fail(
				'gitignore',
				'.gitignore ignores .blocks/config.json',
				'un-ignore .blocks/config.json: it holds the stack id that deploy reads',
			);
		else if (unignored.length > 0)
			fail(
				'gitignore',
				`.gitignore does not ignore ${unignored.map((path) => path.split('/')[0]).join(', ')}`,
				'add those directories to .gitignore: the install, the local server, the build and synth write them',
			);
		else pass('gitignore', 'generated directories are ignored and .blocks/config.json is not');
	}

	const envFile = ['.env', '.env.local', '.env.production', '.env.development'].find((file) =>
		/^\s*(?:export\s+)?BLOCKS_API_URL\s*=/m.test(readText(join(root, file)) ?? ''),
	);
	if (envFile)
		fail(
			'api-url',
			`${envFile} sets BLOCKS_API_URL`,
			'remove it: the local server, the sandbox and the deploy each provide the API location',
		);
	else pass('api-url', 'no env file sets BLOCKS_API_URL');

	const report = readText(join(root, 'MIGRATION.md'));
	const absent = REPORT_SECTIONS.filter((section) => !report?.split('\n').some((line) => line.trim() === section));
	const section = (title: string) => report?.split(/^## /m).find((text) => text.startsWith(title)) ?? '';
	const open = section('Plan')
		.split('\n')
		.filter((line) => /^\s*-\s\[ \]/.test(line)).length;
	if (report === undefined)
		fail(
			'report',
			'MIGRATION.md is missing',
			'write MIGRATION.md from the template in the playbook: plan, blockers, steps before and after deploy, validation results',
		);
	else if (absent.length > 0)
		fail(
			'report',
			`MIGRATION.md has no ${absent.join(', ')} section`,
			'add the missing sections; write "None" under one that is empty',
		);
	else if (open > 0)
		fail(
			'report',
			`MIGRATION.md has ${open} unticked task${open === 1 ? '' : 's'} under Plan`,
			'finish each task and tick it, or move it under Blockers with the reason',
		);
	else pass('report', 'MIGRATION.md has every section and no open task');

	// A Hosting value is stored outside the stack, and `Hosting.create` stops the first deploy until it is set.
	// A report that lists it under "After deploy" sends the user into a deploy that fails.
	const hostingValues = [
		...new Set([...infra.matchAll(/\b(?:secret|config)\(\s*['"]([A-Za-z_]\w*)['"]/g)].map((m) => m[1])),
	];
	if (hostingValues.length > 0 && report !== undefined && !absent.includes('## Before deploy')) {
		const named = new Set(section('Before deploy').split(/\W+/));
		const unnamed = hostingValues.filter((name) => !named.has(name));
		if (unnamed.length === 0)
			pass('before-deploy', `"Before deploy" in MIGRATION.md names ${hostingValues.join(', ')}`);
		else
			fail(
				'before-deploy',
				`the Hosting block declares ${unnamed.join(', ')}, but "Before deploy" in MIGRATION.md does not name ${unnamed.length === 1 ? 'it' : 'them'}`,
				'add one step per value under "Before deploy" with its `cdk-blocks secret set <NAME>` or `config set` command: ' +
					'the value is stored outside the stack, and the first deploy fails or serves errors until it is set',
			);
	}

	return checks;
}

/** Check the app at `root` against the playbook's rules. Reads files only. */
export function checkMigration(root: string): CheckResult {
	const detection = detectApp(root);
	const missing = SCAFFOLD_FILES.filter(
		(file) => statSync(join(root, file), { throwIfNoEntry: false })?.isFile() !== true,
	);
	const checks: Check[] =
		missing.length > 0
			? [
					{
						id: 'scaffold',
						ok: false,
						message: `the scaffold is incomplete: ${missing.join(', ')} ${missing.length === 1 ? 'is' : 'are'} missing`,
						fix: `run the scaffold task of the playbook: ${scaffoldCommand(detection.app)}`,
					},
				]
			: [
					{
						id: 'scaffold',
						ok: true,
						message: 'aws-blocks/, cdk.json and .blocks/config.json are in place',
						fix: null,
					},
					...checkApp(root, detection),
				];
	return { ok: checks.every((check) => check.ok), checks };
}
