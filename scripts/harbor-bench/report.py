"""Render advisory evidence without executing artifact contents or echoing arbitrary strings."""
import json
import os
from pathlib import Path
import re
import sys

ARMS = ('baseline', 'candidate')
PHASES = ('create', 'due-dates', 'labels')
FIELDS = ('input_tokens', 'cache_read_tokens', 'cache_write_tokens', 'output_tokens', 'cost_usd')


def load(path):
    try:
        return json.loads(path.read_text())
    except (OSError, json.JSONDecodeError):
        return None


def number(value, cost=False):
    if type(value) not in (int, float):
        return '—'
    return f'${value:.4f}' if cost else f'{value:,.0f}'


def sha(value):
    return value if re.fullmatch('[0-9a-f]{40}', value or '') else 'unavailable'


def render(root):
    arms = {arm: load(root / f'harbor-result-{arm}' / 'result.json') for arm in ARMS}
    url = os.environ.get('RUN_URL', '')
    if not re.fullmatch(r'https://github.com/xyos/aws-blocks/actions/runs/\d+', url):
        url = ''
    lines = ['## Harbor agent check — advisory', '',
             'One todo-app trajectory per arm; **n=1, not a statistical performance claim**.', '',
             f'- Baseline: `{sha(os.environ.get("BASELINE_SHA"))}` (merge-base with the fork PR base/default branch).',
             f'- Candidate: `{sha(os.environ.get("CANDIDATE_SHA"))}` (PR head, not GitHub’s synthetic merge).',
             '- Same pinned Harbor/Claude/skill/task, separate clean containers and registries; each arm resumes one session.',
             '- Local mock behavior only; no AWS application deployment or production correctness claim.',
             f'- [Workflow and downloadable evidence]({url})' if url else '- Local report (no workflow URL).', '']
    for arm, result in arms.items():
        if result:
            status = result.get('status')
            status = status if status in ('passed', 'failed', 'infrastructure_error') else 'unknown'
            exit_code = result.get('harbor_exit_code')
            exit_code = str(exit_code) if type(exit_code) is int else 'unavailable'
            continuity = 'verified' if result.get('same_session') is True else 'not verified'
            lines.append(f'- **{arm}: {status}**; Harbor exit: {exit_code}; session continuity: {continuity}.')
    lines.append('')
    def digests(result):
        return sorted((p['name'], p['integrity']) for p in result['packages'])
    if all(arms.values()):
        if digests(arms['baseline']) == digests(arms['candidate']):
            lines += ['**A/A infrastructure demonstration:** baseline and candidate packed package digests are identical. '
                      'Any observed token/time differences are agent variation, not evidence of a framework improvement.', '']
        else:
            lines += ['Packed package digests differ; this is a single descriptive baseline/candidate comparison.', '']
    lines += ['| Arm / phase | Outcome | Input (uncached) | Cache read | Cache write | Output | Turns | Tools | Agent seconds | CLI list-price estimate |',
              '|---|---|---:|---:|---:|---:|---:|---:|---:|---:|']
    totals = {}
    for arm in ARMS:
        result = arms[arm]
        if not result:
            lines.append(f'| {arm} | NO RESULT (setup, cancellation, or infrastructure failure) | — | — | — | — | — | — | — | — |')
            continue
        phases = {phase['name']: phase for phase in result.get('phases', [])}
        for name in PHASES:
            phase = phases.get(name, {})
            status = phase.get('status')
            status = status if status in ('passed', 'failed', 'not_run') else 'missing'
            usage = phase.get('usage') or {}
            duration = phase.get('duration_ms')
            cells = [f'{arm} / {name}', status]
            cells += [number(usage.get(field)) for field in FIELDS[:-1]]
            cells += [number(phase.get('turns')), number(phase.get('tool_calls')),
                      number(duration / 1000 if type(duration) in (int, float) else None), number(usage.get('cost_usd'), True)]
            lines.append('| ' + ' | '.join(cells) + ' |')
        totals[arm] = {}
        for field in FIELDS:
            values = [(phases.get(name, {}).get('usage') or {}).get(field) for name in PHASES]
            totals[arm][field] = sum(values) if all(type(v) in (int, float) for v in values) else None
    comparable = all(result and result.get('status') == 'passed' for result in arms.values())
    if not comparable:
        lines += ['Both arms must pass before efficiency deltas are reported. Available usage remains visible above.', '']
    lines += ['', '### Descriptive candidate − baseline totals', '', '| Metric | Baseline | Candidate | Difference |', '|---|---:|---:|---:|']
    for field in FIELDS:
        a, b = (totals.get(arm, {}).get(field) for arm in ARMS)
        cost = field == 'cost_usd'
        delta = b - a if comparable and a is not None and b is not None else None
        lines.append(f'| {field} | {number(a, cost)} | {number(b, cost)} | {number(delta, cost)} |')
    lines += ['', '### Interpretation and evidence', '',
              '- Success requires every phase’s build, packed-byte provenance, browser CRUD/regression suite, '
              'fresh-browser/server-restart persistence, and complete same-session accounting. Missing/failed phases are not passes.',
              '- Token/cache/cost totals are differences of cumulative `modelUsage`/`total_cost_usd` snapshots. '
              'Turns and tool calls are invocation-local, not differenced again. Missing or decreasing counters stay unavailable.',
              '- Cost is Claude Code’s list-price estimate, not an AWS billing measurement. There is no dollar cap. '
              'Each phase is bounded to 200 turns / 25 minutes; the whole Harbor process is bounded to 100 minutes.',
              '- Result artifacts contain phase metrics, consumed package hashes, and tool-name-only traces. '
              'Raw model text, shell commands, native sessions, generated app files, credentials, and AWS identities are not uploaded.',
              '- This workflow is non-required/advisory. A red job is preserved honestly; do not configure it as a branch-protection gate.', '']
    return '\n'.join(lines)


if __name__ == '__main__':
    Path(sys.argv[2]).write_text(render(Path(sys.argv[1])))
