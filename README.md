# Home Projects

A self-hosted home maintenance and project tracker. It combines a Jira-style kanban board with a recurring-task scheduler, so routine upkeep (changing the HVAC filter, cleaning gutters) and one-off projects (remodeling the kitchen) live in one place. A home page shows a bird's-eye map of the house, with each room colored by how much is left to do there.

Built with Django (Python) on the back end and plain HTML/CSS/JavaScript on the front end. Data is stored in a local SQLite file (`db.sqlite3`), so nothing leaves your machine.

## Install on a home server

On an always-on Linux machine or VM (Fedora/RHEL, or Debian 13+/Ubuntu 24.04+):

```bash
git clone https://github.com/jiogrammaton/homeprojects.git
sudo bash homeprojects/install.sh
sudo homeprojects start
```

The installer sets up everything the app needs and installs it in `/opt/homeprojects`, running as a `homeprojects` account on port 8000 (`--dir`, `--user` and `--port` change those). `start` has you create your sign-in, starts the app, and prints the address to open from your phone or laptop. **[DEPLOY.md](DEPLOY.md)** covers the options, updates, HTTPS, logs, and backups.

## Run it on your own computer (development)

Needs Python 3.12 or newer (developed on Python 3.14) and `pip` (comes with Python).

### Setup (first time only)

Run these from the project folder (the one that contains `manage.py`).

```bash
# 1. Create a virtual environment in ./venv
python -m venv venv

# 2. Activate it (do this every time you open a new terminal)
source venv/bin/activate

# 3. Install the Python packages
pip install -r requirements.txt

# 4. Create or update the database tables
python manage.py migrate

# 5. Create your sign-in (username + password of at least 10 characters).
#    Skip this if you already have one; after updating the app, steps 3 and 4 are enough.
python manage.py createsuperuser
```

When the venv is active, your prompt shows `(venv)`. To leave it, run `deactivate`.

### Launching the app

```bash
source venv/bin/activate
python manage.py runserver
```

Open <http://127.0.0.1:8000/> and sign in with the account from step 5. Press `Ctrl+C` in the terminal to stop the server.

Optional: while developing, Django's detailed error pages help. Create a file named `.env` next to `manage.py` containing `DJANGO_DEBUG=1`. Never do this on a server other devices can reach.

### Using it from other devices

For everyday use, install it on a server (above). For a quick test from your own computer instead: copy `.env.example` to `.env`, put your computer's IP address in `DJANGO_ALLOWED_HOSTS`, run `python manage.py runserver 0.0.0.0:8000`, and visit `http://<your-ip>:8000/` from the other device.

## Importing tasks from a CSV

`home_maintenance_schedule.csv` holds a starter list of about 60 common home maintenance tasks. Click **Import** and choose a CSV file. Nothing is saved until you confirm in the import wizard:

1. **Review:** how many rows are ready, which will use a default, which need a fix, and which are already in the app (same task name, so they're skipped).
2. **Fix:** edit any row, or tick several rows and set their area, room, repeat, or due date all at once. You can also skip rows.
3. **Import:** saves the rows and lists anything that was left out.

Column headers (the order doesn't matter, and only **Task** is required):

| Column | If it's missing or blank |
|--------|--------------------------|
| `Task` | Required. The row needs a name before it can be imported. |
| `Area` | The task goes in the "General" project. |
| `Room` | Optional. The task uses its project's room. Accepts the names of rooms on your map (for example `Kitchen`), plus `Yard` and `Whole house`. |
| `Frequency` | Becomes the task's frequency label (e.g. `Quarterly`, `Weekly`). If `Interval (Months)` is also blank and the frequency can't be read, the task is one-off. |
| `Interval (Months)` | Worked out from `Frequency` when possible (`Quarterly` = 3, `Every 2 years` = 24). |
| `Timing` | `Spring` / `Summer` / `Fall` set the first due date to Apr 1 / Jun 1 / Oct 1 when there's no date. |
| `Notes`, `Tutorial URL` | Left empty. |
| `Last Done` | If there's no `Next Due`, the first due date is `Last Done` + the interval. |
| `Next Due` | Due today unless `Last Done` or `Timing` gives a date. `YYYY-MM-DD` and `M/D/YYYY` both work. |

## Pages

| Page | What it's for |
|------|---------------|
| **Home** (`/`) | A bird's-eye map of your house, one floor at a time (tabs above the map; each shows how many tasks are waiting there). Click **Edit map** to edit the map: add, rename, move, resize, and reshape rooms (drag a corner or wall; ⊕ splits a wall so you can pull out just part of it, for L-, T- or U-shaped rooms; rooms you drag over make room automatically), pick their icons, add stairs between floors (solid on their own floor, see-through on the floor they lead to), block off space that isn't a room or hallway (e.g. over the garage; drawn hatched), and rename floors. Space between rooms is drawn as hallway; the yard has trees and flowers. The **Outside** tab shows your whole property with the house in the middle (fixed; you change it on the other tabs): resize the back and front yard or add your own yard areas, add structures such as a shed (they can hold tasks, like rooms), add large trees, and rename the rest of the yard ("Yard & exterior") or change its icon. There's always open yard above the back yard: drag its top edge up, let go, and drag again to keep making it taller. **Yard size** in the editor's side panel also adds yard above, below, left or right of the house. Each room is ranked by how many **ToDo** tasks it has: **Perfect** (none, the goal; a sunny glow with sparkles), **Thriving** (1–3), **Livable** (4–6; cozy lamplight), **Neutral** (7–10), **Slacking** (11–20; it starts to bubble), **Neglected** (21+; a rolling boil with steam). The **Rooms** panel lists every room with its rank and can be filtered with the menu next to its heading: All rooms, With tasks, Slacking or worse (11+), or This floor. Click a color in its rank bar to see the tasks in rooms of that rank on the Board. The Whole house card shows the overall rank of every ToDo task in the home. The legend starts collapsed. On a phone held upright the map turns sideways to fill the screen. The same ranking is available as JSON at `/api/ranking`. Hover a room (or tap it on a phone) for its To do / Doing / Done / Overdue counts; click it (or tap again) to open that room's tasks on the Board. Each task counts toward its own room if you've set one, otherwise its project's room. Tasks not tied to one room (safety, HVAC, admin…) count toward **Whole house**. |
| **Board** (`/board/`) | Kanban columns (ToDo / Doing / Done), one panel per project. Click a project's name or chevron to collapse or expand it; clicking an empty part of a project also works. The first two projects (in Settings › Projects order) that have open tasks start expanded, and the rest start collapsed. To delete a task, drag its card onto the project's trash can (it lights up red while you hold a card); you're asked to confirm first. Click a column heading to show only that column (click it again, or **Show all columns**, to go back). Drag cards between columns (on a phone or tablet, press and hold a card, then drag). Due dates turn yellow, orange, and red as they get close (the day counts are adjustable in Settings). |
| **Calendar** | Projects every task, recurring ones included, across the next 12 months, grouped by season. |
| **Stats** | Totals, streaks, record week and month, a 12-month trend, and completions by project. |
| **Settings** | **Projects** (drag projects into the exact order and priority you want, click a name to rename it, choose each one's room; "N tasks" opens them on the Board) · **Tasks** (quickly edit title, priority, repeat frequency, and room for every task) · **Labels** (create, rename, and recolor labels, and give any label a repeat to make it a frequency such as “Weekly”; "N tasks" opens them on the Board) · **Miscellaneous** (account, recurring-task timing, due-date colors, clearing old completed history, backup and restore, and delete everything). |

Use **New** in the header to create a task or a project. **Save & add another** keeps the form open for the next one, and new tasks start with the same project, room, priority, status, labels, due date and repeat as the last one you created (only the title, link and notes are cleared). After a "Save & add another", just type the next title, press **Tab**, then **Enter**. New projects get a random colour. Hover (or tap) a **?** next to a field name for an explanation of that field. A task can be given its own room (for example, a sump-pump check in the Safety project can sit in the Basement); otherwise it uses its project's room. The filter box (press `/` to jump to it) narrows the page you're on by title, label, or project. It's grayed out where there's nothing to filter. The app won't let you create two open tasks with the same name in the same project, or two projects with the same name.

## How recurring tasks work

1. Each task can have a **Repeat** interval (monthly, quarterly, twice a year, and so on). One-off tasks have no interval. Need a different one? Every frequency is a label: the Repeat list shows every label that has a repeat, and picking one adds that label to the task (selecting a frequency label's chip does the same). Need another one? Pick **Custom…** at the bottom of the Repeat list and enter "Every [n] days/weeks/months/years" (it becomes a label), or in **Settings › Labels** give any label a repeat with its ↻ box. Labels named like "Weekly", "Daily", "Biweekly" or "Every 3 weeks" get their repeat automatically. Changing a frequency's repeat there reschedules every task that uses it.
2. When you mark a recurring task **Done**, the app records today as the completion date.
3. A set number of days before the next due date (completion date + interval), a fresh ToDo card appears automatically. The default is 7 days; change it in Settings › Miscellaneous. The finished card stays in Done as history and feeds the Stats page.
4. If you move a completed task back out of Done before you've touched its new copy, the copy is removed, so you never end up with duplicates.

## Project layout

```
config/    Django project settings, top-level URLs, WSGI entry point
install.sh one-command server install (prerequisites, account, service, the `homeprojects` command)
deploy/    the `homeprojects` command (start/update/...), push.sh, systemd unit, Caddy (HTTPS) config
web/       the app: models, views (pages + JSON API), ranking, rooms, security, tests
web/static/      app.js (the whole browser client), style.css, favicon.svg
web/templates/   page shells and sign-in pages
```

Each folder has a `CLAUDE.md` with technical notes on every file in it.

## Common tasks

```bash
# Run the automated tests
python manage.py test web

# Development tools (linter/formatter and browser tests; not needed on the server)
pip install -r requirements-dev.txt
ruff check . && ruff format .

# Reset a forgotten password
python manage.py changepassword <username>

# Back up your data (or use Settings › Miscellaneous › Download backup)
cp db.sqlite3 db.backup-$(date +%F).sqlite3

# Start fresh (deletes ALL tasks, settings, and accounts)
rm db.sqlite3 && python manage.py migrate && python manage.py createsuperuser
```

## Files you shouldn't share

`.env` (your settings), `.secret_key` (generated on first start), `db.sqlite3` (your data and password hashes), and `logs/`.

## License

[MIT](LICENSE)
