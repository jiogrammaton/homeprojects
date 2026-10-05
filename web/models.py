"""Database tables. The app keeps almost everything in two tables:

- Task (table `tasks`): every task, open or done. Projects have no table: a project is the `project` text on its
  tasks plus its entries in the settings blob.
- KeyValueStore (table `kv`): one row, k='settings', holding the client-owned settings JSON (labels, colors,
  project order, the house map, ...). See web/CLAUDE.md for its keys.
"""

from django.db import models


class Task(models.Model):
    project = models.CharField(max_length=255, default='General')
    title = models.CharField(max_length=255)
    status = models.CharField(max_length=50, default='backlog')  # 'backlog' (shown as "ToDo"), 'doing', 'done'
    tags = models.TextField(blank=True, default='')  # comma-separated labels; at most one is a frequency label
    notes = models.TextField(blank=True, default='')  # may hold "- [ ] step" / "- [x] step" checklist lines
    url = models.URLField(blank=True, default='')  # tutorial link
    due = models.DateField()
    interval = models.IntegerField(default=0)  # repeat every `interval` units after completion; 0 = one-off
    interval_unit = models.CharField(max_length=1, default='m')  # 'd' days, 'w' weeks, 'm' months (see repeat.py)
    priority = models.IntegerField(default=3)  # 1 Highest, 2 High, 3 Medium, 4 Low
    done_at = models.DateField(null=True, blank=True)  # set when status becomes 'done'
    spawned = models.IntegerField(default=0)  # 1 once this done task has produced its next occurrence
    room = models.CharField(max_length=20, blank=True, default='')  # a room id; '' = the project's room (rooms.py)

    class Meta:
        db_table = 'tasks'


class KeyValueStore(models.Model):
    k = models.CharField(max_length=255, primary_key=True)
    v = models.TextField()  # JSON text

    class Meta:
        db_table = 'kv'
