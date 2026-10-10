"""How a pile of ToDo tasks ranks. app.js mirrors this as LEVELS / tierOf(); keep them in sync.

    0      Perfect     green        nothing to do: the goal
    1-3    Thriving    green        well on top of it
    4-6    Livable     light green  fine for now
    7-10   Neutral     yellow       starting to pile up
    11-20  Slacking    orange       falling behind
    21+    Neglected   red          needs attention

The count is the number of ToDo (backlog) tasks due within `showDays` (settings, default 7; overdue included),
the same number the Home map shows. Tasks due later aren't counted until they come up.
"""

from datetime import date, timedelta

from .models import Task
from .rooms import OUTSIDE, all_rooms, canonical_room, current_map, room_for_project, yard_areas

# (key, name, mood, min, max); max None = no upper limit
TIERS = [
    ('perfect', 'Perfect', 'Nothing to do: the goal', 0, 0),
    ('thriving', 'Thriving', 'Well on top of it', 1, 3),
    ('livable', 'Livable', 'Fine for now', 4, 6),
    ('neutral', 'Neutral', 'Starting to pile up', 7, 10),
    ('slacking', 'Slacking', 'Falling behind', 11, 20),
    ('neglected', 'Neglected', 'Needs attention', 21, None),
]


def tier(n):
    """The tier dict for n ToDo tasks."""
    n = max(0, int(n))
    for key, name, mood, lo, hi in TIERS:
        if n >= lo and (hi is None or n <= hi):
            return {'tier': key, 'rank': name, 'mood': mood}
    raise ValueError(n)  # unreachable: the last tier has no upper limit


def show_days(settings):
    """How many days ahead the Board and Home look for ToDo tasks (Settings > Miscellaneous; app.js showDays)."""
    try:
        return min(365, max(0, int(settings.get('showDays', 7))))
    except (TypeError, ValueError):
        return 7


def _ranked(counts, n_key='todo'):
    return {**counts, **tier(counts[n_key])}


def ranking(settings):
    """Every room, floor and project, plus the whole home, with ToDo/doing/overdue counts and a tier."""
    rooms = all_rooms(settings)
    ids = {rid for rid, _, _ in rooms}
    areas = yard_areas(settings)
    m = current_map(settings)
    floor_of = {str(r['id']): str(r.get('floor') or '') for r in m['rooms'] if isinstance(r, dict) and r.get('id')}
    # the yard counts toward Outside (or the ground floor on maps without it), as on the Home map's floor tabs
    floor_ids = [f.get('id') for f in m['floors'] if isinstance(f, dict)]
    floor_of['yard'] = OUTSIDE if OUTSIDE in floor_ids else str(m.get('ground') or '')
    blank = lambda: {'todo': 0, 'doing': 0, 'overdue': 0}
    by_room = {rid: blank() for rid in ids}
    by_project, proj_room, today = {}, {}, date.today()
    horizon = today + timedelta(days=show_days(settings))
    open_tasks = Task.objects.exclude(status='done').exclude(status='backlog', due__gt=horizon)
    for t in open_tasks.values('project', 'status', 'due', 'room'):
        p = t['project']
        if p not in proj_room:
            proj_room[p] = room_for_project(p, settings, rooms)
        r = canonical_room(t['room'], areas)
        r = r if r in ids else proj_room[p]
        for c in (by_room[r], by_project.setdefault(p, blank())):
            c['todo' if t['status'] == 'backlog' else 'doing'] += 1
            c['overdue'] += bool(t['due'] and t['due'] < today)

    room_rows = [
        _ranked({'id': rid, 'name': name, 'emoji': emoji, 'floor': floor_of.get(rid, ''), **by_room[rid]})
        for rid, name, emoji in rooms
    ]
    room_rows.sort(key=lambda r: (-r['todo'], -r['overdue'], r['name'].lower()))
    floors = []
    for f in m['floors']:
        if isinstance(f, dict) and f.get('id'):
            here = [r for r in room_rows if r['floor'] == f['id']]
            floors.append(
                _ranked(
                    {
                        'id': f['id'],
                        'name': f.get('name', ''),
                        'rooms': len(here),
                        **{k: sum(r[k] for r in here) for k in ('todo', 'doing', 'overdue')},
                    }
                )
            )
    projects = sorted(
        (_ranked({'name': p, 'room': proj_room[p], **c}) for p, c in by_project.items()),
        key=lambda r: (-r['todo'], r['name'].lower()),
    )
    home = _ranked({k: sum(r[k] for r in room_rows) for k in ('todo', 'doing', 'overdue')})
    return {
        'counts': 'todo',
        'tiers': [{'tier': k, 'rank': n, 'mood': mood, 'min': lo, 'max': hi} for k, n, mood, lo, hi in TIERS],
        'home': home,
        'summary': {k: sum(r['tier'] == k for r in room_rows) for k, *_ in TIERS},
        'rooms': room_rows,
        'floors': floors,
        'projects': projects,
    }
