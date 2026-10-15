"""Public diagnostics use verifier-owned identifiers, never arbitrary runtime text."""
import json
from pathlib import Path

CHECKS = json.loads((Path(__file__).parent / 'task/tests/checks.json').read_text())
STAGES = {'package_provenance', 'build', 'server_start', 'ui_exercise', 'server_restart', 'ui_survival'}
KINDS = {'timeout', 'assertion', 'runtime'}


def count(value):
    return value if type(value) is int and 0 <= value <= 1000000 else None


def public_diagnostics(verification, ui_results):
    result = {'failure': None, 'checks_passed': 0, 'browser_errors': 0, 'http_errors': 0}
    failure = verification.get('failure') or {}
    if failure:
        result['failure'] = {
            'stage': failure.get('stage') if failure.get('stage') in STAGES else 'unknown',
            'check': None,
            'kind': failure.get('kind') if failure.get('kind') in KINDS else 'runtime',
        }
    for mode, data in ui_results.items():
        if mode not in ('exercise', 'survival') or not isinstance(data, dict):
            continue
        result['checks_passed'] += len({x for x in data.get('checks', []) if isinstance(x, str) and x in CHECKS})
        for key in ('browser_errors', 'http_errors'):
            value = count(data.get(key))
            if value is not None:
                result[key] += value
        if data.get('status') == 'failed':
            detail = data.get('failure') or {}
            result['failure'] = {
                'stage': 'ui_' + mode,
                'check': detail.get('check') if detail.get('check') in CHECKS else 'unknown',
                'kind': detail.get('kind') if detail.get('kind') in KINDS else 'runtime',
            }
    if not ui_results:
        for key in ('checks_passed', 'browser_errors', 'http_errors'):
            result[key] = None
    return result
