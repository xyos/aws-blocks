// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * The playbook that `cdk-blocks blockify-app playbook` prints for a coding agent:
 * what was detected in the app, the procedure for moving it onto AWS Blocks,
 * and the guides to read for the surfaces the app has.
 *
 * The text lives in the `migrate-to-aws-blocks` skill that this package ships
 * (`skills/migrate-to-aws-blocks/`), so an agent that loads skills reads the
 * same words. This module only chooses what applies: a section of
 * `references/playbook.md` between `<!-- when: a b -->` and `<!-- end -->`
 * is kept when the app has one of the listed tags, and each guide in
 * `references/` is marked as recommended when {@link GUIDE_TAGS} names one.
 */

import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { type AppProfile, type Detection, detectApp, type Framework, type Signal } from './blockify-detect.js';

/** The skill directory inside the installed package. */
export const SKILL_DIR = fileURLToPath(new URL('../../../skills/migrate-to-aws-blocks/', import.meta.url));

/** The page with the procedure; every other page in `references/` is a guide. */
const PLAYBOOK_PAGE = 'playbook';

/**
 * The `next` versions that the OpenNext version `Hosting` builds with by
 * default supports. It must equal `OPENNEXT_FALLBACK_NEXT_PEER_RANGE` in
 * `@aws-blocks/hosting` (`src/adapters/nextjs.ts`); a test compares the two.
 */
export const NEXT_SUPPORTED_RANGE = '>=15.5.28 <16 || >=16.4.1';

/** The tags that make a guide worth reading before the tasks start. A guide without tags is read on demand. */
export const GUIDE_TAGS: Readonly<Record<string, readonly string[]>> = {
	nextjs: ['nextjs'],
	auth: ['auth'],
	database: ['data'],
	'key-value': ['key-value'],
	'file-uploads': ['storage'],
	jobs: ['jobs'],
	secrets: ['secrets'],
	'api-routes': ['api'],
	'client-wiring': ['api'],
	ai: ['ai'],
	supabase: ['supabase'],
	'package-managers': ['package-manager'],
	'aws-limits': ['storage', 'ai', 'realtime', 'streaming-responses', 'in-memory-state'],
	deploy: [],
};

export interface Guide {
	/** The name to pass to `cdk-blocks blockify-app guide`: the file name without `.md`. */
	name: string;
	title: string;
	/** When the page matters, from its `> Read when:` line. */
	readWhen: string;
}

export interface RecommendedGuide extends Guide {
	/** The app has a surface this guide covers. */
	recommended: boolean;
}

/** Why the app cannot be migrated as it is. */
export interface Blocker {
	id: string;
	reason: string;
	/** What the user can do to make the migration possible. It is the user's decision, never a step of the migration. */
	fix: string;
}

/** The `--output json` result of `cdk-blocks blockify-app playbook`. */
export interface PlaybookResult {
	app: AppProfile;
	signals: Signal[];
	blockers: Blocker[];
	/** Facts and decisions that follow from what was detected. */
	notes: string[];
	guides: RecommendedGuide[];
	/** The playbook text; `null` when a blocker stops the migration. */
	playbook: string | null;
}

/** The text of a skill page, with `\n` line ends. */
function readPage(name: string): string {
	return readFileSync(join(SKILL_DIR, 'references', `${name}.md`), 'utf-8').replace(/\r\n/g, '\n');
}

/** The title and the `Read when` line of a page. */
function describePage(name: string, text: string): Guide {
	const title = /^# (.+)$/m.exec(text)?.[1];
	const readWhen = /^> Read when: (.+)$/m.exec(text)?.[1];
	if (title === undefined || readWhen === undefined) {
		throw new Error(`skill page references/${name}.md needs a "# Title" line and a "> Read when: …" line`);
	}
	return { name, title, readWhen };
}

/** Every guide of the skill, by name. */
export function listGuides(): Guide[] {
	return readdirSync(join(SKILL_DIR, 'references'))
		.filter((file) => file.endsWith('.md') && file !== `${PLAYBOOK_PAGE}.md`)
		.map((file) => file.slice(0, -'.md'.length))
		.sort()
		.map((name) => describePage(name, readPage(name)));
}

/** The text of guide `name`, or `undefined` when the skill has no such guide. */
export function readGuide(name: string): string | undefined {
	return name !== PLAYBOOK_PAGE && /^[a-z0-9-]+$/.test(name) && listGuides().some((guide) => guide.name === name)
		? readPage(name)
		: undefined;
}

/**
 * What the app has, as the words that `<!-- when: … -->` and
 * {@link GUIDE_TAGS} use: the framework, the rendering mode, the package
 * manager, and the category and the id of every signal.
 */
export function tagsOf({ app, signals }: Detection): Set<string> {
	const tags = new Set<string>([app.framework, app.rendering, app.packageManager]);
	for (const signal of signals) tags.add(signal.category).add(signal.id);
	return tags;
}

/** Keep the sections of `text` whose `<!-- when: a b -->` names one of `tags`, and drop the markers. */
export function selectSections(text: string, tags: ReadonlySet<string>): string {
	const kept: string[] = [];
	let keep = true;
	for (const line of text.split('\n')) {
		const when = /^\s*<!-- when: ([a-z0-9 -]+) -->\s*$/.exec(line);
		if (when) keep = when[1].split(' ').some((tag) => tags.has(tag));
		else if (/^\s*<!-- end -->\s*$/.test(line)) keep = true;
		else if (keep) kept.push(line);
	}
	return kept.join('\n');
}

/** The first `major.minor.patch` in `text`, with absent parts as 0: `^15.5` gives `[15, 5, 0]`. */
function versionIn(text: string): [number, number, number] | undefined {
	const match = /(\d+)(?:\.(\d+))?(?:\.(\d+))?/.exec(text);
	return match ? [Number(match[1]), Number(match[2] ?? 0), Number(match[3] ?? 0)] : undefined;
}

/**
 * Where `version` stands against a range of the form `>=a.b.c <d || >=e.f.g`:
 * inside it, below the lowest version of its own major (`upgrade` names that
 * version), or on a major that the range does not reach.
 */
export function rangeStanding(
	version: string,
	range: string,
):
	| { standing: 'supported' }
	| { standing: 'upgrade'; to: string }
	| { standing: 'unsupported'; lowest: string }
	| undefined {
	const parsed = versionIn(version);
	const floors = range.split('||').map((part) => versionIn(part));
	if (!parsed || floors.some((floor) => floor === undefined)) return undefined;
	const known = floors as [number, number, number][];
	const text = (v: readonly number[]) => v.join('.');
	const lowest = known.reduce((a, b) => (a[0] <= b[0] ? a : b));
	const highest = known.reduce((a, b) => (a[0] >= b[0] ? a : b));
	if (parsed[0] < lowest[0]) return { standing: 'unsupported', lowest: text(lowest) };
	// The last alternative has no upper bound: a later major is inside it.
	const floor =
		known.find((candidate) => candidate[0] === parsed[0]) ?? (parsed[0] > highest[0] ? highest : undefined);
	if (!floor) return { standing: 'unsupported', lowest: text(lowest) };
	const below = parsed[0] === floor[0] && (parsed[1] < floor[1] || (parsed[1] === floor[1] && parsed[2] < floor[2]));
	return below ? { standing: 'upgrade', to: text(floor) } : { standing: 'supported' };
}

const FRAMEWORK_NAMES: Readonly<Record<Framework, string>> = {
	nextjs: 'Next.js',
	nuxt: 'Nuxt',
	astro: 'Astro',
	sveltekit: 'SvelteKit',
	remix: 'Remix',
	'react-router': 'React Router (framework mode)',
	'tanstack-start': 'TanStack Start',
	gatsby: 'Gatsby',
	docusaurus: 'Docusaurus',
	angular: 'Angular',
	vite: 'Vite',
	'create-react-app': 'Create React App',
	'static-html': 'hand-written HTML',
	'server-only': 'a Node.js server with no frontend framework',
	unknown: 'unknown',
};

const RENDERING_NAMES: Readonly<Record<AppProfile['rendering'], string>> = {
	ssr: 'rendered on a server',
	static: 'built to static files',
	spa: 'a single-page app',
	none: 'no frontend',
	unknown: 'rendering mode not detected',
};

/** The surfaces in the order the playbook covers them. */
const CATEGORY_ORDER: readonly Signal['category'][] = [
	'hosting',
	'api',
	'data',
	'key-value',
	'auth',
	'storage',
	'jobs',
	'secrets',
	'ai',
	'realtime',
	'email',
	'platform',
	'package-manager',
];

/** The blockers and notes that follow from the detection. */
function assess({ app, signals }: Detection): Pick<PlaybookResult, 'blockers' | 'notes'> {
	const blockers: Blocker[] = [];
	const notes: string[] = [];
	const has = (id: string) => signals.some((signal) => signal.id === id);
	if (app.framework === 'nextjs' && app.rendering === 'ssr' && app.frameworkVersion !== null) {
		const next = rangeStanding(app.frameworkVersion, NEXT_SUPPORTED_RANGE);
		if (next?.standing === 'unsupported') {
			blockers.push({
				id: 'next-major-unsupported',
				reason:
					`This app renders on the server with Next.js ${app.frameworkVersion}. The hosting build of AWS Blocks supports ` +
					`server-rendered Next.js ${next.lowest} or later (the range is ${NEXT_SUPPORTED_RANGE}); an older major is ` +
					`untested, and a migration keeps the app's major version.`,
				fix:
					`The user upgrades the app to Next.js ${next.lowest} or later (https://nextjs.org/docs/app/guides/upgrading) and ` +
					'confirms that it still works where it runs today; the migration can start after that. ' +
					'A major-version upgrade of the framework changes the product, so it is not done as part of a migration.',
			});
		} else if (next?.standing === 'upgrade') {
			notes.push(
				`Next.js ${app.frameworkVersion} is below ${next.to}, the lowest version of its major that the hosting build supports ` +
					`(${NEXT_SUPPORTED_RANGE}). Upgrade "next" to at least ${next.to} in the scaffold task and record it in MIGRATION.md.`,
			);
		}
	}
	if (app.framework === 'react-router' && app.rendering === 'ssr') {
		blockers.push({
			id: 'ssr-framework-unsupported',
			reason:
				'This app renders on a server with React Router in framework mode. Hosting on AWS Blocks runs the server of ' +
				'Next.js, Nuxt and other Nitro frameworks, Astro and SvelteKit; it has no adapter for the React Router server, ' +
				'so the app could only be hosted without it.',
			fix:
				'The user decides whether the app may stop rendering on a server. If so, they set `ssr: false` in ' +
				'react-router.config.ts (SPA mode), move what its loaders and actions did on the server to code that runs in the ' +
				'browser, and confirm that the app still works where it runs today; the playbook then treats it as a single-page app. ' +
				'That changes how the product renders and loads its data, so it is not done as part of a migration.',
		});
	}
	const views = signals.find((signal) => signal.id === 'server-rendered-views');
	if (views) {
		notes.push(
			`The app's own server renders pages (a view engine or \`res.render\`, seen in ${views.evidence}). Hosting does not run that server: ` +
				'read "Pages that the app\'s own server renders" under "Fixed decisions" before you plan. ' +
				'What replaces a page it renders at "/" is a choice that only the user makes: without their answer, stop before the scaffold task.',
		);
	}
	if (app.blocks) {
		notes.push(
			'The app already has an aws-blocks/ directory: the scaffold task is done, or the app was on AWS Blocks before. Do not run the scaffolder again.',
		);
	}
	if (app.lockfiles.length > 1) {
		notes.push(
			`Lockfiles of more than one package manager (${app.lockfiles.join(', ')}): keep the one for ${app.packageManager}.`,
		);
	}
	if (has('next-static-export')) {
		notes.push(
			'Next.js static export: no server function. Use Hosting framework "static" with buildOutputDir "out" (guide nextjs, section "Static export").',
		);
	}
	if (app.framework === 'unknown' && has('workspaces')) {
		notes.push(
			'This directory is the root of a workspace, and no framework was found in it: the app is one of its packages. ' +
				'Find the package that holds the app, run `cdk-blocks -C <that directory> blockify-app playbook` for what it has, ' +
				'and read "Monorepos" in guide `package-managers`: AWS Blocks goes into the directory of the app, not into this one.',
		);
	} else if (app.framework === 'unknown') {
		notes.push(
			'The framework was not recognized. Read the build and start scripts to see how the app is served today.',
		);
	}
	if (app.framework === 'server-only') {
		notes.push(
			'No frontend framework was found: the app may be an API only, or its frontend may live in another directory.',
		);
	}
	return { blockers, notes };
}

/** `npx -y @aws-blocks/create-blocks-app@latest . --template … --yes --skip-install` for this app. */
export function scaffoldCommand(app: AppProfile): string {
	const template = app.framework === 'nextjs' && app.rendering === 'ssr' ? 'nextjs' : 'default';
	return `npx -y @aws-blocks/create-blocks-app@latest . --template ${template} --yes --skip-install`;
}

/** The "Detected" section: what the app is, the surfaces found, and the notes. */
function describeDetection({ app, signals }: Detection, notes: readonly string[]): string {
	const lines = [
		'## Detected in this repository',
		'',
		'Check each line against the repository before you rely on it.',
		'',
	];
	const name =
		app.name !== null ? `\`${app.name}\`` : app.hasPackageJson ? '(no name in package.json)' : '(no package.json)';
	lines.push(`- App: ${name}; package manager: ${app.packageManager}.`);
	const version = app.frameworkVersion === null ? '' : ` ${app.frameworkVersion}`;
	lines.push(`- Framework: ${FRAMEWORK_NAMES[app.framework]}${version}; ${RENDERING_NAMES[app.rendering]}.`);
	lines.push(
		`- Scripts: build ${app.buildScript === null ? 'none' : `\`${app.buildScript}\``}; start ${app.startScript === null ? 'none' : `\`${app.startScript}\``}.`,
	);
	const found = CATEGORY_ORDER.map((category) => ({
		category,
		signals: signals.filter((signal) => signal.category === category),
	})).filter((group) => group.signals.length > 0);
	lines.push(found.length > 0 ? '- Surfaces found (signal: where it was seen):' : '- Surfaces found: none.');
	for (const group of found) {
		lines.push(
			`  - ${group.category}: ${group.signals.map((signal) => `${signal.id} (${signal.evidence})`).join('; ')}`,
		);
	}
	if (app.envVars.length > 0) lines.push(`- Environment variable names: ${app.envVars.join(', ')}.`);
	const missing = CATEGORY_ORDER.filter(
		(category) =>
			!['hosting', 'platform', 'package-manager'].includes(category) &&
			!signals.some((signal) => signal.category === category),
	);
	if (missing.length > 0) {
		lines.push(
			`- Not found: ${missing.join(', ')}. Detection reads dependencies, config files and common code patterns. ` +
				'It does not see a surface built by hand (a custom server, raw SQL, hand-written sessions), so inspect the code for these too.',
		);
	}
	for (const note of notes) lines.push(`- ${note}`);
	lines.push(`- Scaffold command for this app: \`${scaffoldCommand(app)}\``);
	return lines.join('\n');
}

/** The guide list that ends the playbook: the recommended guides first. */
function describeGuides(guides: readonly RecommendedGuide[]): string {
	const lines = ['## Guides', '', 'Print one or more with `cdk-blocks blockify-app guide <name>...`.', ''];
	const recommended = guides.filter((guide) => guide.recommended);
	if (recommended.length > 0) {
		lines.push('Read these before you write the tasks they cover; this app has their surface:', '');
		for (const guide of recommended) lines.push(`- \`${guide.name}\`: ${guide.title}. Read when ${guide.readWhen}`);
		lines.push('');
	}
	lines.push('Read these when their topic comes up:', '');
	for (const guide of guides.filter((guide) => !guide.recommended)) {
		lines.push(`- \`${guide.name}\`: ${guide.title}. Read when ${guide.readWhen}`);
	}
	return lines.join('\n');
}

/**
 * Compose the playbook for the app at `root`: detect it, find what stops the
 * migration, and select the playbook sections and guides that apply.
 */
export function composePlaybook(root: string): PlaybookResult {
	const detection = detectApp(root);
	const tags = tagsOf(detection);
	const { blockers, notes } = assess(detection);
	const guides = listGuides().map((guide) => ({
		...guide,
		recommended: (GUIDE_TAGS[guide.name] ?? []).some((tag) => tags.has(tag)),
	}));
	if (blockers.length > 0) return { ...detection, blockers, notes, guides, playbook: null };
	// The page's own title and "Read when" line give way to the detection.
	const body = selectSections(readPage(PLAYBOOK_PAGE), tags).replace(/^# .+\n+> Read when: .+\n+/, '');
	const playbook = [
		'# Playbook: move this app onto AWS Blocks',
		describeDetection(detection, notes),
		body.trim(),
		describeGuides(guides),
	].join('\n\n');
	return { ...detection, blockers, notes, guides, playbook: `${playbook}\n` };
}
