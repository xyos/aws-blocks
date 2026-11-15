// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * The `cdk-blocks blockify-app` subcommands that help a coding agent move an
 * existing app onto AWS Blocks: `playbook` (what to do, for this app), `guide`
 * (one topic in depth), `check` (the playbook's rules, checked on the files)
 * and `skill` (the same text as an Agent Skill directory).
 *
 * They run in the app's directory, which is not an AWS Blocks app yet: none of
 * them needs a project root, AWS credentials or installed dependencies.
 */

import { cpSync, type Dirent, existsSync, readdirSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import type { Context } from '../context.js';
import { CliError, ExitCode, UsageError } from '../errors.js';
import { suggest } from '../parse.js';
import type { CommandInput } from '../registry.js';
import { checkMigration } from './blockify-check.js';
import { composePlaybook, listGuides, readGuide, SKILL_DIR } from './blockify-playbook.js';
import { checkServerBundle } from './blockify-server.js';

/** The directory name of the skill, which the Agent Skills format requires to equal its `name`. */
const SKILL_NAME = 'migrate-to-aws-blocks';

/** `cdk-blocks blockify-app playbook`: exit 1 with the reasons when the app cannot be migrated as it is. */
export async function blockifyPlaybook(ctx: Context): Promise<number> {
	const result = composePlaybook(ctx.startDir);
	if (result.playbook !== null) {
		ctx.out.result(result, result.playbook);
		return ExitCode.Ok;
	}
	const lines = ['This app cannot move onto AWS Blocks as it is. Stop here: do not start the migration.', ''];
	for (const blocker of result.blockers)
		lines.push(`Blocker: ${blocker.reason}`, `What the user can do: ${blocker.fix}`, '');
	lines.push(
		'Removing a blocker is the decision of the user, and it is not part of the migration. Do not remove it yourself,',
		'also when you were told to work without asking: it changes the app beyond what a migration may change.',
		'Tell the user the blocker and what they can do about it, and end your work there.',
	);
	ctx.out.result(result, lines.join('\n'));
	return ExitCode.Failure;
}

/** `cdk-blocks blockify-app guide [name...]`: the named guides in full, or the list of guides. */
export async function blockifyGuide(ctx: Context, input: CommandInput): Promise<number> {
	const guides = listGuides();
	const names = input.positionals;
	if (names.length === 0) {
		const width = Math.max(...guides.map((guide) => guide.name.length)) + 2;
		const lines = guides.map((guide) => `${guide.name.padEnd(width)}${guide.title}. Read when ${guide.readWhen}`);
		ctx.out.result({ guides: guides.map((guide) => ({ ...guide, text: null })) }, lines.join('\n'));
		return ExitCode.Ok;
	}
	const pages = names.map((name) => {
		const text = readGuide(name);
		if (text === undefined) {
			const hint = suggest(
				name,
				guides.map((guide) => guide.name),
			);
			throw new UsageError(`no migration guide "${name}".${hint ? ` Did you mean "${hint}"?` : ''}`, {
				hint: `one of: ${guides.map((guide) => guide.name).join(', ')}`,
			});
		}
		return { ...(guides.find((guide) => guide.name === name) as (typeof guides)[number]), text };
	});
	ctx.out.result({ guides: pages }, pages.map((page) => page.text.trimEnd()).join('\n\n---\n\n'));
	return ExitCode.Ok;
}

/**
 * `cdk-blocks blockify-app check`: exit 1 when a check fails. With `--server`
 * it also starts the server function that `cdk synth` wrote.
 */
export async function blockifyCheck(ctx: Context, input: CommandInput): Promise<number> {
	const files = checkMigration(ctx.startDir);
	const withServer = input.flags.server === true;
	const checks = withServer ? [...files.checks, ...(await checkServerBundle(ctx.startDir))] : files.checks;
	const result = { ok: checks.every((check) => check.ok), checks };
	const lines = result.checks.flatMap((check) =>
		check.ok
			? [`ok    ${check.id}: ${check.message}`]
			: [`FAIL  ${check.id}: ${check.message}`, `      Fix: ${check.fix}`],
	);
	const failed = result.checks.filter((check) => !check.ok).length;
	lines.push(
		'',
		failed === 0
			? withServer
				? 'All checks passed. Apart from the server function, these checks read files only: run the local server and the build as the playbook says.'
				: 'All checks passed. These checks read files only: run the local server, the build and cdk synth as the playbook says.'
			: `${failed} check${failed === 1 ? '' : 's'} failed. Fix ${failed === 1 ? 'it' : 'them'} and run the command again.`,
	);
	ctx.out.result(result, lines.join('\n'));
	return result.ok ? ExitCode.Ok : ExitCode.Failure;
}

/** `cdk-blocks blockify-app skill <dir>`: copy the skill to `<dir>/migrate-to-aws-blocks`. */
export async function blockifySkill(ctx: Context, input: CommandInput): Promise<number> {
	const target = join(resolve(ctx.startDir, input.positionals[0]), SKILL_NAME);
	if (existsSync(target) && input.flags.force !== true) {
		throw new CliError(`${target} already exists.`, { hint: 'pass --force to replace its files' });
	}
	cpSync(SKILL_DIR, target, { recursive: true, force: true });
	const files = (readdirSync(target, { recursive: true, withFileTypes: true }) as Dirent[])
		.filter((entry) => entry.isFile())
		.map((entry) => relative(target, join(entry.parentPath, entry.name)).split('\\').join('/'))
		.sort();
	ctx.out.result(
		{ skill: SKILL_NAME, path: target, files },
		`Copied the ${SKILL_NAME} skill (${files.length} files) to ${target}`,
	);
	return ExitCode.Ok;
}
