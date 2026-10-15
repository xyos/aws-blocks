// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { chromium } from '/opt/verifier/node_modules/playwright/index.mjs';

const phase = Number(process.env.BENCH_PHASE);
const mode = process.argv[2];
const statePath = '/var/lib/harbor-verifier/state.json';
let state;
try { state = JSON.parse(await readFile(statePath, 'utf8')); }
catch (error) { if (error.code !== 'ENOENT') throw error; state = { items: [] }; }
const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
const context = await browser.newContext(); // Deliberately no storage state from previous passes.
const page = await context.newPage();
page.setDefaultTimeout(10000);
const row = (title) => page.getByTestId('todo-item').filter({ hasText: title });
async function saved(title) {
	await row(title).waitFor({ state: 'visible' });
	assert.equal(await row(title).count(), 1);
	return row(title);
}
async function mutate(action) {
	const [response] = await Promise.all([
		page.waitForResponse(response => response.request().method() === 'POST' && response.url().includes('/aws-blocks/')),
		action(),
	]);
	await response.finished();
	assert.ok(response.ok(), `backend mutation returned ${response.status()}`);
}
async function add(title) {
	await page.getByLabel('Todo title', { exact: true }).fill(title);
	await mutate(() => page.getByRole('button', { name: 'Add todo', exact: true }).click());
	return saved(title);
}
async function checkAll() {
	for (const expected of state.items) {
		const todo = await saved(expected.title);
		assert.equal(await todo.getByLabel('Completed', { exact: true }).isChecked(), expected.completed);
		if (phase >= 2) assert.equal(await todo.getByLabel('Due date', { exact: true }).inputValue(), expected.due ?? '');
		if (phase >= 3) {
			assert.deepEqual((await todo.getByTestId('todo-label').allTextContents()).map(s => s.trim()).sort(), expected.labels ?? []);
		}
	}
}
try {
	await page.goto('http://localhost:3000', { waitUntil: 'networkidle' });
	await page.getByRole('button', { name: 'Add todo', exact: true }).waitFor();
	if (mode === 'exercise') {
		assert.equal(state.items.length, phase - 1, 'prior phase verifier did not finish; do not silently skip survival');
		await checkAll();
		// Rerun the full previous UI contract on disposable data every phase.
		const title = `exercise-${randomUUID()}`;
		let todo = await add(title);
		await mutate(() => todo.getByLabel('Completed', { exact: true }).check());
		await page.reload({ waitUntil: 'networkidle' });
		todo = await saved(title);
		assert.equal(await todo.getByLabel('Completed', { exact: true }).isChecked(), true);
		await mutate(() => todo.getByLabel('Completed', { exact: true }).uncheck());
		await todo.getByLabel('Edit title', { exact: true }).fill(`${title}-edited`);
		await mutate(() => todo.getByRole('button', { name: 'Save todo', exact: true }).click());
		todo = await saved(`${title}-edited`);
		if (phase >= 2) {
			await todo.getByLabel('Due date', { exact: true }).fill('2031-04-05');
			await mutate(() => todo.getByRole('button', { name: 'Save todo', exact: true }).click());
			await page.reload({ waitUntil: 'networkidle' });
			todo = await saved(`${title}-edited`);
			assert.equal(await todo.getByLabel('Due date', { exact: true }).inputValue(), '2031-04-05');
			await todo.getByLabel('Due date', { exact: true }).fill('');
			await mutate(() => todo.getByRole('button', { name: 'Save todo', exact: true }).click());
		}
		if (phase >= 3) {
			await todo.getByLabel('Labels', { exact: true }).fill('work, urgent, work, , ');
			await mutate(() => todo.getByRole('button', { name: 'Save todo', exact: true }).click());
			await page.reload({ waitUntil: 'networkidle' });
			todo = await saved(`${title}-edited`);
			assert.deepEqual((await todo.getByTestId('todo-label').allTextContents()).map(s => s.trim()).sort(), ['urgent', 'work']);
			await todo.getByLabel('Labels', { exact: true }).fill('');
			await mutate(() => todo.getByRole('button', { name: 'Save todo', exact: true }).click());
		}
		await page.reload({ waitUntil: 'networkidle' });
		todo = await saved(`${title}-edited`);
		assert.equal(await todo.getByLabel('Completed', { exact: true }).isChecked(), false);
		if (phase >= 2) assert.equal(await todo.getByLabel('Due date', { exact: true }).inputValue(), '');
		if (phase >= 3) assert.equal(await todo.getByTestId('todo-label').count(), 0);
		await mutate(() => todo.getByRole('button', { name: 'Delete todo', exact: true }).click());
		await todo.waitFor({ state: 'detached' });
		await page.reload({ waitUntil: 'networkidle' });
		assert.equal(await row(`${title}-edited`).count(), 0);

		// Durable, unpredictable records are created only by the external verifier.
		const expected = { title: `survival-${randomUUID()}`, completed: true, due: '', labels: [] };
		todo = await add(expected.title);
		await mutate(() => todo.getByLabel('Completed', { exact: true }).check());
		if (phase >= 2) {
			expected.due = '2032-06-07';
			await todo.getByLabel('Due date', { exact: true }).fill(expected.due);
		}
		if (phase >= 3) {
			expected.labels = ['home', 'later'];
			await todo.getByLabel('Labels', { exact: true }).fill(expected.labels.join(', '));
		}
		if (phase >= 2) await mutate(() => todo.getByRole('button', { name: 'Save todo', exact: true }).click());
		state.items.push(expected);
		await writeFile(statePath, JSON.stringify(state));
	}
	await page.reload({ waitUntil: 'networkidle' });
	await checkAll();
	console.log(JSON.stringify({ phase, mode, persisted_items: state.items.length, status: 'passed' }));
} finally {
	await browser.close();
}
