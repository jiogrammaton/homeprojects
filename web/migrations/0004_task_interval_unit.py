"""Frequencies are labels again, and repeats can be in days or weeks.
Adds Task.interval_unit, then ties every task's repeat to a label: a task that already has a frequency label
(e.g. "weekly") repeats at that label's interval; a repeating task without one gets the label for its interval."""
from django.db import migrations, models
from web.repeat import freq_label, parse_freq


def forwards(apps, schema_editor):
    Task = apps.get_model('tasks', 'Task')
    for t in Task.objects.all():
        tags = [g for g in (t.tags or '').split(',') if g]
        freq = next((f for f in map(parse_freq, tags) if f), None)
        if freq:
            t.interval, t.interval_unit = freq
        elif t.interval > 0:
            tags.append(freq_label(t.interval, 'm'))
        else:
            continue
        t.tags = ','.join(tags)
        t.save(update_fields=['tags', 'interval', 'interval_unit'])


class Migration(migrations.Migration):
    dependencies = [('tasks', '0003_repeat_not_a_label')]
    operations = [
        migrations.AddField(model_name='task', name='interval_unit', field=models.CharField(default='m', max_length=1)),
        migrations.RunPython(forwards, migrations.RunPython.noop),
    ]
