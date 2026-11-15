// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * The declarative command tree of the `cdk-blocks` CLI: groups, canonical names,
 * hidden aliases, descriptions, flags, examples and handlers.
 *
 * Command names are data. Renaming a command, or making an alias canonical,
 * is an edit here; the parser and the help read only this table.
 */

import { blockifyCheck, blockifyGuide, blockifyPlaybook, blockifySkill } from './commands/blockify-app.js';
import { migrate } from './commands/migrate.js';
import * as commands from './commands.js';
import type { Context } from './context.js';

export type FlagType = 'boolean' | 'string' | 'optional-string';

export interface FlagSpec {
	/** The long name, without `--`. */
	name: string;
	/** A one-letter short name, without `-`. */
	short?: string;
	/** `optional-string` takes an inline value only: `--wait-live` or `--wait-live=120`. */
	type: FlagType;
	/** The value placeholder in help, for example `N`. */
	value?: string;
	description: string;
	/** Collect every occurrence into an array. */
	multiple?: boolean;
}

export interface ArgSpec {
	name: string;
	description: string;
	required?: boolean;
	/** Takes the remaining positionals. */
	variadic?: boolean;
}

/** Root help groups, in display order. */
export const GROUPS = ['Develop', 'Deploy', 'Configure', 'Generate', 'Data and blocks', 'Project'] as const;
export type HelpGroup = (typeof GROUPS)[number];

export type FlagValues = Record<string, string | boolean | string[] | undefined>;

/**
 * The shape of a JSON result, so that a `--query` path is checked before the
 * command runs: `null` for a value, an object's fields, or a one-element
 * array for a list whose elements have that shape. An object whose field
 * names are data (script names) declares the shape of every field as `'*'`.
 */
export type JsonShape = null | readonly [JsonShape] | JsonObjectShape;
export interface JsonObjectShape {
	readonly [field: string]: JsonShape;
}

export interface CommandInput {
	flags: FlagValues;
	positionals: string[];
	/** For a passthrough command, every token after the command; otherwise the tokens after `--`. */
	passthrough: string[];
}

export type Handler = (ctx: Context, input: CommandInput) => Promise<number>;

export interface Example {
	command: string;
	description: string;
}

export interface CommandSpec {
	/** The canonical path, for example `['sandbox', 'destroy']`. */
	path: readonly string[];
	group: HelpGroup;
	summary: string;
	/** Longer help text; defaults to the summary. */
	description?: string;
	args?: ArgSpec[];
	flags?: FlagSpec[];
	examples?: Example[];
	/**
	 * Forward every token after the command verbatim. A `-h`/`--help` anywhere
	 * after it never runs the tool with the user's arguments: it shows help instead.
	 */
	passthrough?: boolean;
	/**
	 * The verbs of a passthrough tool that print their own help. Help for one of
	 * them forwards only `<verb> --help` (never the other arguments) to the tool,
	 * which prints that verb's usage without side effects.
	 */
	verbs?: readonly string[];
	/** The shape of the `--output json` result; absent when the command has no JSON output. */
	json?: JsonObjectShape;
	/**
	 * The command calls AWS or deploys to it, so an inherited AWS_REGION must be a
	 * Region code. An explicit `--region` is checked for every command.
	 */
	aws?: boolean;
	/** Absent for a command group, which prints its help and exits 2. */
	handler?: Handler;
}

export interface AliasSpec {
	/** The alias tokens, for example `['dev:stop']`. */
	name: readonly string[];
	/** The canonical path it runs. */
	target: readonly string[];
	/** Arguments inserted before the user's own, for example `['--all']`. */
	args?: readonly string[];
}

/** A hidden flag spelling of another command: `cdk-blocks sandbox --deploy-only` runs `cdk-blocks sandbox deploy`. */
export interface FlagAliasSpec {
	/** The command the flag is given to. */
	command: readonly string[];
	/** The flag, without `--`. It takes no value. */
	flag: string;
	/** The canonical path it runs. */
	target: readonly string[];
}

/** Options accepted at every level. `-v` is `--verbose`; `--version` is long-only. */
export const GLOBAL_FLAGS: readonly FlagSpec[] = [
	{ name: 'help', short: 'h', type: 'boolean', description: 'Show help for the current command level' },
	{ name: 'version', type: 'boolean', description: 'Print the @aws-blocks/blocks version' },
	{ name: 'quiet', short: 'q', type: 'boolean', description: 'Errors and final results only' },
	{ name: 'verbose', short: 'v', type: 'boolean', description: 'Include raw output from CDK and child tools' },
	{ name: 'debug', type: 'boolean', description: 'Verbose, plus stack traces and internal diagnostics' },
	{
		name: 'output',
		type: 'string',
		value: 'text|json',
		description: 'Result format on stdout; json prints one JSON document, progress stays on stderr',
	},
	{ name: 'yes', short: 'y', type: 'boolean', description: 'Assume yes for confirmations' },
	{
		name: 'no-input',
		type: 'boolean',
		description: 'Never prompt; implied when stdin is not a TTY or CI is set',
	},
	{
		name: 'query',
		type: 'string',
		value: 'path',
		description: 'Print one field of the JSON result, raw (for example: --query apiUrl)',
	},
	{ name: 'profile', type: 'string', value: 'name', description: 'AWS profile; sets AWS_PROFILE for the run' },
	{ name: 'region', type: 'string', value: 'region', description: 'AWS Region; sets AWS_REGION for the run' },
	{ name: 'cwd', short: 'C', type: 'string', value: 'dir', description: 'Run as if started in <dir>' },
	{
		name: 'telemetry-file',
		type: 'string',
		value: 'path',
		description: "Also write the run's telemetry events to <path>",
	},
];

const STAGE_HELP =
	'--stage <name> takes any name; there is no fixed list. A value set with --stage <name> is\n' +
	'stored at <prefix>/<name>/<KEY>, and the app reads it only when its Hosting %STORE% sets\n' +
	"stage: '<name>'. Without --stage, the value is shared: every stage falls back to it.";

/** The deploy result: `{apiUrl, url, stack, account, region}`. */
const DEPLOY_RESULT: JsonObjectShape = { apiUrl: null, url: null, stack: null, account: null, region: null };

export const COMMANDS: readonly CommandSpec[] = [
	// ── Develop ──────────────────────────────────────────────────────────────
	{
		path: ['dev'],
		group: 'Develop',
		summary: 'Run the app locally, with reload; no AWS',
		description:
			'Run the app locally against local mocks, with reload on save. No AWS account is needed.\n' +
			'The frontend command comes from package.json "blocks.dev", or is detected from vite or next.',
		flags: [
			{
				name: 'port',
				type: 'string',
				value: 'N',
				description: 'Port you open in the browser (serves the app and proxies the frontend) [3000]',
			},
			{
				name: 'host',
				type: 'string',
				value: 'host',
				description: 'Interface to bind (default: 127.0.0.1)',
			},
			{
				name: 'frontend-command',
				type: 'string',
				value: 'cmd',
				description: 'Command that starts the frontend dev server',
			},
			{
				name: 'frontend-port',
				type: 'string',
				value: 'N',
				description: 'Internal port of the frontend dev server, proxied behind --port [3100]',
			},
			{ name: 'no-frontend', type: 'boolean', description: 'Run the backend only' },
		],
		examples: [
			{ command: 'cdk-blocks dev', description: 'open http://localhost:3000' },
			{ command: 'cdk-blocks dev --port 4000', description: 'open http://localhost:4000' },
			{ command: 'cdk-blocks dev --no-frontend', description: 'backend only' },
		],
		handler: commands.dev,
	},
	{
		path: ['dev', 'stop'],
		group: 'Develop',
		summary: 'Stop the local dev server this app started',
		description:
			'Stop the local dev server that this app started on the port. It acts only on the process\n' +
			'that the dev server recorded for itself, never on another process that holds the port.\n' +
			'Without --port, when nothing is recorded on the configured port but exactly one dev server\n' +
			'is recorded on another (cdk-blocks dev --port N), it stops that one.',
		flags: [
			{
				name: 'port',
				type: 'string',
				value: 'N',
				description: 'Port of the dev server to stop [the "cdk-blocks dev" port]',
			},
			{ name: 'all', type: 'boolean', description: 'Stop every dev server this app recorded, on any port' },
		],
		json: { stopped: [{ port: null, stopped: null, alreadyStopped: null, portFree: null, via: null }] },
		examples: [
			{ command: 'cdk-blocks dev stop', description: 'Stop the dev server on the configured port' },
			{ command: 'cdk-blocks dev stop --all', description: 'Stop every dev server this app started' },
		],
		handler: commands.devStop,
	},
	{
		path: ['sandbox'],
		group: 'Develop',
		summary: 'Deploy your personal sandbox, watch for changes, and run the local server against it',
		description:
			'Deploy your personal sandbox stack, then watch for changes and run the local server\n' +
			'against it. Ctrl-C stops the local processes; the stack keeps running until you\n' +
			'run "cdk-blocks sandbox destroy".',
		examples: [{ command: 'cdk-blocks sandbox', description: 'Deploy and watch your sandbox' }],
		aws: true,
		handler: commands.sandbox,
	},
	{
		path: ['sandbox', 'deploy'],
		group: 'Develop',
		summary: 'Deploy the sandbox once and exit (CI)',
		json: DEPLOY_RESULT,
		examples: [
			{ command: 'cdk-blocks sandbox deploy', description: 'Deploy once and exit' },
			{
				command: 'API_URL=$(cdk-blocks sandbox deploy --query apiUrl)',
				description: 'Deploy, then keep the API URL in a shell variable',
			},
		],
		aws: true,
		handler: commands.sandboxDeploy,
	},
	{
		path: ['sandbox', 'preview'],
		group: 'Develop',
		summary: 'Deploy the sandbox with a hosted preview of the frontend once and exit',
		description:
			'Deploy your sandbox with the app hosted in preview shape (API Gateway, no CloudFront), print\n' +
			'the preview URL, and exit. It is the same stack as "cdk-blocks sandbox": a plain sandbox deploy\n' +
			'removes the preview, and re-adding it gives a new URL. A re-deploy hotswaps a code-only change.',
		json: DEPLOY_RESULT,
		examples: [
			{ command: 'cdk-blocks sandbox preview', description: 'Deploy a hosted preview and print its URL' },
			{
				command: 'URL=$(cdk-blocks sandbox preview --query url)',
				description: 'Deploy, then keep the preview URL in a shell variable',
			},
		],
		aws: true,
		handler: commands.sandboxPreview,
	},
	{
		path: ['sandbox', 'destroy'],
		group: 'Develop',
		summary: 'Delete your sandbox stack (never production)',
		description:
			'Delete your personal sandbox stack. This never touches the production stack.\n' +
			'In an interactive terminal it asks first; --yes skips the question.',
		examples: [{ command: 'cdk-blocks sandbox destroy --yes', description: 'Delete the sandbox without asking' }],
		aws: true,
		handler: commands.sandboxDestroy,
	},
	{
		path: ['sandbox', 'console'],
		group: 'Develop',
		summary: 'Open the AWS console for the sandbox stack',
		examples: [{ command: 'cdk-blocks sandbox console', description: 'Open the CloudFormation console' }],
		aws: true,
		handler: commands.sandboxConsole,
	},
	// ── Deploy ───────────────────────────────────────────────────────────────
	{
		path: ['deploy'],
		group: 'Deploy',
		summary: 'Deploy the production stack',
		description:
			'Deploy the production stack. The target (stack, Region, credentials) is printed first.\n' +
			'With --output json, stdout carries one document: {apiUrl, url, stack, account, region}.',
		flags: [
			{
				name: 'wait-live',
				type: 'optional-string',
				value: 'SECONDS',
				description: 'Wait until CloudFront serves the new build (optional budget, default 180)',
			},
			{
				name: 'wait-live-timeout',
				type: 'string',
				value: 'SECONDS',
				description: 'Budget for --wait-live, in seconds (1-3600)',
			},
		],
		json: { ...DEPLOY_RESULT, live: null },
		examples: [
			{ command: 'cdk-blocks deploy', description: 'Deploy to production' },
			{ command: 'cdk-blocks deploy --wait-live=300', description: 'Deploy, then wait up to 300s for the new build' },
			{ command: 'cdk-blocks deploy --output json', description: 'Print {apiUrl, url, stack, account, region}' },
			{ command: 'API_URL=$(cdk-blocks deploy --query apiUrl)', description: 'Print only the API URL, raw' },
		],
		aws: true,
		handler: commands.deploy,
	},
	{
		path: ['destroy'],
		group: 'Deploy',
		summary: 'Delete the production stack',
		description:
			'Delete the production stack. The target is printed first. In an interactive terminal it\n' +
			'asks for confirmation; without a terminal it requires --yes and exits 2 otherwise.',
		examples: [
			{ command: 'cdk-blocks destroy', description: 'Delete production, after a confirmation' },
			{ command: 'cdk-blocks destroy --yes', description: 'Delete production without asking (CI)' },
		],
		aws: true,
		handler: commands.destroy,
	},
	{
		path: ['whoami'],
		group: 'Deploy',
		summary: 'Show the AWS identity, Region and the stacks that commands would affect',
		description:
			'Show the AWS identity, the Region, and the sandbox and production stacks that\n' +
			'"cdk-blocks sandbox" and "cdk-blocks deploy" would affect. Nothing is deployed.\n' +
			'The identity and Region are the ones "cdk-blocks deploy" uses, with .env.production\n' +
			'applied. A warning names the AWS settings that .env.local sets differently\n' +
			'for the sandbox.',
		json: {
			account: null,
			arn: null,
			credentials: null,
			region: null,
			projectRoot: null,
			stacks: { sandbox: null, production: null },
		},
		examples: [
			{ command: 'cdk-blocks whoami', description: 'Show the deployment target' },
			{ command: 'cdk-blocks whoami --profile prod --output json', description: 'The same, as JSON' },
			{ command: 'cdk-blocks whoami --query stacks.production', description: 'Print the production stack name' },
		],
		aws: true,
		handler: commands.whoami,
	},
	// ── Configure ────────────────────────────────────────────────────────────
	{
		path: ['secret'],
		group: 'Configure',
		summary: 'Manage secrets: set KEY, list, remove KEY',
		description:
			'Manage secrets. The tokens after "secret" are forwarded unchanged, except the global options\n' +
			'(--profile, --output, …) before a "--". A secret value is never\n' +
			'accepted on the command line: pipe it with --value-stdin, or omit it to be prompted.\n' +
			'Flags: --stage <name>, --value-stdin, --region <name>, --prefix <path>, --force, --yes.\n' +
			'"cdk-blocks secret <set|list|remove> --help" shows the flags of one subcommand.\n' +
			STAGE_HELP.replace('%STORE%', 'secretStore'),
		args: [{ name: 'subcommand', description: 'set KEY | list | remove KEY', variadic: true }],
		passthrough: true,
		verbs: ['set', 'list', 'remove', 'rm'],
		examples: [
			{ command: 'cdk-blocks secret set API_KEY', description: 'Set API_KEY (prompts for the value)' },
			{ command: 'cat key.txt | cdk-blocks secret set API_KEY --value-stdin', description: 'Set it from stdin' },
			{
				command: 'cdk-blocks secret set API_KEY --stage prod',
				description: "only for an app whose Hosting secretStore sets stage: 'prod'",
			},
		],
		aws: true,
		handler: commands.secret,
	},
	{
		path: ['config'],
		group: 'Configure',
		summary: 'Manage non-secret config: set KEY VALUE, list, remove KEY',
		description:
			'Manage non-secret config values. The tokens after "config" are forwarded unchanged, except\n' +
			'the global options (--profile, --output, …) before a "--"; put a value that starts with "-" after "--".\n' +
			'Flags: --stage <name>, --value-stdin, --region <name>, --prefix <path>.\n' +
			'"cdk-blocks config <set|list|remove> --help" shows the flags of one subcommand.\n' +
			STAGE_HELP.replace('%STORE%', 'configStore'),
		args: [{ name: 'subcommand', description: 'set KEY VALUE | list | remove KEY', variadic: true }],
		passthrough: true,
		verbs: ['set', 'list', 'remove', 'rm'],
		examples: [
			{ command: 'cdk-blocks config set FEATURE_FLAG on', description: 'Set FEATURE_FLAG' },
			{ command: 'cdk-blocks config list', description: 'List config values' },
		],
		aws: true,
		handler: commands.config,
	},
	{
		path: ['telemetry'],
		group: 'Configure',
		summary: 'Show or change telemetry consent',
		description:
			'Show or change telemetry consent for this project, or for every project with --global.\n' +
			'Also accepts --status, --enable and --disable.',
		args: [{ name: 'action', description: 'status (default) | enable | disable' }],
		flags: [
			{ name: 'global', type: 'boolean', description: 'Apply to every project (~/.blocks/config.json)' },
			{ name: 'status', type: 'boolean', description: 'Same as "status"' },
			{ name: 'enable', type: 'boolean', description: 'Same as "enable"' },
			{ name: 'disable', type: 'boolean', description: 'Same as "disable"' },
		],
		examples: [
			{ command: 'cdk-blocks telemetry', description: 'Show the telemetry status' },
			{ command: 'cdk-blocks telemetry disable --global', description: 'Disable telemetry everywhere' },
		],
		handler: commands.telemetry,
	},
	// ── Generate ─────────────────────────────────────────────────────────────
	{
		path: ['generate'],
		group: 'Generate',
		summary: 'Generate the typed client, the OpenRPC spec or key types',
	},
	{
		path: ['generate', 'client'],
		group: 'Generate',
		summary: 'Generate the typed client',
		args: [
			{ name: 'foundation', description: 'Backend entry (default: aws-blocks/index.ts)' },
			{ name: 'output', description: 'Output file (default: aws-blocks/client.js)' },
		],
		flags: [
			{
				name: 'force',
				type: 'boolean',
				description: 'Write aws-blocks/client.js even when package.json sets "blocks.dev.generateClient": false',
			},
		],
		examples: [{ command: 'cdk-blocks generate client', description: 'Write aws-blocks/client.js' }],
		handler: commands.generateClient,
	},
	{
		path: ['generate', 'spec'],
		group: 'Generate',
		summary: 'Generate the OpenRPC spec',
		args: [
			{ name: 'backend', description: 'Backend entry (default: aws-blocks/index.ts)' },
			{ name: 'output', description: 'Output file (default: blocks.spec.json next to the backend)' },
		],
		examples: [{ command: 'cdk-blocks generate spec', description: 'Write aws-blocks/blocks.spec.json' }],
		handler: commands.generateSpec,
	},
	{
		path: ['generate', 'types'],
		group: 'Generate',
		summary: 'Generate secret/config key types; --check exits 1 when stale',
		flags: [
			{ name: 'check', type: 'boolean', description: 'Exit 1 when the generated types are stale (CI)' },
			{ name: 'watch', short: 'w', type: 'boolean', description: 'Regenerate on change' },
			{ name: 'out', type: 'string', value: 'path', description: 'Output .d.ts path' },
			{ name: 'include', type: 'string', value: 'glob', multiple: true, description: 'Source glob to scan' },
			{ name: 'module', type: 'string', value: 'spec', multiple: true, description: 'Module to augment' },
		],
		examples: [
			{ command: 'cdk-blocks generate types', description: 'Regenerate the key types' },
			{ command: 'cdk-blocks generate types --check', description: 'Fail when they are stale' },
		],
		handler: commands.generateTypes,
	},
	// ── Data and blocks ──────────────────────────────────────────────────────
	{
		path: ['db'],
		group: 'Data and blocks',
		summary: 'Data block operations: migrate, status, generate-types, pull',
		description:
			'Run a data block operation. The verb and the tokens after it are forwarded unchanged to the\n' +
			'bb-data CLI of @aws-blocks/bb-data, except the global options (--profile, --output, …) before\n' +
			'a "--". "cdk-blocks db <verb> --help" shows its options.',
		args: [
			{ name: 'verb', description: 'migrate | status | generate-types | pull', required: true },
			{ name: 'args', description: 'Forwarded; a relative path is resolved from your directory', variadic: true },
		],
		passthrough: true,
		verbs: ['migrate', 'status', 'generate-types', 'pull'],
		examples: [
			{
				command: 'cdk-blocks db migrate aws-blocks/migrations',
				description: 'Apply pending migrations to the local database',
			},
			{ command: 'cdk-blocks db status aws-blocks/migrations', description: 'Show applied and pending migrations' },
			{ command: 'cdk-blocks db pull', description: 'Introspect the database and write its files' },
		],
		handler: commands.db,
	},
	// ── Project ──────────────────────────────────────────────────────────────
	{
		path: ['vendorize'],
		group: 'Project',
		summary: 'Copy a Building Block into the app for customization',
		args: [
			{ name: 'package', description: 'For example @aws-blocks/bb-kv-store', required: true },
			{ name: 'options', description: '--force overwrites an existing copy', variadic: true },
		],
		passthrough: true,
		examples: [{ command: 'cdk-blocks vendorize @aws-blocks/bb-kv-store', description: 'Copy KVStore into the app' }],
		handler: commands.vendorize,
	},
	{
		path: ['migrate'],
		group: 'Project',
		summary: 'Move an app from aws-blocks/scripts wrappers to cdk-blocks commands',
		description:
			'Move an app that create-blocks-app scaffolded with aws-blocks/scripts/*.ts wrappers to the cdk-blocks\n' +
			'CLI. Scripts whose value is exactly a generated command (for example "tsx aws-blocks/scripts/deploy.ts")\n' +
			'become cdk-blocks aliases ("cdk-blocks deploy"); every other script stays as it is. The options of a\n' +
			'generated server.ts move to package.json "blocks.dev". Generated wrappers that no script and no\n' +
			'app file other than Markdown docs uses any more are deleted. Only the wrappers of public\n' +
			'create-blocks-app releases are recognised; any other version is reported as unrecognised and is\n' +
			'never deleted. In a git repository the app files are the tracked and not-ignored ones,\n' +
			'and the files of a submodule or nested repository inside the app; outside git, or where git does\n' +
			'not track the app, the files under the app directory other than node_modules and build output.\n' +
			'In a monorepo, and in the superproject of a submodule, it also reads every tracked package.json\n' +
			'and CI, shell, Make and Docker file outside the app (.github/workflows/*, scripts/*.sh,\n' +
			'ci/Makefile); there a path counts only with the directory of this app\n' +
			'(apps/web/aws-blocks/scripts/deploy.ts), or in a file that changes into the app\n' +
			'(working-directory: apps/web, cd apps/web). In CI, shell and Docker files and in scripts, a bare\n' +
			'scripts/deploy.ts or deploy.ts counts as a use too.\n' +
			'Unless you pass --force, it refuses an app outside git (or without git installed), a git working\n' +
			'tree with uncommitted changes, an app that git does not track (a parent repository ignores its\n' +
			'directory), since git could not undo the changes, and a repository that git fails to read. Run\n' +
			'--dry-run first to see the plan.\n' +
			'Exit codes:\n' +
			'  0  fully migrated, or nothing to do\n' +
			'  1  kept items remain for you to finish by hand (a report, not a crash), or migrate refused and\n' +
			'     wrote nothing; with --output json a refusal prints {"error": {"message", "hint"}} on stdout\n' +
			'     instead of the result (with --query, only the error on stderr)\n' +
			'  2  usage error',
		flags: [
			{ name: 'dry-run', type: 'boolean', description: 'Print the plan; write nothing' },
			{
				name: 'force',
				type: 'boolean',
				description:
					'Run outside git, with uncommitted changes, or where git does not track the app or fails to read it',
			},
		],
		json: {
			changed: [null],
			removed: [null],
			kept: [{ file: null, reason: null }],
			scriptsRewritten: { '*': { from: null, to: null } },
			devConfig: { port: null, frontendCommand: null, frontendPort: null, frontend: null },
		},
		examples: [
			{ command: 'cdk-blocks migrate --dry-run', description: 'Show what would change' },
			{ command: 'cdk-blocks migrate', description: 'Rewrite the scripts and delete the generated wrappers' },
			{
				command: 'cdk-blocks migrate --output json',
				description: 'Print {changed, removed, kept, scriptsRewritten, devConfig}',
			},
		],
		handler: migrate,
	},
	{
		path: ['blockify-app'],
		group: 'Project',
		summary: 'Help a coding agent move an existing app onto AWS Blocks: playbook, guides, checks',
	},
	{
		path: ['blockify-app', 'playbook'],
		group: 'Project',
		summary: 'Print the playbook for moving an existing app onto AWS Blocks (for coding agents)',
		description:
			'Print the playbook that a coding agent follows to move an existing web app (Next.js, a Vite or\n' +
			'other single-page app, a static site, an app with its own Node.js server) onto AWS Blocks, in\n' +
			'the same repository. Run it in the root of an app that is not on AWS Blocks yet; it needs no\n' +
			'installed dependencies and no AWS account, and it changes no file.\n' +
			'It reads package.json, the lockfiles, the framework and platform config files and the source\n' +
			'files (never the values in .env files), and prints: what it detected, with the file or\n' +
			'dependency that shows it; the procedure, with the sections that apply to this app; and the\n' +
			'guides to read for the surfaces the app has ("cdk-blocks blockify-app guide <name>").\n' +
			'When the app cannot be migrated as it is (a server-rendered Next.js version that AWS Blocks\n' +
			'does not host), it prints the reason and the fix, and exits 1; with --output json, "playbook"\n' +
			'is null and "blockers" lists them.\n' +
			'The text is the "migrate-to-aws-blocks" Agent Skill that this package ships in skills/;\n' +
			'"cdk-blocks blockify-app skill <dir>" copies it for agents that load skills.',
		json: {
			app: {
				name: null,
				hasPackageJson: null,
				blocks: null,
				packageManager: null,
				lockfiles: [null],
				framework: null,
				frameworkPackage: null,
				frameworkVersion: null,
				rendering: null,
				buildScript: null,
				startScript: null,
				envVars: [null],
			},
			signals: [{ id: null, category: null, evidence: null }],
			blockers: [{ id: null, reason: null, fix: null }],
			notes: [null],
			guides: [{ name: null, title: null, readWhen: null, recommended: null }],
			playbook: null,
		},
		examples: [
			{ command: 'cdk-blocks blockify-app playbook', description: 'Print the playbook for the app in this directory' },
			{
				command: 'npx -y -p @aws-blocks/blocks cdk-blocks blockify-app playbook',
				description: 'The same, in an app that has not installed @aws-blocks/blocks yet',
			},
			{
				command: 'cdk-blocks blockify-app playbook --query app.framework',
				description: 'Print only the detected framework',
			},
		],
		handler: blockifyPlaybook,
	},
	{
		path: ['blockify-app', 'guide'],
		group: 'Project',
		summary: 'Print a migration guide: auth, database, nextjs, secrets, …',
		description:
			'Print one or more guides of the migration playbook, each on one topic: how a surface of an\n' +
			'existing app (sign-in, relational data, file uploads, scheduled jobs, secrets, API routes) maps\n' +
			'to AWS Blocks, what differs between the local server and AWS, and what to record for the user.\n' +
			'Without a name it lists the guides and when to read each one.',
		args: [
			{ name: 'name', description: 'A guide name, for example "auth"; several print in order', variadic: true },
		],
		json: { guides: [{ name: null, title: null, readWhen: null, text: null }] },
		examples: [
			{ command: 'cdk-blocks blockify-app guide', description: 'List the guides' },
			{ command: 'cdk-blocks blockify-app guide auth database', description: 'Print two guides' },
		],
		handler: blockifyGuide,
	},
	{
		path: ['blockify-app', 'check'],
		group: 'Project',
		summary: 'Check a migrated app against the playbook rules that its files show',
		description:
			'Check the app in this directory against the rules of the migration playbook that its files show:\n' +
			'the scaffold, the dependencies and the workspace, one lockfile, a backend without the demo API\n' +
			'and with a scope id that AWS resource names can hold,\n' +
			'the Hosting block for the detected framework (for Nuxt, a server that streams its responses; for\n' +
			'Astro with its own adapter, a server bundle that needs no node_modules), the OpenNext and Next.js\n' +
			'versions, the same major\n' +
			'version of the framework as in the last commit, every environment variable that server code reads\n' +
			'declared on the Hosting block, client generation in the build, the .gitignore entries, and\n' +
			'MIGRATION.md: its sections, no open task, and each Hosting secret() or config() value named\n' +
			'under "Before deploy".\n' +
			'It reads files and asks git which paths are ignored. It runs no build, no synth and no server:\n' +
			'the validate task of the playbook does those.\n' +
			'With --server it also starts the server function that "cdk synth" wrote for Hosting, from a\n' +
			'read-only copy of the directory that the deploy uploads, away from node_modules and without\n' +
			'AWS: a server that exits at start for want of a package, or a handler that buffers its response\n' +
			'where the template invokes it with response streaming, deploys without an error and answers 502\n' +
			'on every path. It needs cdk.out, so run it after the synth; an app served as files passes.\n' +
			'Exit codes: 0 when every check passes; 1 when one fails, each with a "Fix:" line.',
		flags: [
			{
				name: 'server',
				type: 'boolean',
				description: 'Also start the server function in cdk.out as AWS Lambda would (run after cdk synth)',
			},
		],
		json: { ok: null, checks: [{ id: null, ok: null, message: null, fix: null }] },
		examples: [
			{ command: 'cdk-blocks blockify-app check', description: 'Check the app in this directory' },
			{ command: 'cdk-blocks blockify-app check --server', description: 'After cdk synth: also start the server' },
			{ command: 'cdk-blocks blockify-app check --query ok', description: 'Print true or false' },
		],
		handler: blockifyCheck,
	},
	{
		path: ['blockify-app', 'skill'],
		group: 'Project',
		summary: 'Copy the migration playbook as an Agent Skill into a skills directory',
		description:
			'Copy the "migrate-to-aws-blocks" Agent Skill (SKILL.md and its references/) to\n' +
			'<dir>/migrate-to-aws-blocks, for a coding agent that loads skills from a directory, for example\n' +
			'.claude/skills or .agents/skills. The skill is the text that "cdk-blocks blockify-app playbook" and\n' +
			'"cdk-blocks blockify-app guide" print.',
		args: [
			{
				name: 'dir',
				description: 'The skills directory to copy into, for example .claude/skills',
				required: true,
			},
		],
		flags: [{ name: 'force', type: 'boolean', description: 'Replace the files of an existing copy' }],
		json: { skill: null, path: null, files: [null] },
		examples: [
			{
				command: 'cdk-blocks blockify-app skill .claude/skills',
				description: 'Install the skill for Claude Code in this project',
			},
		],
		handler: blockifySkill,
	},
	{
		path: ['help'],
		group: 'Project',
		summary: 'Show help for a command',
		args: [{ name: 'command', description: 'For example "sandbox destroy"', variadic: true }],
		examples: [
			{ command: 'cdk-blocks help sandbox destroy', description: 'Help for "cdk-blocks sandbox destroy"' },
		],
		handler: commands.help,
	},
];

/** Hidden aliases. They keep the npm-script spellings working and never appear in grouped help. */
export const ALIASES: readonly AliasSpec[] = [
	{ name: ['dev:stop'], target: ['dev', 'stop'] },
	{ name: ['cleanup'], target: ['dev', 'stop'], args: ['--all'] },
	{ name: ['sandbox', 'up'], target: ['sandbox'] },
	{ name: ['sandbox:deploy'], target: ['sandbox', 'deploy'] },
	{ name: ['sandbox:preview'], target: ['sandbox', 'preview'] },
	{ name: ['sandbox:destroy'], target: ['sandbox', 'destroy'] },
	{ name: ['sandbox:console'], target: ['sandbox', 'console'] },
	{ name: ['console'], target: ['sandbox', 'console'] },
	{ name: ['typegen'], target: ['generate', 'types'] },
	{ name: ['generate-client'], target: ['generate', 'client'] },
	{ name: ['spec'], target: ['generate', 'spec'] },
];

/** Hidden flag aliases, for the flags of the scripts that the npm scripts ran before the CLI. */
export const FLAG_ALIASES: readonly FlagAliasSpec[] = [
	{ command: ['sandbox'], flag: 'deploy-only', target: ['sandbox', 'deploy'] },
	{ command: ['sandbox'], flag: 'preview', target: ['sandbox', 'preview'] },
];

/** The canonical command for a path, if any. */
export function findCommand(path: readonly string[]): CommandSpec | undefined {
	const key = path.join(' ');
	return COMMANDS.find((command) => command.path.join(' ') === key);
}

/** The direct subcommands of a command path. */
export function subcommandsOf(path: readonly string[]): CommandSpec[] {
	const prefix = path.join(' ');
	return COMMANDS.filter(
		(command) => command.path.length === path.length + 1 && command.path.slice(0, -1).join(' ') === prefix,
	);
}
