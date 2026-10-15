"""Render advisory evidence without executing artifact contents or echoing arbitrary strings."""
import json
import os
from pathlib import Path
import re
import sys

ARMS = ('baseline', 'candidate')
PHASES = ('create', 'due-dates', 'labels')
FIELDS = ('input_tokens', 'cache_read_tokens', 'cache_write_tokens', 'output_tokens', 'cost_usd')
METRICS = (*FIELDS, 'turns', 'tool_calls', 'duration_ms')


def measurements(phase):
    return {**{key: (phase.get('usage') or {}).get(key) for key in FIELDS},
            **{key: phase.get(key) for key in METRICS if key not in FIELDS}}


def difference(a, b):
    if type(a) not in (int, float) or type(b) not in (int, float):
        return None, None
    return b - a, (100 * (b - a) / a if a else None)


def delta_text(a, b, cost=False):
    delta, percent = difference(a, b)
    if delta is None:
        return '—'
    absolute = f'{delta:+.4f}' if cost else f'{delta:+,.0f}'
    if cost:
        absolute = '$' + absolute
    return absolute + (f' ({percent:+.1f}%)' if percent is not None else ' (baseline zero)')


def eligible_pair(results, name):
    for result in results:
        if not result or result.get('harbor_exit_code') != 0 or result.get('same_session') is not True:
            return False
        phases = {phase['name']: phase for phase in result.get('phases', [])}
        for required in PHASES[:PHASES.index(name) + 1]:
            phase = phases.get(required, {})
            if phase.get('status') != 'passed' or phase.get('accounting_complete') is not True:
                return False
    return True


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
        for field in METRICS:
            values = [measurements(phases.get(name, {})).get(field) for name in PHASES]
            totals[arm][field] = sum(values) if all(type(v) in (int, float) for v in values) else None
    lines += ['', '### Measured candidate − baseline by phase', '',
              'Arithmetic differences remain visible when a phase fails. Only pairs with passing prerequisites, '
              'complete accounting and verified session continuity are eligible for an efficiency comparison.', '',
              '| Phase | Efficiency comparison | Uncached input Δ | Cache read Δ | Cache write Δ | Output Δ | Turns Δ | Tools Δ | Seconds Δ | Cost Δ |',
              '|---|---|---:|---:|---:|---:|---:|---:|---:|---:|']
    for name in PHASES:
        pair = [next((p for p in (arms[arm] or {}).get('phases', []) if p['name'] == name), {}) for arm in ARMS]
        values = [measurements(p) for p in pair]
        eligibility = 'eligible (n=1)' if eligible_pair(list(arms.values()), name) else 'not comparable for efficiency'
        cells = [name, eligibility]
        for field in (*FIELDS[:-1], 'turns', 'tool_calls', 'duration_ms', 'cost_usd'):
            a, b = (v.get(field) for v in values)
            if field == 'duration_ms':
                a, b = (v / 1000 if type(v) in (int, float) else None for v in (a, b))
            cells.append(delta_text(a, b, field == 'cost_usd'))
        lines.append('| ' + ' | '.join(cells) + ' |')
    comparable = all(result and result.get('status') == 'passed' for result in arms.values())
    lines += ['', '### Measured candidate − baseline totals', '',
              'All phases passed in both arms; descriptive comparison only.' if comparable else
              '**Not comparable for efficiency:** totals include failed or incomplete work. Lower usage is not an efficiency win.', '',
              '| Metric | Baseline | Candidate | Difference |', '|---|---:|---:|---:|']
    for field in METRICS:
        a, b = (totals.get(arm, {}).get(field) for arm in ARMS)
        cost = field == 'cost_usd'
        label = field
        if field == 'duration_ms':
            label = 'agent_seconds'
            a, b = (v / 1000 if type(v) in (int, float) else None for v in (a, b))
        lines.append(f'| {label} | {number(a, cost)} | {number(b, cost)} | {delta_text(a, b, cost)} |')
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
