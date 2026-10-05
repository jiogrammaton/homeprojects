# web/migrations/ — database migrations

Migrations for the app whose **label is `tasks`** (the package is `web`; see `web/apps.py`). Dependencies and `apps.get_model()` calls therefore say `'tasks'`. Create new ones with `python manage.py makemigrations tasks`. The VM applies them in the update script (`manage.py migrate`). Excluded from ruff (generated code).

| file | what it does |
|---|---|
| `0001_initial.py` | Creates `Task` (table `tasks`) and `KeyValueStore` (table `kv`). Auto-generated. |
| `0002_task_room.py` | Adds `Task.room` (`CharField(20)`, blank: `''` = use the project's room). |
| `0003_repeat_not_a_label.py` | Data migration from when repeats were a separate field: stripped frequency labels ("Monthly", "2-5 years"…) from tags and from the settings label list. Superseded by 0004 but must stay (history). Uses `web.repeat.clean_settings`/`strip_repeat_tags`. |
| `0004_task_interval_unit.py` | Adds `Task.interval_unit` (`d`/`w`/`m`), then ties each task's repeat to a label again: a task with a frequency label takes that label's interval; a repeating task without one gets the label for its interval (`web.repeat.parse_freq`/`freq_label`). |
| `__init__.py` | empty. |

Data migrations import from `web.repeat`, so keep those helpers' names and behavior stable (or copy them into the migration before changing them).
