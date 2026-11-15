// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * `cdk-blocks blockify-app check --server`: start the server function that
 * `cdk synth` wrote for `Hosting` the way AWS Lambda would, without AWS.
 *
 * A server-rendered app can pass the build, synth and the local server, deploy
 * without an error, and answer 502 on every path. Two causes are visible in
 * the synthesized function alone:
 * - the server exits at start because the directory that the deploy uploads
 *   lacks a package it imports: found by starting it from a read-only copy
 *   away from the app's `node_modules`;
 * - the handler returns a buffered response and the integration invokes it
 *   with response streaming, or the reverse: found by loading the handler and
 *   comparing it with the integration in the template.
 *
 * The check runs no Lambda runtime, no Lambda Web Adapter and no API Gateway,
 * so a fault that needs one of them passes it.
 */

import { spawn } from 'node:child_process';
import { chmodSync, cpSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { Check } from './blockify-check.js';

const ID = 'server-bundle';

/**
 * The server functions of `Hosting`, by the construct path that the template
 * records: `Hosting` creates them as `Compute-<name>/Function`
 * (`@aws-blocks/hosting`, `src/constructs/hosting_construct.ts` and
 * `compute_construct.ts`; a test reads both). `default` renders the pages, and
 * a framework with more than one function names that one `server`.
 */
export const SERVER_FUNCTION_PATH = /\/Compute-(?:default|server)\/Function\/Resource$/;

/** How long a server may take to answer its first request, and a handler to load and answer. */
const START_TIMEOUT_MS = 20_000;
const HANDLER_TIMEOUT_MS = 90_000;

interface TemplateResource {
	Type?: string;
	Properties?: Record<string, unknown>;
	Metadata?: Record<string, unknown>;
}

interface ServerFunction {
	id: string;
	handler: string;
	/** The directory in `cdk.out` that the deploy uploads as the function's code. */
	asset: string;
	variables: Record<string, unknown>;
	/** How the door invokes the function; `undefined` when nothing in the template invokes it. */
	streamed: boolean | undefined;
}

type Found =
	| { functions: ServerFunction[] }
	/** Why nothing could be checked. */
	| { problem: string; fix: string };

/** The server functions in the templates under `out`, each with how the template invokes it. */
function findServerFunctions(out: string): Found {
	let names: string[];
	try {
		names = readdirSync(out).filter((name) => name.endsWith('.template.json'));
	} catch {
		names = [];
	}
	if (names.length === 0) {
		return {
			problem: 'cdk.out holds no template',
			fix: 'run the synth step of the validate task first (npx --no -- cdk synth -q), then this command again',
		};
	}
	const functions: ServerFunction[] = [];
	for (const name of names) {
		let resources: Record<string, TemplateResource>;
		try {
			resources = JSON.parse(readFileSync(join(out, name), 'utf-8')).Resources ?? {};
		} catch {
			continue;
		}
		for (const [id, resource] of Object.entries(resources)) {
			const path = resource.Metadata?.['aws:cdk:path'];
			if (
				resource.Type !== 'AWS::Lambda::Function' ||
				typeof path !== 'string' ||
				!SERVER_FUNCTION_PATH.test(path)
			)
				continue;
			const properties = resource.Properties ?? {};
			const key = (properties.Code as { S3Key?: unknown } | undefined)?.S3Key;
			const asset = join(out, `asset.${String(key ?? '').split('.')[0]}`);
			if (statSync(asset, { throwIfNoEntry: false })?.isDirectory() !== true) {
				return {
					problem: `the code of ${id} is not a directory in cdk.out`,
					fix: 'run the synth step of the validate task again (npx --no -- cdk synth -q): it writes the directory that the deploy uploads',
				};
			}
			// Every resource that names the function says how it is invoked: an API Gateway method, an HTTP API integration, a function URL.
			const callers = Object.values(resources)
				.filter((other) => other !== resource && JSON.stringify(other.Properties ?? {}).includes(`"${id}"`))
				.map((other) => JSON.stringify(other));
			const invoked = callers.filter((text) =>
				/"AWS::ApiGateway::Method"|"AWS::ApiGatewayV2::Integration"|"AWS::Lambda::Url"/.test(text),
			);
			functions.push({
				id,
				handler: String(properties.Handler ?? ''),
				asset,
				variables:
					(properties.Environment as { Variables?: Record<string, unknown> } | undefined)?.Variables ?? {},
				streamed:
					invoked.length === 0
						? undefined
						: invoked.some((text) =>
								/"ResponseTransferMode":"STREAM"|response-streaming-invocations|"InvokeMode":"RESPONSE_STREAM"/.test(
									text,
								),
							),
			});
		}
	}
	return { functions };
}

/** Set the mode of every directory under `dir`, and of `dir`. */
function lock(dir: string, mode: number): void {
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		if (entry.isDirectory()) lock(join(dir, entry.name), mode);
	}
	chmodSync(dir, mode);
}

/** A port that nothing listens on now. */
function freePort(): Promise<number> {
	return new Promise((done, failed) => {
		const server = createServer();
		server.on('error', failed);
		server.listen(0, '127.0.0.1', () => {
			const address = server.address();
			server.close(() => done(typeof address === 'object' && address !== null ? address.port : 0));
		});
	});
}

/** The status of `GET /` on `port`, or `null` when nothing answers. */
function requestRoot(port: number): Promise<number | null> {
	return new Promise((done) => {
		const request = http.get({ host: '127.0.0.1', port, path: '/', timeout: 5000 }, (response) => {
			response.resume();
			done(response.statusCode ?? null);
		});
		request.on('timeout', () => request.destroy());
		request.on('error', () => done(null));
	});
}

/** The first line of `log` that names an error, or its end. */
function errorIn(log: string): string {
	return (/Error[^\n]*/.exec(log)?.[0] ?? log.trim().slice(-200)).slice(0, 240);
}

const BUNDLE_FIX =
	'the directory that the deploy uploads must hold everything the server imports: bundle the packages into the ' +
	'server build (for Astro with its own adapter, vite.ssr.noExternal for the build alone; guide "nextjs" and the ' +
	'Hosting task of the playbook name the setting for each framework), then build and synth again';

/** A function that the Lambda Web Adapter runs as a program: start it and ask for a page. */
async function startServer(fn: ServerFunction, task: string, env: NodeJS.ProcessEnv): Promise<Check> {
	if (process.platform === 'win32') {
		return {
			id: ID,
			ok: false,
			message: `${fn.id} was not started: its handler is a shell script (${fn.handler}), which this check cannot run on Windows`,
			fix: 'run the command on macOS, Linux or WSL',
		};
	}
	const port = await freePort();
	let log = '';
	const server = spawn('sh', [fn.handler], { cwd: task, env: { ...env, PORT: String(port) }, detached: true });
	server.stdout.on('data', (chunk) => (log += chunk));
	server.stderr.on('data', (chunk) => (log += chunk));
	let exited: number | string | null = null;
	server.on('error', (error) => {
		log += String(error);
		exited = 'not started';
	});
	server.on('exit', (code) => (exited = code ?? 'killed'));
	let status: number | null = null;
	const deadline = Date.now() + START_TIMEOUT_MS;
	while (exited === null && status === null && Date.now() < deadline) {
		await new Promise((wait) => setTimeout(wait, 250));
		status = await requestRoot(port);
	}
	if (exited === null && server.pid !== undefined) {
		try {
			process.kill(-server.pid, 'SIGTERM');
		} catch {
			// It exited between the check and the signal.
		}
	}
	if (status !== null) {
		return {
			id: ID,
			ok: true,
			message: `${fn.id} starts from the uploaded files alone and answers GET / with ${status}`,
			fix: null,
		};
	}
	if (exited !== null) {
		return {
			id: ID,
			ok: false,
			message: `${fn.id} exits at start (code ${exited}) when it runs from the uploaded files alone: ${errorIn(log)}`,
			fix: BUNDLE_FIX,
		};
	}
	return {
		id: ID,
		ok: false,
		message: `${fn.id} started and answered no request on its PORT in ${START_TIMEOUT_MS / 1000} s`,
		fix: 'the server must listen on the port in the PORT variable; read what it prints when you start it as the handler script does',
	};
}

/** The program that loads a native handler with the globals the Lambda runtime gives a streaming handler, and calls it once. */
function driverSource(moduleFile: string, exported: string): string {
	return `import { Writable } from 'node:stream';
const STREAMING = Symbol.for('aws.lambda.runtime.handler.streaming');
globalThis.awslambda = {
	streamifyResponse: (handler) => Object.assign(handler, { [STREAMING]: 'response' }),
	HttpResponseStream: { from: (stream, prelude) => Object.assign(stream, { prelude }) },
};
const result = { loads: false, streams: null, status: null };
try {
	const loaded = await import(${JSON.stringify(moduleFile)});
	const handler = loaded[${JSON.stringify(exported)}] ?? loaded.default?.[${JSON.stringify(exported)}];
	result.loads = typeof handler === 'function';
	result.streams = result.loads && handler[STREAMING] !== undefined;
	if (result.loads) {
		const event = {
			resource: '/{proxy+}', path: '/', httpMethod: 'GET', headers: { Host: 'check.invalid', accept: 'text/html' },
			multiValueHeaders: { Host: ['check.invalid'], accept: ['text/html'] }, queryStringParameters: null,
			multiValueQueryStringParameters: null, pathParameters: { proxy: '' }, stageVariables: null, body: null,
			isBase64Encoded: false,
			requestContext: { resourcePath: '/{proxy+}', httpMethod: 'GET', path: '/prod/', stage: 'prod', identity: { sourceIp: '192.0.2.1' }, requestId: 'check', protocol: 'HTTP/1.1' },
		};
		const context = { awsRequestId: 'check', getRemainingTimeInMillis: () => 20000 };
		const late = new Promise((_, no) => setTimeout(() => no(new Error('no answer in 20 s')), 20000));
		try {
			if (result.streams) {
				const stream = new Writable({ write: (_chunk, _encoding, next) => next() });
				await Promise.race([handler(event, stream, context), late]);
				result.status = stream.prelude?.statusCode ?? null;
			} else {
				result.status = (await Promise.race([handler(event, context), late]))?.statusCode ?? null;
			}
		} catch (error) {
			result.requestError = String(error?.message ?? error).slice(0, 200);
		}
	}
} catch (error) {
	result.error = String(error?.message ?? error).slice(0, 240);
}
console.log('\\nBLOCKIFY_SERVER_CHECK ' + JSON.stringify(result));
process.exit(0);
`;
}

/** A handler that the Lambda runtime calls itself: load it and compare it with how the template invokes it. */
function loadHandler(fn: ServerFunction, task: string, work: string, env: NodeJS.ProcessEnv): Promise<Check> {
	const [file, exported] = fn.handler.split('.');
	const moduleFile = ['mjs', 'js', 'cjs']
		.map((extension) => join(task, `${file}.${extension}`))
		.find((path) => statSync(path, { throwIfNoEntry: false })?.isFile() === true);
	if (moduleFile === undefined) {
		return Promise.resolve({
			id: ID,
			ok: false,
			message: `${fn.id} names the handler ${fn.handler}, and the uploaded directory has no ${file}.mjs, ${file}.js or ${file}.cjs`,
			fix: 'build and synth again; when the file is still missing, the Hosting buildOutputDir does not point at the server build',
		});
	}
	const driver = join(work, 'driver.mjs');
	writeFileSync(driver, driverSource(moduleFile, exported));
	return new Promise((done) => {
		let printed = '';
		const child = spawn(process.execPath, [driver], { cwd: task, env });
		child.stdout.on('data', (chunk) => (printed += chunk));
		child.stderr.on('data', (chunk) => (printed += chunk));
		const stop = setTimeout(() => child.kill('SIGKILL'), HANDLER_TIMEOUT_MS);
		child.on('exit', () => {
			clearTimeout(stop);
			const line = /BLOCKIFY_SERVER_CHECK (\{.*\})/.exec(printed)?.[1];
			const result = line === undefined ? undefined : (JSON.parse(line) as Record<string, unknown>);
			if (result === undefined || result.loads !== true) {
				done({
					id: ID,
					ok: false,
					message: `${fn.id} does not load from the uploaded files alone: ${
						result === undefined ? errorIn(printed) : (result.error ?? `it has no export "${exported}"`)
					}`,
					fix: BUNDLE_FIX,
				});
				return;
			}
			if (fn.streamed !== undefined && result.streams !== fn.streamed) {
				done(
					fn.streamed
						? {
								id: ID,
								ok: false,
								message: `${fn.id} returns a buffered response, and the template invokes it with response streaming: the deploy succeeds and every page answers 502`,
								fix: 'make the handler stream its response: for Nuxt and other Nitro apps, nitro: { awsLambda: { streaming: true } } in nuxt.config.ts (awsLambda: { streaming: true } in nitro.config.ts); then build and synth again',
							}
						: {
								id: ID,
								ok: false,
								message: `${fn.id} streams its response, and the template invokes it without streaming`,
								fix: 'synthesize as the deploy does (the validate task of the playbook names the command), or turn response streaming off in the framework config for a door that cannot stream',
							},
				);
				return;
			}
			done({
				id: ID,
				ok: true,
				message: `${fn.id} loads from the uploaded files alone${
					fn.streamed === undefined
						? ''
						: ` and ${fn.streamed ? 'streams' : 'buffers'} its response, as the template invokes it`
				}`,
				fix: null,
			});
		});
	});
}

/** Run one function from a read-only copy of what the deploy uploads, with the function's own variables. */
async function checkFunction(fn: ServerFunction): Promise<Check> {
	const work = mkdtempSync(join(tmpdir(), 'blockify-server-'));
	const task = join(work, 'var-task');
	try {
		// Lambda unpacks the code into a directory that the function cannot write to, away from the app's node_modules.
		cpSync(fn.asset, task, { recursive: true, verbatimSymlinks: true });
		lock(task, 0o555);
		const env: NodeJS.ProcessEnv = {
			PATH: `${dirname(process.execPath)}${process.platform === 'win32' ? ';' : ':'}${process.env.PATH ?? ''}`,
			HOME: join(work, 'home'),
			TMPDIR: work,
		};
		for (const [name, value] of Object.entries(fn.variables)) {
			if (name === 'AWS_LAMBDA_EXEC_WRAPPER') continue;
			// A value that CloudFormation fills in at deploy time gets a placeholder.
			env[name] =
				typeof value === 'string'
					? value.replaceAll('/var/task', task)
					: 'https://check.invalid/aws-blocks/api';
		}
		return fn.variables.AWS_LAMBDA_EXEC_WRAPPER !== undefined
			? await startServer(fn, task, env)
			: await loadHandler(fn, task, work, env);
	} finally {
		try {
			lock(task, 0o755);
		} catch {
			// The copy failed before the directory existed.
		}
		rmSync(work, { recursive: true, force: true });
	}
}

/**
 * Check every server function that `cdk synth` wrote for the app at `root`.
 * An app that `Hosting` serves as files has none, and passes.
 */
export async function checkServerBundle(root: string): Promise<Check[]> {
	const found = findServerFunctions(join(root, 'cdk.out'));
	if ('problem' in found) return [{ id: ID, ok: false, message: found.problem, fix: found.fix }];
	if (found.functions.length === 0) {
		return [
			{
				id: ID,
				ok: true,
				message:
					'the template has no Hosting server function on AWS Lambda, so there is nothing to start (an app served as files has none; a server on a Lambda Web Function is not checked)',
				fix: null,
			},
		];
	}
	const checks: Check[] = [];
	for (const fn of found.functions) checks.push(await checkFunction(fn));
	return checks;
}
