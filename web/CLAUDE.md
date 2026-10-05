# web/ — the Django app

Python package `web`, Django app **label `tasks`** (`apps.WebConfig.label`; kept from before the folder was renamed so existing databases' migration history still matches: use `tasks` in `makemigrations tasks` and `apps.get_model('tasks', …)`). Front-end notes: `static/CLAUDE.md`; templates: `templates/CLAUDE.md`; migrations: `migrations/CLAUDE.md`.

## Files

| file | purpose |
|---|---|
| `apps.py` | `WebConfig` (name `web`, label `tasks`, verbose name "Home Projects"). `ready()` imports `security` to connect the sign-in signal handlers. |
| `models.py` | `Task` (table `tasks`) and `KeyValueStore` (table `kv`). See "Data model". |
| `views.py` | Page view + the whole JSON API, plus server rules: duplicates, recurring tasks, project rename/delete, backup/restore, CSV import. Sections: Pages · Settings blob · Tasks · Projects · Settings · History & reset · Backup & restore · Ranking · CSV import · Recurring tasks. |
| `urls.py` | Page routes and `/api/*` routes (table below). Included by `config/urls.py`. |
| `ranking.py` | `TIERS`, `tier(n)`, `ranking(settings)` for `GET /api/ranking`. Mirrored by `LEVELS`/`tierOf` in `static/app.js`. |
| `rooms.py` | The house map server-side: `BUILTIN_ROOMS` (house, yard), `DEFAULT_MAP` (starter floors/rooms, also passed to app.js as the `map-default` json_script), `current_map()`, `all_rooms()`, `match_room()` (id/name/alias → room id; `None` if not on the map), `guess_room()`/`room_for_project()` (mirror `guessRoom`/`roomFor` in app.js; used by ranking), `ALIASES`, `LEGACY_ROOMS`, `ROOM_GUESS`, `ROOM_KINDS`. |
| `repeat.py` | Repeat frequencies: `UNITS` (`d`,`w`,`m`), `parse_freq(text)` → `(n, unit)` (mirrors `parseFreq` in app.js: "weekly", "biweekly", "Every 3 weeks", "2-5 years"…), `freq_label(n, unit)`, `add_interval(date, n, unit)` (relativedelta). `is_repeat_label`/`strip_repeat_tags`/`clean_settings` exist only for migration 0003. |
| `security.py` | `LoginRequiredMiddleware` (pages → `/login/`, `/api/*` → `401 {"error"}`), `AuditLogMiddleware` (logs every non-GET `/api/` call: user, method, path, status, IP, ms), `ThrottledLoginView` (429 lockout), `client_ip()`, `who()`, and the `user_logged_in/out/login_failed` signal handlers. |
| `tests.py` | 38 tests (see "Tests"). Run `python manage.py test web`. |
| `admin.py` | Nothing registered: data is edited in the app; `/admin/` is only for accounts. |
| `__init__.py` | empty. |

## Data model (`models.py`)

`Task` (table `tasks`):
| field | type | notes |
|---|---|---|
| project | Char, default 'General' | free-text project name; projects have no table of their own |
| title | Char | required |
| status | Char, default 'backlog' | `backlog` (shown as "ToDo"), `doing`, `done` |
| tags | Text | comma-separated labels, e.g. `"Quarterly,Spring"`. At most one is a **frequency label**, which sets interval/interval_unit |
| notes | Text | supports `- [ ] step` / `- [x] step` checklists (counted on cards) |
| url | URL | tutorial link |
| due | Date | required |
| interval | Int, default 0 | repeat every `interval` × unit; 0 = one-off |
| interval_unit | Char(1), default 'm' | `d` days, `w` weeks, `m` months (`repeat.UNITS`; save_task 400s on others) |
| priority | Int, default 3 | 1 Highest, 2 High, 3 Medium, 4 Low (server clamps to 1–4) |
| done_at | Date, nullable | set when status becomes done |
| spawned | Int (0/1) | 1 once this done task has produced its next occurrence |
| room | Char(20), blank | a room id from the map; `''` = use the project's room. Copied to the next occurrence. |

`KeyValueStore` (table `kv`): one row, `k='settings'`: **the settings blob**, a JSON object owned by the client (the server only checks it's an object; `views.stored_settings()` reads it):
```json
{
  "colors":       {"<label>": "#hex"},
  "labels":       ["<custom label>", ...],
  "projects":     {"<project>": 1-4},          // project priority
  "porder":       ["<project>", ...],          // hand-arranged Board order (Settings > Projects drag)
  "pcolors":      {"<project>": "#hex"},
  "projectNames": ["<project>", ...],          // projects that may have no tasks yet
  "rooms":        {"<project>": "<room id>"},  // Home map room; missing -> guessRoom(name)
  "spawnDays":    7,                           // read by the server in spawn_recurring()
  "dueYellow":    14, "dueOrange": 7,          // card due-date colors
  "freqs":        {"<label>": {"n", "u"} | 0},  // a label's repeat (u = d|w|m; 0 = plain label); a bare number = months (old). Missing -> FREQ built-in, else parseFreq(name)
  "map": {                                     // Home map (absent = rooms.DEFAULT_MAP)
    "floors": [{"id", "name"}, ...],           // basement / main / upper (renamable) + "outside" (the Outside tab, always last)
    "yard":   {"name", "emoji"},               // optional: the renamed built-in 'yard' room
    "ground": "main",                          // floor drawn with the yard
    "lot":    {"t", "b", "l", "r"},            // optional: extra Outside canvas per side (multiples of 100, ≤ 2000)
    "rooms":  [{"id", "name", "emoji", "floor", "x", "y", "w", "h", "kind"?, "pts"?, "to"?}, ...]   // 800 × 540 plan units, snapped to 10
  }
}
```
Map item `kind`: missing/`room` and `structure` are rooms (`ROOM_KINDS`, can hold tasks); `stairs`, `blocked`, `tree` are drawn but aren't rooms. `PROJECT_DICTS`/`PROJECT_LISTS` in views.py list the per-project keys that `rename_project`, `delete_project` and `reset_all` update. Add new per-project keys there.

## Routes (`urls.py`)

Pages (`views.page_view`; 404 on unknown page/tab): `/` (home), `/board/`, `/calendar/`, `/stats/`, `/settings/` (= first tab), `/settings/<projects|tasks|labels|misc>/` (`SETTINGS_TABS` order = tab order; `OLD_TAB_NAMES` maps the old `sched` → `tasks`). The Board's query parameters (`?room=`, `?project=`, `?label=`, `?rank=`, `?status=`) are read by app.js. Auth routes are in `config/urls.py`.

JSON API (sign-in + CSRF token required; a wrong method gets **405** from the `require_*` decorators):
| method | path | view | purpose |
|---|---|---|---|
| GET | `/api/tasks` | `list_tasks` | runs `spawn_recurring()` first, then all tasks (`TASK_FIELDS`) by due date |
| POST | `/api/tasks/new` | `save_task` | create (409 on duplicate; `save_key` makes phone retries safe) |
| PUT | `/api/tasks/<id>` | `save_task` | full update (400 on bad interval/priority/date) |
| DELETE | `/api/tasks/<id>/del` | `delete_task` | |
| DELETE | `/api/projects/del` | `delete_project` | body `{"project": name}`; deletes tasks + per-project settings atomically |
| POST | `/api/projects/rename` | `rename_project` | `{old, new}`; renames the tasks and moves the project's settings keys atomically; 409 if `new` is another project (case-only change allowed) |
| DELETE | `/api/reset` | `reset_all` | deletes every task + all per-project settings (labels kept) |
| GET | `/api/backup` | `backup` | attachment `{app:'home-projects', version:1, exported_at, tasks:[…BACKUP_FIELDS], settings}` |
| POST | `/api/restore` | `restore` | multipart `file`; `_backup_tasks` validates everything first, then all tasks + settings are replaced in one transaction |
| POST | `/api/import/preview` | `import_preview` | multipart `file` → `{rows:[{line,title,project,room,tags,interval,interval_unit,notes,url,due,duplicate,issues:[{field,level,msg}]}], columns_missing, columns_required, file}`; **saves nothing** |
| POST | `/api/import/commit` | `import_commit` | `{file, rows:[…]}` from the wizard → `{imported, skipped:[{title,reason}]}` |
| POST | `/api/import` | `import_csv` | one-step import with defaults (rows needing a fix and duplicates are skipped); `{"imported": n}` |
| POST | `/api/history/clear` | `clear_history` | `{days}` (≥30): deletes done tasks finished before the cutoff **except** recurring ones with `spawned=0` |
| GET | `/api/ranking` | `ranking` | runs `spawn_recurring()`, then `ranking.ranking()` (see "Ranking") |
| GET | `/api/settings` | `get_settings` | raw settings JSON (`{}` if never saved) |
| PUT | `/api/settings/put` | `put_settings` | replace (must be a JSON object) |

## Server rules

**Duplicate prevention.** `open_duplicate(project, title)` = an open (non-done) task with the same project + title, case-insensitive (done copies are history). `save_task` returns **409** on create, or on an update that changes title/project, when one exists; status-only changes are never blocked. `canonical_project(name)` reuses an existing project's spelling; titles/projects are whitespace-normalized (`_clean`). Phone retries: new tasks carry `save_key`; `save_task` remembers it in the cache for 10 min (`save-key:<user>:<key>`), and a repeat of a key whose task already exists gets `200 {repeat: true}` instead of 409.

**Recurring tasks (the subtle part).** `next_due(t) = add_interval(t.done_at, t.interval, t.interval_unit)` (from the **completion date**). `spawn_recurring()` runs on every `GET /api/tasks`, `GET /api/ranking` and after every `save_task`: for each `status='done', interval>0, spawned=0, done_at not null` task where `next_due <= today + spawn_days()` (settings `spawnDays`, default 7, clamped 0–90) it creates a `backlog` copy unless an open duplicate exists, and sets `spawned=1` either way (atomic, `select_for_update`). Reopening (status leaves done): if `done_at and spawned`, `remove_successor(t)` deletes the spawned copy only if untouched, and `spawned` resets to 0 only if one was removed; `done_at` is cleared. Covered by `RecurringTests`, `SpawnWindowTests`, `WeeklyRepeatTests`.

**CSV import** (`parse_csv` → wizard → `save_rows`). `CSV_COLUMNS = Task, Area, Room, Frequency, Interval (Months), Timing, Notes, Tutorial URL, Last Done, Next Due`; headers match case-insensitively in any order; only `Task` is required; a file with none of them → 400; BOM stripped; latin-1 fallback. `parse_csv` never writes; `_parse_row` fills defaults and records issues: `error` = no task name (row blocked); `warn` = no Area ("General"), unknown Room (project's room), unreadable interval (one-off), bad date text, no due date (today). Dates: `YYYY-MM-DD`, `M/D/YYYY`, `M/D/YY` (`parse_date`). `due` = Next Due → Last Done + interval → `first_due(Timing)` (`SEASON_MONTHS`: Spring→Apr, Summer→Jun, Fall→Oct). A day/week Frequency overrides the months column. `tags` = Frequency text (else `freq_label`) + Timing. `duplicate` = title already in the DB or earlier in the file. `save_rows` re-checks everything and skips titles that already exist anywhere, so re-importing is safe.

**Ranking** (`ranking.py`). A count of **ToDo (backlog)** tasks ranks as:
| tier key | name | count | color (app.js) | mood on the map |
|---|---|---|---|---|
| `perfect` | Perfect | 0 | green `#2fbf71` | sunny glow + 4 sparkles |
| `thriving` | Thriving | 1–3 | green `#3e9a78` | sunny glow + 2 sparkles |
| `livable` | Livable | 4–6 | light green `#9ccc65` | lamp + motes |
| `neutral` | Neutral | 7–10 | yellow `#e9c46a` | lamp |
| `slacking` | Slacking | 11–20 | orange `#e0782a` | heat + bubbles |
| `neglected` | Neglected | 21+ | red `#d64550` | boil, steam, pulsing edge |

`ranking(settings)` returns `{counts:'todo', tiers:[{tier,rank,mood,min,max}], home, summary:{tier: n rooms}, rooms[], floors[], projects[]}`; every row has `todo`, `doing`, `overdue`, `tier`, `rank`, `mood`. Tasks count toward their own room if it's on the map (`LEGACY_ROOMS` applied), else their project's room (`room_for_project`). Rooms are sorted by ToDo (then overdue, name). Changing tiers means changing `TIERS` here **and** `LEVELS`/`TIER_MAX`/`MOODS` in app.js, `RANK_PARAM`'s list, the `data-tier` CSS rules, and `RankingTests`.

**Rooms.** Task saves, CSV import, and restore accept only rooms on the current map (`match_room`, unknown → `''`); restore checks against the backup's own map.

## Tests (`tests.py`)

`AuthedTestCase` (creates and force-logs-in a user) is the base for RecurringTests, DeleteProjectTests, PageTests, DuplicateTests, ResetTests, ImportTests, WeeklyRepeatTests, SpawnWindowTests, BackupTests, ImportWizardTests, TaskRoomTests, ClearHistoryTests, RenameProjectTests, CustomMapTests, OutsideMapTests, RankingTests. `SecurityTests` (no auto sign-in) covers redirect/401, sign in/out, lockout (429) and CSRF enforcement. Tests use a locmem cache and the MD5 hasher for speed and disable logging.
