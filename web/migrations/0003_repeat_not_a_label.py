"""Frequencies stop being labels: remove "Monthly", "Every 2-5 years", "2-5 years" etc. from every task's tags
(the task's interval already says how often it repeats) and from the label list in settings."""
import json
from django.db import migrations
from web.repeat import clean_settings, strip_repeat_tags


def forwards(apps, schema_editor):
    Task, KV = apps.get_model('tasks', 'Task'), apps.get_model('tasks', 'KeyValueStore')
    custom = set()
    kv = KV.objects.filter(k='settings').first()
    if kv:
        try:
            s = json.loads(kv.v)
        except ValueError:
            s = None
        if isinstance(s, dict):
            custom = clean_settings(s)
            kv.v = json.dumps(s)
            kv.save()
    for t in Task.objects.exclude(tags=''):
        tags = strip_repeat_tags(t.tags, custom)
        if tags != t.tags:
            t.tags = tags
            t.save(update_fields=['tags'])


class Migration(migrations.Migration):
    dependencies = [('tasks', '0002_task_room')]
    operations = [migrations.RunPython(forwards, migrations.RunPython.noop)]
