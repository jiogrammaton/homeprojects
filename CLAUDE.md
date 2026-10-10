# CLAUDE.md

Technical reference for **Home Projects**: a Django app for home maintenance and project tracking (house map, kanban board, recurring tasks, calendar, stats). It needs a sign-in and runs on a home network. Open source (MIT, `LICENSE`), published at `github.com/jiogrammaton/homeprojects`, so keep code and docs free of any one person's setup: the user's own server details live in the git-ignored `CLAUDE.local.md`. User-facing docs: `README.md`; server setup: `DEPLOY.md`.

Every folder has its own `CLAUDE.md` with notes on each file in it. Read the one for the folder you're changing:

| folder | what's there | notes |
|---|---|---|
| `config/` | Django settings, top-level URLs, WSGI/ASGI | `config/CLAUDE.md` (env keys, security settings, logging, static files) |
| `deploy/` (+ root `install.sh`) | installer, the `homeprojects` command, push.sh, systemd unit, Caddy, rsync excludes | `deploy/CLAUDE.md` (install flow, `/etc/homeprojects.conf`, how to test) |
| `web/` | the Django app: models, views/API, ranking, rooms, security, tests | `web/CLAUDE.md` (data model, settings blob, routes, API, server rules, tests) |
| `web/migrations/` | schema + data migrations | `web/migrations/CLAUDE.md` |
| `web/static/` | `app.js` (entire client), `style.css`, `favicon.svg` | `web/static/CLAUDE.md` (front-end architecture, every feature, styling rules) |
| `web/templates/` | page shells and sign-in pages | `web/templates/CLAUDE.md` |

## Stack

- Python 3.14 in `./venv`; Django 6.1.1; `python-dateutil` (month math); `whitenoise` (serves static files); `gunicorn` (production server). Pinned in `requirements.txt`; dev tools (ruff, playwright) in `requirements-dev.txt`.
- SQLite at `db.sqlite3` (holds the user's real data and accounts; don't delete or reset it without asking). The local copy is behind on migrations and nearly empty; the real data is on the VM.
- Front end: no build step, no framework. One vanilla JS file plus one CSS file, served by whitenoise straight from `web/static/` (no collectstatic, no `staticfiles/`).
- Git repo, remote `origin` = GitHub (no commits yet as of Oct 2026). `.gitignore` keeps out the DB, secrets, logs, `CLAUDE.local.md` and `wishlist.md`.

## Commands

```bash
source venv/bin/activate
python manage.py runserver            # http://127.0.0.1:8000/ (sign-in required)
python manage.py test web             # 42 tests, all should pass
python manage.py check --deploy       # only the 4 HTTPS warnings are expected on plain HTTP
python manage.py makemigrations tasks && python manage.py migrate   # after model changes (app LABEL is still 'tasks')
ruff check . && ruff format --check . # lint + format check (pyproject.toml); `ruff format .` to fix
deploy/push.sh you@server update     # deploy to a server (the user's VM: see CLAUDE.local.md)
```

Node isn't installed; `gjs` can syntax-check JS (`new Function(src)`).

**Browser testing:** Playwright + Chromium are installed in `venv` (`requirements-dev.txt`). When the user says "test it in a browser":
1. Copy `db.sqlite3` to the scratchpad and `migrate` the copy, then create a throwaway superuser in it (`DJANGO_DB_PATH=<copy> DJANGO_SUPERUSER_PASSWORD=… manage.py createsuperuser --noinput --username tester --email tester@example.com`). Never use the real DB or the user's password. Seed test data with `manage.py shell -c` against the copy (the local DB has almost no tasks); the VM's map can be read (read-only) over SSH.
2. Run `DJANGO_DB_PATH=<copy> DJANGO_LOG_DIR=<scratch>/logs manage.py runserver 127.0.0.1:8765 --noreload` in the background. Restart it after CSS/JS edits: with DEBUG off, whitenoise indexes static files at startup. (Don't `pkill -f` a pattern that also matches your own shell command.)
3. Drive it with Python Playwright. Check desktop (1440×900), laptops (1366×768, 1024×768), and phone (390×844 or 360×780, `is_mobile`, `has_touch`). Record `pageerror`/console errors/HTTP ≥400, check `scrollWidth - innerWidth` for horizontal scroll, and look at the screenshots. Scroll elements into view before clicking by coordinates. Mouse drags: `mouse.down`, wait 250 ms, move in steps. Real touch drags via CDP `Input.dispatchTouchEvent` (touchStart → wait 500 ms → touchMove steps → touchEnd). Verify changes through `/api/tasks` / `/api/settings` / `/api/ranking`. Full-page screenshots resize the viewport (can trigger resize handlers).

## Project layout

```
.
├── manage.py
├── pyproject.toml                 # tool settings only: ruff lint + format (line length 120, quotes preserved)
├── requirements.txt               # production packages (pinned)
├── requirements-dev.txt           # + ruff, playwright
├── .gitignore                     # venv, caches, logs, secrets (.env, .secret_key), db.sqlite3, backups
├── install.sh                     # one-command server install (see deploy/CLAUDE.md)
├── LICENSE                        # MIT
├── CLAUDE.local.md                # the user's own server details (git-ignored)
├── .env.example                   # every DJANGO_* setting, documented; copy to .env (install.sh needs it)
├── .env / .secret_key             # local only, generated/edited per machine (never share or commit)
├── .cache/  logs/                 # created at runtime: lockout/save-key cache, rotating logs
├── db.sqlite3                     # live user data (not in git)
├── home_maintenance_schedule.csv  # starter data, imported through the UI (~59 rows)
├── wishlist.md                    # the user's scratch notes / request drafts (git-ignored)
├── README.md / DEPLOY.md
├── config/                        # Django project package (settings, urls, wsgi, asgi)
├── deploy/                        # homeprojects.sh (the `homeprojects` command), push.sh, systemd unit, Caddyfiles
└── web/                           # the Django app (Python package `web`, app label `tasks`)
    ├── models.py  views.py  urls.py  ranking.py  rooms.py  repeat.py  security.py  apps.py  admin.py  tests.py
    ├── migrations/                # 0001..0004
    ├── static/                    # app.js, style.css, favicon.svg  (served at /static/<name>)
    └── templates/                 # base.html + page stubs, auth_base.html, login.html, password_change.html
```

**App label:** the package was renamed from `tasks/` to `web/` (Oct 2026), but `WebConfig.label = 'tasks'` so existing databases (their `django_migrations` rows and permissions) keep working unchanged. Use `tasks` wherever Django wants an app label (`makemigrations tasks`, `apps.get_model('tasks', 'Task')`); use `web` for imports and paths. Table names are explicit (`tasks`, `kv`).

## Architecture in one paragraph

**Server-rendered shell + client-rendered content.** Every app page renders `web/templates/base.html` with `<body data-view="home|board|cal|stats|settings" data-tab="projects|tasks|labels|misc" data-user="…">`. `web/static/app.js` reads those, fetches `/api/tasks` and `/api/settings`, and builds the page into `<main id="m">` with `innerHTML` template strings. UI changes almost always go in `app.js` / `style.css` / `base.html`. Python changes are for the data model, API endpoints, server-side rules (recurrence, import, cascade deletes, backup, ranking), auth/security, or routes. Most UI state that isn't tasks lives in one client-owned JSON "settings blob" (see `web/CLAUDE.md`).

**Upcoming window:** the Board and Home show (and rank) only ToDo tasks due within `showDays` (settings, default 7; overdue included); Doing/Done always show. Calendar, Stats and Settings › Tasks show everything; nothing is hidden in the data.

**Ranking** (Overall feature): a count of ToDo tasks ranks as Perfect 0 · Thriving 1–3 · Livable 4–6 · Neutral 7–10 · Slacking 11–20 · Neglected 21+ (`web/ranking.py` `TIERS`, mirrored by `LEVELS`/`tierOf` in app.js; keep both in sync). Rooms, floors, projects and the whole home are ranked; `GET /api/ranking` returns it all.

## Conventions and user preferences

- The user asks for changes as a bulleted list and wants files edited in place, then deployed to their VM with `deploy/push.sh … update` (host in `CLAUDE.local.md`). Answer any questions in the list directly (e.g. "what should we add?") with a recommendation. If an item is cut off or ambiguous, make a sensible call and say so.
- Python: PEP 8 via ruff (`pyproject.toml`), module docstrings explaining the file's role, sections marked `# ---- Name ----`, small function-based views (no DRF/forms), `require_GET`/`require_POST`/`require_http_methods` on API views (wrong method = 405).
- JS/CSS: match the compact style: short names, inline-handler HTML strings, section markers `/* ---- name ---- */`. The top of `app.js` and `style.css` lists the sections.
- Visual consistency matters to the user: new UI should reuse `.prow`/`.mrow`/`.pgroup`/`.stats-card`/`.pbtn` patterns and the existing palette (slate/navy + green accent, no brown, no black walls).
- Bump the `?v=N` cache-busting number in `base.html` and `auth_base.html` on every CSS/JS change (currently **54**).
- Keep `CLAUDE.md` files current: when you change a file, update its folder's `CLAUDE.md`.

## Known gaps / gotchas

- Settings blob is client-owned; concurrent edits from two devices are last-write-wins.
- Label rename/delete makes N sequential PUTs.
- Room ids are stored in tasks and settings. Renaming or removing a built-in one needs a `LEGACY_ROOMS` entry in app.js and `web/rooms.py` plus an `ALIASES` entry in rooms.py so stored values keep working.
- Touch interactions are verified in Chromium's touch emulation (Playwright), not on a physical iPhone/Android device.
- Plain HTTP on the LAN unless the optional Caddy/HTTPS step is done.
