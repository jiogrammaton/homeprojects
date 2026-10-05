"""Page views and the JSON API.

Every app page renders the same shell (base.html); app.js then fetches /api/tasks and /api/settings and draws the
page in the browser. Everything here needs a signed-in user (security.LoginRequiredMiddleware) and every write needs
the CSRF token (app.js sends it as X-CSRFToken).

Sections:
    Pages · Settings blob · Tasks · Projects · Settings · History & reset · Backup & restore · Ranking ·
    CSV import · Recurring tasks
"""

import csv
import io
import json
import logging
from datetime import date, datetime, timedelta

from django.core.cache import cache
from django.db import transaction
from django.db.models import Q
from django.http import Http404, HttpResponse, HttpResponseBadRequest, JsonResponse
from django.shortcuts import render
from django.views.decorators.http import require_GET, require_http_methods, require_POST

from .models import KeyValueStore, Task
from .ranking import ranking as rank_all
from .repeat import UNITS, add_interval, freq_label, parse_freq
from .rooms import DEFAULT_MAP, all_rooms, match_room
from .security import client_ip, who

audit = logging.getLogger('web.audit')

# Each section is its own page; they share base.html, app.js and style.css
PAGES = {
    'home': 'home.html',
    'board': 'board.html',
    'cal': 'calendar.html',
    'stats': 'stats.html',
    'settings': 'settings.html',
}
SETTINGS_TABS = ('projects', 'tasks', 'labels', 'misc')  # left-to-right order; /settings/ opens the first
OLD_TAB_NAMES = {'sched': 'tasks'}  # old links keep working

# Settings keys that hold per-project entries (moved on rename, dropped on delete and reset)
PROJECT_DICTS = ('projects', 'pcolors', 'rooms')
PROJECT_LISTS = ('projectNames', 'porder')

# Task fields sent to the browser, and the ones kept in a backup (everything but the id)
TASK_FIELDS = (
    'id',
    'project',
    'title',
    'status',
    'tags',
    'notes',
    'url',
    'due',
    'interval',
    'interval_unit',
    'priority',
    'done_at',
    'room',
    'spawned',
)
BACKUP_FIELDS = (
    'project',
    'title',
    'status',
    'tags',
    'notes',
    'url',
    'due',
    'interval',
    'interval_unit',
    'priority',
    'done_at',
    'spawned',
    'room',
)


def _json_body(request):
    """The request body as a dict, or None if it isn't a JSON object."""
    try:
        data = json.loads(request.body or b'{}')
    except (json.JSONDecodeError, UnicodeDecodeError):
        return None
    return data if isinstance(data, dict) else None


def _clean(text):
    """Collapse runs of whitespace and trim (titles and project names)."""
    return ' '.join(str(text or '').split())


def _iso(d):
    return d.isoformat() if d else None


# ---- Pages ----------------------------------------------------------------------------------------------------------


def page_view(request, page='board', tab=SETTINGS_TABS[0]):
    tab = OLD_TAB_NAMES.get(tab, tab)
    if page not in PAGES or tab not in SETTINGS_TABS:
        raise Http404
    return render(request, PAGES[page], {'view': page, 'tab': tab, 'default_map': DEFAULT_MAP})


# ---- Settings blob --------------------------------------------------------------------------------------------------
# One JSON object owned by the client (KeyValueStore row 'settings'); see web/CLAUDE.md for its keys.


def stored_settings():
    kv = KeyValueStore.objects.filter(pk='settings').first()
    try:
        return json.loads(kv.v) if kv else {}
    except json.JSONDecodeError:
        return {}


def _locked_settings():
    """(row, settings dict) with the row locked; call inside transaction.atomic(). Row is None if never saved."""
    kv = KeyValueStore.objects.select_for_update().filter(pk='settings').first()
    return kv, (json.loads(kv.v or '{}') if kv else {})


def _save_settings(kv, st):
    if kv:
        kv.v = json.dumps(st)
        kv.save()


# ---- Tasks ----------------------------------------------------------------------------------------------------------


@require_GET
def list_tasks(request):
    spawn_recurring()  # due occurrences appear on page load, not only after the next save
    out = []
    for t in Task.objects.order_by('due').values(*TASK_FIELDS):
        t['due'], t['done_at'] = _iso(t['due']), _iso(t['done_at'])
        out.append(t)
    return JsonResponse(out, safe=False)


def open_duplicate(project, title, exclude_pk=None):
    """An open (not done) task with the same project and title, ignoring case. Done copies are history."""
    qs = Task.objects.filter(project__iexact=project, title__iexact=title).exclude(status='done')
    if exclude_pk:
        qs = qs.exclude(pk=exclude_pk)
    return qs.first()


def canonical_project(name):
    """Reuse the existing spelling of a project name so 'kitchen' and 'Kitchen' don't become two projects."""
    return Task.objects.filter(project__iexact=name).values_list('project', flat=True).first() or name


def duplicate_response(project, title):
    return JsonResponse({"error": f"“{title}” is already an open task in {project}."}, status=409)


def _task_fields(data):
    """Validated model fields from a task form, or raise ValueError with a message for the 400 response."""
    title = _clean(data.get('title'))
    if not title:
        raise ValueError("Title required")
    try:
        unit = str(data.get('interval_unit') or 'm')
        if unit not in UNITS:
            raise ValueError(unit)
        due_str = data.get('due')
        fields = {
            'interval': max(0, int(data.get('interval', 0))),
            'interval_unit': unit,
            'priority': min(4, max(1, int(data.get('priority', 3)))),
            'due': datetime.strptime(due_str, '%Y-%m-%d').date() if due_str else date.today(),
        }
    except (TypeError, ValueError):
        raise ValueError("Bad interval, priority or due date") from None
    fields.update(
        title=title,
        project=canonical_project(_clean(data.get('project')) or 'General'),
        status=data.get('status', 'backlog'),
        tags=data.get('tags', ''),
        notes=data.get('notes', ''),
        url=data.get('url', ''),
        room=match_room(data.get('room', '')) or '',  # '' = same room as the project
    )
    return fields


@require_http_methods(['POST', 'PUT'])
def save_task(request, task_id=None):
    """POST /api/tasks/new creates a task; PUT /api/tasks/<id> replaces one. 409 if it would duplicate an open task."""
    data = _json_body(request)
    if data is None:
        return HttpResponseBadRequest("Bad JSON")
    try:
        f = _task_fields(data)
    except ValueError as e:
        return HttpResponseBadRequest(str(e))

    if task_id:
        t = Task.objects.filter(pk=task_id).first()
        if not t:
            return HttpResponseBadRequest("Task not found")
        # Only a rename or a move can create a duplicate; status changes (e.g. reopening history) are left alone
        renamed = t.title.lower() != f['title'].lower() or t.project.lower() != f['project'].lower()
        if renamed and open_duplicate(f['project'], f['title'], exclude_pk=t.pk):
            return duplicate_response(f['project'], f['title'])
        for name, value in f.items():
            setattr(t, name, value)
        if t.status == 'done':
            t.done_at = t.done_at or date.today()
        else:
            # Reopened: drop the next occurrence it already spawned (if untouched), so completing it again
            # doesn't leave two copies on the board
            if not (t.done_at and t.spawned) or remove_successor(t):
                t.spawned = 0
            t.done_at = None
        t.save()
    else:
        # A phone on a slow link may send the same save twice (a retry, or taps that queued up). The form sends one
        # save_key per new task: a repeat of a key that already made it isn't an error.
        key = data.get('save_key')
        seen = (
            isinstance(key, str) and 0 < len(key) <= 64 and not cache.add(f'save-key:{request.user.pk}:{key}', 1, 600)
        )
        if open_duplicate(f['project'], f['title']):
            if seen:
                return JsonResponse({"status": "ok", "repeat": True})
            return duplicate_response(f['project'], f['title'])
        Task.objects.create(**f, done_at=date.today() if f['status'] == 'done' else None)

    spawn_recurring()
    return JsonResponse({"status": "ok"})


@require_http_methods(['DELETE'])
def delete_task(request, task_id):
    Task.objects.filter(pk=task_id).delete()
    return JsonResponse({"status": "ok"})


# ---- Projects -------------------------------------------------------------------------------------------------------
# Projects have no table: a project is the `project` text on its tasks plus its entries in the settings blob.


@require_http_methods(['DELETE'])
def delete_project(request):
    """Delete a project's tasks and its settings entries, together or not at all."""
    data = _json_body(request)
    if data is None:
        return HttpResponseBadRequest("Bad JSON")
    name = data.get('project', '')
    if not name:
        return HttpResponseBadRequest("Project required")
    with transaction.atomic():
        n, _ = Task.objects.filter(project=name).delete()
        kv, st = _locked_settings()
        for key in PROJECT_DICTS:
            (st.get(key) or {}).pop(name, None)
        for key in PROJECT_LISTS:
            if key in st:
                st[key] = [p for p in st.get(key) or [] if p != name]
        _save_settings(kv, st)
    audit.info('%s deleted project %r and its %d tasks', who(request), name, n)
    return JsonResponse({"status": "ok", "deleted": n})


@require_POST
def rename_project(request):
    """Settings > Projects: rename a project everywhere: its tasks and its settings (priority, color, room, order)."""
    data = _json_body(request)
    if data is None:
        return HttpResponseBadRequest("Bad JSON")
    old, new = _clean(data.get('old')), _clean(data.get('new'))
    if not old or not new:
        return HttpResponseBadRequest("Both names are required")
    if old == new:
        return JsonResponse({"status": "ok", "renamed": 0})

    with transaction.atomic():
        kv, st = _locked_settings()
        taken = {p.lower() for p in Task.objects.values_list('project', flat=True).distinct()}
        taken |= {p.lower() for p in st.get('projectNames') or []}
        if new.lower() != old.lower() and new.lower() in taken:  # changing only the capitals is fine
            return JsonResponse({"error": f"“{new}” is already a project. Pick a different name."}, status=409)
        n = Task.objects.filter(project=old).update(project=new)
        for key in PROJECT_DICTS:
            d = st.get(key) or {}
            if old in d:
                d[new] = d.pop(old)
        for key in PROJECT_LISTS:
            if key in st:
                st[key] = [new if p == old else p for p in st.get(key) or []]
        _save_settings(kv, st)
    audit.info('%s renamed project %r to %r (%d tasks)', who(request), old, new, n)
    return JsonResponse({"status": "ok", "renamed": n})


# ---- Settings -------------------------------------------------------------------------------------------------------


@require_GET
def get_settings(request):
    kv = KeyValueStore.objects.filter(pk='settings').first()
    if kv:
        return HttpResponse(kv.v, content_type="application/json")
    old = KeyValueStore.objects.filter(pk='colors').first()  # very old installs kept only label colors
    return HttpResponse(f'{{"colors":{old.v}}}' if old else '{}', content_type="application/json")


@require_http_methods(['PUT'])
def put_settings(request):
    """Replace the whole settings blob (the client owns its contents; it only has to be a JSON object)."""
    try:
        data = json.loads(request.body)
    except json.JSONDecodeError:
        return HttpResponseBadRequest("Bad JSON")
    if not isinstance(data, dict):
        return HttpResponseBadRequest("Settings must be a JSON object")
    KeyValueStore.objects.update_or_create(k='settings', defaults={'v': json.dumps(data)})
    return JsonResponse({"status": "ok"})


# ---- History & reset (Settings > Miscellaneous) ---------------------------------------------------------------------


@require_POST
def clear_history(request):
    """Delete completed tasks finished more than `days` (at least 30) ago. Recurring tasks whose next copy hasn't
    been created yet are kept, so nothing stops repeating."""
    try:
        days = int(_json_body(request).get('days', 365))
    except (AttributeError, TypeError, ValueError):  # AttributeError: the body isn't a JSON object
        return HttpResponseBadRequest("Bad JSON")
    if days < 30:
        return HttpResponseBadRequest("Keep at least 30 days of history")
    cutoff = date.today() - timedelta(days=days)
    old = Task.objects.filter(status='done', done_at__lt=cutoff).filter(Q(interval=0) | Q(spawned=1))
    n, _ = old.delete()
    audit.info('%s cleared %d completed tasks finished before %s', who(request), n, cutoff.isoformat())
    return JsonResponse({"status": "ok", "deleted": n})


@require_http_methods(['DELETE'])
def reset_all(request):
    """Remove every task and project. Labels and label colors are kept."""
    with transaction.atomic():
        n, _ = Task.objects.all().delete()
        kv, st = _locked_settings()
        st.update({k: {} for k in PROJECT_DICTS})
        st.update({k: [] for k in PROJECT_LISTS})
        _save_settings(kv, st)
    audit.warning('%s deleted ALL tasks and projects (%d tasks) from %s', who(request), n, client_ip(request))
    return JsonResponse({"status": "ok", "deleted": n})


# ---- Backup & restore (Settings > Miscellaneous) --------------------------------------------------------------------


@require_GET
def backup(request):
    """Download every task and all settings as one JSON file."""
    tasks = []
    for t in Task.objects.order_by('id').values(*BACKUP_FIELDS):
        t['due'], t['done_at'] = _iso(t['due']), _iso(t['done_at'])
        tasks.append(t)
    data = {
        'app': 'home-projects',
        'version': 1,
        'exported_at': datetime.now().isoformat(timespec='seconds'),
        'tasks': tasks,
        'settings': stored_settings(),
    }
    audit.info('%s downloaded a backup (%d tasks)', who(request), len(tasks))
    resp = JsonResponse(data, json_dumps_params={'indent': 2})
    resp['Content-Disposition'] = f'attachment; filename="home-projects-backup-{date.today().isoformat()}.json"'
    return resp


def _backup_tasks(data):
    """Task objects (unsaved) from a parsed backup file; raises ValueError/TypeError/KeyError if it isn't valid."""
    if (
        data.get('app') != 'home-projects'
        or not isinstance(data.get('tasks'), list)
        or not isinstance(data.get('settings'), dict)
    ):
        raise ValueError('not a Home Projects backup')

    def parse(s):
        return datetime.strptime(s, '%Y-%m-%d').date() if s else None

    backup_rooms = all_rooms(data['settings'])  # rooms as they were on the backup's own map
    tasks = []
    for row in data['tasks']:
        fields = {k: row[k] for k in BACKUP_FIELDS if k in row}
        fields['due'], fields['done_at'] = parse(fields.get('due')), parse(fields.get('done_at'))
        fields['room'] = match_room(fields.get('room', ''), backup_rooms) or ''
        if fields.setdefault('interval_unit', 'm') not in UNITS:
            raise ValueError('bad repeat unit')
        if not fields.get('title') or not fields['due']:
            raise ValueError('task without a title or due date')
        tasks.append(Task(**fields))
    return tasks


@require_POST
def restore(request):
    """Replace all tasks and settings with the contents of a backup file. Checked first, then all or nothing."""
    if not request.FILES.get('file'):
        return HttpResponseBadRequest("No file uploaded")
    try:
        data = json.loads(request.FILES['file'].read().decode('utf-8-sig'))
        tasks = _backup_tasks(data)
    except (ValueError, TypeError, KeyError, AttributeError, UnicodeDecodeError) as e:
        return JsonResponse({"error": f"That file isn't a valid backup ({e})."}, status=400)

    with transaction.atomic():
        Task.objects.all().delete()
        Task.objects.bulk_create(tasks)
        KeyValueStore.objects.update_or_create(k='settings', defaults={'v': json.dumps(data['settings'])})
    audit.warning(
        '%s restored a backup from %s (%d tasks) from %s',
        who(request),
        data.get('exported_at', '?'),
        len(tasks),
        client_ip(request),
    )
    return JsonResponse({"status": "ok", "restored": len(tasks)})


# ---- Ranking --------------------------------------------------------------------------------------------------------


@require_GET
def ranking(request):
    """Rooms, floors, projects and the whole home ranked by ToDo count (see ranking.py)."""
    spawn_recurring()  # count the same tasks /api/tasks would show
    return JsonResponse(rank_all(stored_settings()))


# ---- CSV import -----------------------------------------------------------------------------------------------------
# Import is two steps so a file with gaps is never rejected outright:
#   1. /api/import/preview  reads the file and returns every row with what's missing (nothing is saved)
#   2. /api/import/commit   saves the rows the user reviewed/fixed in the import wizard
# /api/import does both at once with the defaults (kept for scripts and older clients).

CSV_COLUMNS = [
    'Task',
    'Area',
    'Room',
    'Frequency',
    'Interval (Months)',
    'Timing',
    'Notes',
    'Tutorial URL',
    'Last Done',
    'Next Due',
]
CSV_REQUIRED = ['Task']
SEASON_MONTHS = {'Spring': 4, 'Summer': 6, 'Fall': 10}  # "Timing" text -> month a seasonal task is first due


def parse_date(text):
    """YYYY-MM-DD, or US-style M/D/YYYY and M/D/YY (what spreadsheets often save). None if blank or unreadable."""
    text = (text or '').strip()
    for fmt in ('%Y-%m-%d', '%m/%d/%Y', '%m/%d/%y'):
        try:
            return datetime.strptime(text, fmt).date()
        except ValueError:
            pass
    return None


def first_due(timing, interval=0, unit='m'):
    """Due date for an imported row with no date: the next 1st of a season's month named in `timing` (e.g.
    "Spring and Fall" -> whichever of Apr 1 / Oct 1 comes first), else one repeat from today (a yearly task is due a
    year from now), else today for a one-off."""
    today = date.today()
    months = [m for season, m in SEASON_MONTHS.items() if season in timing]
    if months:
        return min(date(today.year + (date(today.year, m, 1) < today), m, 1) for m in months)
    return add_interval(today, interval, unit) if interval else today


def _parse_row(val, line, rooms):
    """One CSV row (val(column) -> text) as an import row with its issues. See parse_csv."""
    issues = []

    def issue(field, level, msg):
        issues.append({'field': field, 'level': level, 'msg': msg})

    title = _clean(val('Task'))
    if not title:
        issue('title', 'error', 'No task name')

    project = _clean(val('Area'))
    if not project:
        issue('project', 'warn', 'No area, so it will go in “General”')

    room_text = val('Room')
    room = match_room(room_text, rooms)
    if room is None:
        issue('room', 'warn', f'“{room_text}” isn’t a room on your map, so it will use its project’s room')
        room = ''

    freq, timing, iv_text = val('Frequency'), val('Timing'), val('Interval (Months)')
    parsed_freq = parse_freq(freq)
    unit = 'm'
    try:
        interval = max(0, int(float(iv_text)))
        if parsed_freq and parsed_freq[1] != 'm':  # "Weekly": the months column can't say that
            interval, unit = parsed_freq
    except ValueError:
        interval, unit = parsed_freq or (0, 'm')
        if not parsed_freq and (freq or iv_text):
            issue('interval', 'warn', f'Couldn’t tell how often “{iv_text or freq}” repeats, so it’s set to one-off')

    due, last = parse_date(val('Next Due')), parse_date(val('Last Done'))
    for col, parsed in (('Next Due', due), ('Last Done', last)):
        if val(col) and not parsed:
            issue('due', 'warn', f'{col} “{val(col)}” isn’t a date (use YYYY-MM-DD)')
    if not due and last and interval:
        due = add_interval(last, interval, unit)
    if not due:
        due = first_due(timing, interval, unit)
        if not interval and not any(season in timing for season in SEASON_MONTHS):
            issue('due', 'warn', 'No due date, so it’s due today')

    # a repeating task carries its frequency label (the Frequency text, else the label for its interval)
    freq_tag = freq or (freq_label(interval, unit) if interval else '')
    tags = ','.join(g for g in (freq_tag, timing if timing != 'Any' else '') if g)

    return {
        'line': line,
        'title': title,
        'project': project,
        'room': room,
        'tags': tags,
        'interval': interval,
        'interval_unit': unit,
        'notes': val('Notes'),
        'url': val('Tutorial URL'),
        'due': due.isoformat(),
        'issues': issues,
    }


def parse_csv(raw):
    """Turn an uploaded schedule CSV into editable rows, each listing what's missing. Never writes to the database.

    Each issue is {'field', 'level', 'msg'}: level 'error' means the row can't be imported until it's fixed,
    'warn' means it will import with the default shown. Raises ValueError for a file that can't be used at all."""
    try:
        text = raw.decode('utf-8-sig')
    except UnicodeDecodeError:
        text = raw.decode('latin-1')
    recs = list(csv.reader(io.StringIO(text)))
    if not recs or not any(h.strip() for h in recs[0]):
        raise ValueError('The file is empty.')

    headers = [h.strip().lstrip('﻿') for h in recs[0]]
    idx = {h.lower(): i for i, h in enumerate(headers)}  # headers match in any order, ignoring case
    if not any(c.lower() in idx for c in CSV_COLUMNS):
        raise ValueError(
            f'None of the expected column headers were found. The first row should be: {", ".join(CSV_COLUMNS)}.'
        )

    existing = {t.lower() for t in Task.objects.values_list('title', flat=True)}
    rooms = all_rooms()
    seen, rows = set(), []
    for line, row in enumerate(recs[1:], start=2):
        if not any(cell.strip() for cell in row):
            continue  # blank line in the spreadsheet

        def val(column, row=row):
            i = idx.get(column.lower())
            return row[i].strip() if i is not None and i < len(row) else ''

        r = _parse_row(val, line, rooms)
        key = r['title'].lower()
        r['duplicate'] = bool(key) and (key in existing or key in seen)
        if key:
            seen.add(key)
        rows.append(r)

    missing = [c for c in CSV_COLUMNS if c.lower() not in idx]
    return {'rows': rows, 'columns_missing': missing, 'columns_required': CSV_REQUIRED}


def save_rows(rows):
    """Create tasks from import rows (checked again here). Titles that already exist anywhere are skipped.
    Returns (number created, [{'title', 'reason'}] skipped)."""
    existing = {t.lower() for t in Task.objects.values_list('title', flat=True)}
    rooms = all_rooms()
    created, skipped = 0, []
    with transaction.atomic():
        for r in rows:
            title = _clean(r.get('title'))
            due = parse_date(str(r.get('due') or ''))
            reason = (
                'No task name'
                if not title
                else 'Already in the app'
                if title.lower() in existing
                else 'No valid due date'
                if not due
                else None
            )
            if reason:
                skipped.append({'title': title, 'reason': reason})
                continue
            try:
                interval = max(0, int(r.get('interval') or 0))
            except (TypeError, ValueError):
                interval = 0
            Task.objects.create(
                project=canonical_project(_clean(r.get('project')) or 'General'),
                title=title,
                status='backlog',
                tags=str(r.get('tags') or ''),
                notes=str(r.get('notes') or ''),
                url=str(r.get('url') or ''),
                due=due,
                interval=interval,
                interval_unit=r.get('interval_unit') if r.get('interval_unit') in UNITS else 'm',
                room=match_room(str(r.get('room') or ''), rooms) or '',
            )
            existing.add(title.lower())
            created += 1
    return created, skipped


@require_POST
def import_preview(request):
    if not request.FILES.get('file'):
        return HttpResponseBadRequest("No file uploaded")
    try:
        result = parse_csv(request.FILES['file'].read())
    except ValueError as e:
        return JsonResponse({"error": str(e)}, status=400)
    result['file'] = request.FILES['file'].name
    return JsonResponse(result)


@require_POST
def import_commit(request):
    data = _json_body(request)
    rows = (data or {}).get('rows')
    if not isinstance(rows, list) or not all(isinstance(r, dict) for r in rows):
        return HttpResponseBadRequest("Bad JSON")
    created, skipped = save_rows(rows)
    audit.info(
        '%s imported %d tasks from %r (%d skipped)', who(request), created, data.get('file', 'CSV'), len(skipped)
    )
    return JsonResponse({"imported": created, "skipped": skipped})


@require_POST
def import_csv(request):
    """One-step import with all defaults: rows that need a fix (no task name) and duplicates are skipped."""
    f = request.FILES.get('file')
    if not f:
        return HttpResponseBadRequest("No file uploaded")
    try:
        parsed = parse_csv(f.read())
    except ValueError as e:
        return JsonResponse({"error": str(e)}, status=400)
    ok = [r for r in parsed['rows'] if not r['duplicate'] and not any(i['level'] == 'error' for i in r['issues'])]
    created, _ = save_rows(ok)
    audit.info('%s imported %d tasks from %r', who(request), created, f.name)
    return JsonResponse({"imported": created})


# ---- Recurring tasks ------------------------------------------------------------------------------------------------
# A done task with an interval produces its next occurrence (a fresh ToDo copy) `spawnDays` before that copy is due.
# The next due date counts from the day it was completed, not from its old due date.


def next_due(t):
    return add_interval(t.done_at, t.interval, t.interval_unit)


def remove_successor(t):
    """Delete the occurrence spawned from t if it hasn't been touched yet. True if one was removed."""
    succ = (
        Task.objects.filter(
            project=t.project,
            title=t.title,
            interval=t.interval,
            interval_unit=t.interval_unit,
            status='backlog',
            due=next_due(t),
            done_at__isnull=True,
        )
        .exclude(pk=t.pk)
        .order_by('-id')
        .first()
    )
    if succ:
        succ.delete()
        return True
    return False


def spawn_days():
    """How many days before its due date the next copy of a recurring task appears (Settings > Miscellaneous)."""
    try:
        return min(90, max(0, int(stored_settings().get('spawnDays', 7))))
    except (TypeError, ValueError):
        return 7


def spawn_recurring():
    """Create the next copy of every recurring task that's due within spawn_days(). Runs on every task list and save."""
    done_tasks = Task.objects.filter(status='done', interval__gt=0, spawned=0, done_at__isnull=False)
    threshold = date.today() + timedelta(days=spawn_days())
    with transaction.atomic():
        for t in done_tasks.select_for_update():
            next_date = next_due(t)
            if next_date > threshold:
                continue
            if not open_duplicate(t.project, t.title):  # never a second open copy of the same task
                Task.objects.create(
                    project=t.project,
                    title=t.title,
                    status='backlog',
                    tags=t.tags,
                    notes=t.notes,
                    url=t.url,
                    due=next_date,
                    interval=t.interval,
                    interval_unit=t.interval_unit,
                    priority=t.priority,
                    room=t.room,
                )
            t.spawned = 1
            t.save(update_fields=['spawned'])
