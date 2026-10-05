"""Repeat frequencies. A frequency is a label (e.g. "Monthly", "weekly", "Every 3 weeks"): giving a task that label
sets how often it repeats, stored on the task as `interval` + `interval_unit` ('d' days, 'w' weeks, 'm' months).
parse_freq() mirrors parseFreq() in app.js. The strip helpers are only used by migration 0003 (history)."""

import re

from dateutil.relativedelta import relativedelta

UNITS = ('d', 'w', 'm')
UNIT_KW = {'d': 'days', 'w': 'weeks', 'm': 'months'}

FREQ_WORDS = {
    'daily': (1, 'd'),
    'every day': (1, 'd'),
    'weekly': (1, 'w'),
    'every week': (1, 'w'),
    'once a week': (1, 'w'),
    'biweekly': (2, 'w'),
    'bi-weekly': (2, 'w'),
    'fortnightly': (2, 'w'),
    'every other week': (2, 'w'),
    'monthly': (1, 'm'),
    'every month': (1, 'm'),
    'once a month': (1, 'm'),
    'bimonthly': (2, 'm'),
    'bi-monthly': (2, 'm'),
    'every other month': (2, 'm'),
    'quarterly': (3, 'm'),
    'twice a year': (6, 'm'),
    'semiannually': (6, 'm'),
    'semi-annually': (6, 'm'),
    'biannually': (6, 'm'),
    'annually': (12, 'm'),
    'yearly': (12, 'm'),
    'every year': (12, 'm'),
    'once a year': (12, 'm'),
}
FREQ_RE = re.compile(r'^(?:every\s+)?(\d+)(?:\s*-\s*(\d+))?\s*(day|week|month|year)s?$')

# Label used for an interval when a task has none (same names as FREQ in app.js)
MONTH_NAMES = {
    1: 'Monthly',
    3: 'Quarterly',
    6: 'Twice a year',
    12: 'Annually',
    24: 'Every 2 years',
    60: 'Every 5 years',
}


def parse_freq(text):
    """'Weekly' -> (1, 'w'), 'Every 2-5 years' -> (42, 'm') (ranges use the midpoint). None if it isn't a frequency."""
    t = ' '.join(str(text or '').lower().split())
    if t in FREQ_WORDS:
        return FREQ_WORDS[t]
    m = FREQ_RE.match(t)
    if not m:
        return None
    n = (int(m.group(1)) + int(m.group(2))) / 2 if m.group(2) else int(m.group(1))
    unit = m.group(3)
    n = round(n * 12) if unit == 'year' else round(n)
    return (n, unit[0] if unit in ('day', 'week') else 'm') if n > 0 else None


def freq_label(n, unit='m'):
    """A label name for an interval: 'Monthly', 'Weekly', 'Every 3 weeks', 'Every 4 years'…"""
    if unit == 'd':
        return 'Daily' if n == 1 else f'Every {n} days'
    if unit == 'w':
        return 'Weekly' if n == 1 else f'Every {n} weeks'
    return MONTH_NAMES.get(n) or (f'Every {n // 12} years' if n % 12 == 0 else f'Every {n} months')


def add_interval(d, n, unit='m'):
    return d + relativedelta(**{UNIT_KW.get(unit, 'months'): n})


# ---- history: migration 0003 removed frequency labels (undone by 0004) ----
OLD_FREQ_NAMES = {'one-off', 'monthly', 'quarterly', 'twice a year', 'annually', 'every 2 years', 'every 5 years'}
OLD_FREQ_RE = re.compile(r'^(every\s+)?\d+(\s*-\s*\d+)?\s*(months?|years?)$', re.I)


def is_repeat_label(tag, custom=()):
    t = ' '.join(str(tag).split())
    return t.lower() in OLD_FREQ_NAMES or t in custom or bool(OLD_FREQ_RE.match(t))


def strip_repeat_tags(tags, custom=()):
    return ','.join(g for g in str(tags or '').split(',') if g and not is_repeat_label(g, custom))


def clean_settings(s):
    custom = (
        set((s.pop('freqs', None) or {}).keys())
        if isinstance(s.get('freqs'), dict)
        else set(s.pop('freqs', None) or ())
    )
    if isinstance(s.get('labels'), list):
        s['labels'] = [g for g in s['labels'] if not (isinstance(g, str) and is_repeat_label(g, custom))]
    if isinstance(s.get('colors'), dict):
        s['colors'] = {g: c for g, c in s['colors'].items() if not is_repeat_label(g, custom)}
    return custom
