import json
import logging
from datetime import date, timedelta
from pathlib import Path

from dateutil.relativedelta import relativedelta
from django.contrib.auth.models import User
from django.core.cache import cache
from django.core.files.uploadedfile import SimpleUploadedFile
from django.test import Client, TestCase, override_settings

from .models import KeyValueStore, Task

logging.disable(logging.CRITICAL)  # keep test runs out of logs/app.log and logs/security.log

LOCMEM = {'default': {'BACKEND': 'django.core.cache.backends.locmem.LocMemCache'}}
FAST_HASH = ['django.contrib.auth.hashers.MD5PasswordHasher']  # tests only: real hashing is slow on purpose


@override_settings(CACHES=LOCMEM, PASSWORD_HASHERS=FAST_HASH)
class AuthedTestCase(TestCase):
    """Every page and API call needs a signed-in user."""

    def setUp(self):
        self.user = User.objects.create_user('tester', password='a-long-test-password')
        self.client.force_login(self.user)


class RecurringTests(AuthedTestCase):
    def setUp(self):
        super().setUp()
        # monthly task due today, so its next occurrence lands inside the 7-day spawn window
        self.t = Task.objects.create(project='HVAC', title='Change filter', due=date.today(), interval=1)
        self.t.done_at = None

    def put(self, task, **changes):
        body = {
            'project': task.project,
            'title': task.title,
            'status': task.status,
            'due': task.due.isoformat(),
            'interval': task.interval,
            'priority': task.priority,
        }
        body.update(changes)
        return self.client.put(f'/api/tasks/{task.pk}', json.dumps(body), content_type='application/json')

    def open_copies(self):
        return Task.objects.filter(title='Change filter').exclude(status='done').count()

    def backdate_completion(self):
        # pretend it was completed a month ago so the next occurrence is due now
        Task.objects.filter(pk=self.t.pk).update(done_at=date.today() - relativedelta(months=1), spawned=0)

    def test_complete_spawns_one_copy(self):
        self.backdate_completion()
        self.client.get('/api/tasks')
        self.assertEqual(self.open_copies(), 1)

    def test_reopen_and_complete_again_does_not_duplicate(self):
        self.backdate_completion()
        Task.objects.filter(pk=self.t.pk).update(status='done')
        self.client.get('/api/tasks')
        self.t.refresh_from_db()
        self.assertEqual(self.open_copies(), 1)

        self.put(self.t, status='doing')  # reopen: untouched successor is removed
        self.assertEqual(self.open_copies(), 1)  # just the reopened task
        self.t.refresh_from_db()
        self.put(self.t, status='done')  # complete again (today -> next copy not due yet)
        self.client.get('/api/tasks')
        self.assertEqual(self.open_copies(), 0)
        self.backdate_completion()  # a month later: exactly one fresh copy
        self.client.get('/api/tasks')
        self.client.get('/api/tasks')
        self.assertEqual(self.open_copies(), 1)

    def test_reopen_keeps_touched_successor_and_no_duplicate(self):
        self.backdate_completion()
        Task.objects.filter(pk=self.t.pk).update(status='done')
        self.client.get('/api/tasks')
        Task.objects.exclude(pk=self.t.pk).update(status='doing')  # user already started the next copy
        self.t.refresh_from_db()
        self.put(self.t, status='backlog')
        self.t.refresh_from_db()
        self.put(self.t, status='done')
        self.backdate_completion()
        self.client.get('/api/tasks')
        self.assertEqual(self.open_copies(), 1)  # only the copy the user is working on

    def test_spawn_skips_when_open_copy_exists(self):
        self.backdate_completion()
        Task.objects.filter(pk=self.t.pk).update(status='done')
        Task.objects.create(project='HVAC', title='Change filter', due=date.today() + timedelta(days=3), interval=1)
        self.client.get('/api/tasks')
        self.assertEqual(self.open_copies(), 1)
        self.t.refresh_from_db()
        self.assertEqual(self.t.spawned, 1)


class DeleteProjectTests(AuthedTestCase):
    def test_deletes_tasks_and_settings(self):
        Task.objects.create(project='Kitchen', title='Paint', due=date.today())
        Task.objects.create(project='Kitchen', title='Tile', due=date.today())
        Task.objects.create(project='Garage', title='Sweep', due=date.today())
        KeyValueStore.objects.create(
            k='settings',
            v=json.dumps(
                {
                    'projects': {'Kitchen': 1, 'Garage': 2},
                    'pcolors': {'Kitchen': '#fff', 'Garage': '#000'},
                    'projectNames': ['Kitchen', 'Garage'],
                    'labels': ['x'],
                    'rooms': {'Kitchen': 'kitchen', 'Garage': 'garage'},
                    'porder': ['Garage', 'Kitchen'],
                }
            ),
        )
        r = self.client.delete('/api/projects/del', json.dumps({'project': 'Kitchen'}), content_type='application/json')
        self.assertEqual(r.status_code, 200)
        self.assertEqual(list(Task.objects.values_list('project', flat=True)), ['Garage'])
        st = json.loads(KeyValueStore.objects.get(pk='settings').v)
        self.assertEqual(st['projects'], {'Garage': 2})
        self.assertEqual(st['pcolors'], {'Garage': '#000'})
        self.assertEqual(st['projectNames'], ['Garage'])
        self.assertEqual(st['labels'], ['x'])
        self.assertEqual(st['rooms'], {'Garage': 'garage'})
        self.assertEqual(st['porder'], ['Garage'])


class PageTests(AuthedTestCase):
    def test_each_section_is_its_own_page(self):
        for url, view in [
            ('/', 'home'),
            ('/board/', 'board'),
            ('/calendar/', 'cal'),
            ('/stats/', 'stats'),
            ('/settings/', 'settings'),
            ('/settings/projects/', 'settings'),
            ('/settings/misc/', 'settings'),
        ]:
            r = self.client.get(url)
            self.assertEqual(r.status_code, 200, url)
            self.assertContains(r, f'data-view="{view}"')
        self.assertContains(self.client.get('/settings/tasks/'), 'data-tab="tasks"')
        self.assertContains(self.client.get('/settings/sched/'), 'data-tab="tasks"')  # old link still works
        self.assertContains(self.client.get('/settings/'), 'data-tab="projects"')  # first tab by default
        self.assertEqual(self.client.get('/settings/bogus/').status_code, 404)


class DuplicateTests(AuthedTestCase):
    def post(self, **body):
        body.setdefault('due', date.today().isoformat())
        return self.client.post('/api/tasks/new', json.dumps(body), content_type='application/json')

    def test_same_open_task_in_same_project_is_rejected(self):
        self.assertEqual(self.post(project='Kitchen', title='Paint').status_code, 200)
        r = self.post(project='kitchen', title='  paint ')
        self.assertEqual(r.status_code, 409)
        self.assertIn('error', r.json())
        self.assertEqual(Task.objects.count(), 1)

    def test_repeated_save_key_is_not_an_error(self):
        # a phone resending the same save (slow link, extra taps) gets ok, and only one task is made
        self.assertEqual(self.post(project='Kitchen', title='Grout', save_key='k1').status_code, 200)
        r = self.post(project='Kitchen', title='Grout', save_key='k1')
        self.assertEqual(r.status_code, 200)
        self.assertTrue(r.json().get('repeat'))
        self.assertEqual(Task.objects.filter(title='Grout').count(), 1)
        # a different save of the same open task is still a duplicate
        self.assertEqual(self.post(project='Kitchen', title='Grout', save_key='k2').status_code, 409)

    def test_same_title_elsewhere_or_after_done_is_allowed(self):
        self.post(project='Kitchen', title='Paint', status='done')
        self.assertEqual(self.post(project='Kitchen', title='Paint').status_code, 200)  # done copy is history
        self.assertEqual(self.post(project='Garage', title='Paint').status_code, 200)  # different project
        self.assertEqual(Task.objects.count(), 3)

    def test_project_name_reuses_existing_spelling(self):
        self.post(project='Kitchen', title='Paint')
        self.post(project='kitchen', title='Tile')
        self.assertEqual(set(Task.objects.values_list('project', flat=True)), {'Kitchen'})

    def test_rename_into_duplicate_is_rejected_but_status_change_is_not(self):
        a = Task.objects.create(project='Kitchen', title='Paint', due=date.today())
        b = Task.objects.create(project='Kitchen', title='Tile', due=date.today())
        body = {'project': 'Kitchen', 'title': 'PAINT', 'status': 'backlog', 'due': b.due.isoformat()}
        r = self.client.put(f'/api/tasks/{b.pk}', json.dumps(body), content_type='application/json')
        self.assertEqual(r.status_code, 409)
        b.refresh_from_db()
        self.assertEqual(b.title, 'Tile')
        body = {'project': 'Kitchen', 'title': 'Paint', 'status': 'doing', 'due': a.due.isoformat()}
        r = self.client.put(f'/api/tasks/{a.pk}', json.dumps(body), content_type='application/json')
        self.assertEqual(r.status_code, 200)


class ResetTests(AuthedTestCase):
    def test_reset_removes_tasks_and_projects_but_keeps_labels(self):
        Task.objects.create(project='Kitchen', title='Paint', due=date.today())
        KeyValueStore.objects.create(
            k='settings',
            v=json.dumps(
                {
                    'projects': {'Kitchen': 1},
                    'pcolors': {'Kitchen': '#fff'},
                    'projectNames': ['Empty'],
                    'labels': ['x'],
                    'colors': {'x': '#000'},
                }
            ),
        )
        self.assertEqual(self.client.get('/api/reset').status_code, 405)
        r = self.client.delete('/api/reset')
        self.assertEqual(r.status_code, 200)
        self.assertEqual(Task.objects.count(), 0)
        st = json.loads(KeyValueStore.objects.get(pk='settings').v)
        self.assertEqual((st['projects'], st['pcolors'], st['projectNames']), ({}, {}, []))
        self.assertEqual((st['labels'], st['colors']), (['x'], {'x': '#000'}))


class ImportTests(AuthedTestCase):
    def upload(self, text):
        f = SimpleUploadedFile('s.csv', text.encode('utf-8'), content_type='text/csv')
        return self.client.post('/api/import', {'file': f}).json()['imported']

    def test_bundled_schedule_imports_once(self):
        text = (Path(__file__).resolve().parent.parent / 'home_maintenance_schedule.csv').read_text(
            encoding='utf-8-sig'
        )
        n = self.upload(text)
        self.assertEqual(n, Task.objects.count())
        self.assertGreater(n, 50)
        self.assertEqual(self.upload(text), 0)  # re-import skips everything

    def test_last_done_sets_next_due(self):
        head = 'Task,Area,Frequency,Interval (Months),Timing,Notes,Tutorial URL,Last Done,Next Due\n'
        self.upload(head + 'Filter,HVAC,Quarterly,3,Any,,,2026-01-15,\n')
        self.assertEqual(Task.objects.get().due, date(2026, 4, 15))

    def test_frequency_becomes_a_label(self):
        head = 'Task,Area,Frequency,Interval (Months),Timing\n'
        self.upload(head + 'Filter,HVAC,Quarterly,3,Spring\nTrash,Kitchen,Weekly,,Any\nRoof,Exterior,,48,Any\n')
        got = sorted(Task.objects.values_list('title', 'tags', 'interval', 'interval_unit'))
        self.assertEqual(
            got,
            [('Filter', 'Quarterly,Spring', 3, 'm'), ('Roof', 'Every 4 years', 48, 'm'), ('Trash', 'Weekly', 1, 'w')],
        )


class WeeklyRepeatTests(AuthedTestCase):
    def test_weekly_task_comes_back_a_week_after_its_done(self):
        t = Task.objects.create(
            project='Kitchen', title='Trash', tags='weekly', due=date.today(), interval=1, interval_unit='w'
        )
        r = self.client.put(
            f'/api/tasks/{t.pk}',
            json.dumps(
                {
                    'title': 'Trash',
                    'project': 'Kitchen',
                    'status': 'done',
                    'tags': 'weekly',
                    'due': date.today().isoformat(),
                    'interval': 1,
                    'interval_unit': 'w',
                }
            ),
            content_type='application/json',
        )
        self.assertEqual(r.status_code, 200)
        nxt = Task.objects.get(status='backlog')
        self.assertEqual((nxt.due, nxt.interval_unit, nxt.tags), (date.today() + timedelta(weeks=1), 'w', 'weekly'))

    def test_bad_unit_is_refused(self):
        r = self.client.post(
            '/api/tasks/new',
            json.dumps({'title': 'X', 'interval': 1, 'interval_unit': 'y'}),
            content_type='application/json',
        )
        self.assertEqual(r.status_code, 400)


class SpawnWindowTests(AuthedTestCase):
    def test_spawn_days_setting_controls_when_next_copy_appears(self):
        Task.objects.create(
            project='HVAC',
            title='Filter',
            due=date.today(),
            interval=1,
            status='done',
            done_at=date.today() - relativedelta(months=1) + timedelta(days=20),
        )  # next due in 20 days
        self.client.get('/api/tasks')
        self.assertEqual(Task.objects.count(), 1)  # default 7-day window: not yet
        KeyValueStore.objects.create(k='settings', v=json.dumps({'spawnDays': 30}))
        self.client.get('/api/tasks')
        self.assertEqual(Task.objects.exclude(status='done').count(), 1)


class BackupTests(AuthedTestCase):
    def test_backup_then_restore_round_trips(self):
        Task.objects.create(
            project='Kitchen', title='Paint', due=date(2026, 5, 1), status='done', done_at=date(2026, 5, 2), spawned=1
        )
        KeyValueStore.objects.create(k='settings', v=json.dumps({'labels': ['x']}))
        r = self.client.get('/api/backup')
        self.assertIn('attachment', r['Content-Disposition'])
        payload = r.content
        Task.objects.all().delete()
        KeyValueStore.objects.all().delete()
        Task.objects.create(project='Junk', title='Gone soon', due=date.today())

        f = SimpleUploadedFile('b.json', payload, content_type='application/json')
        r = self.client.post('/api/restore', {'file': f})
        self.assertEqual(r.json()['restored'], 1)
        t = Task.objects.get()
        self.assertEqual((t.title, t.status, t.done_at, t.spawned), ('Paint', 'done', date(2026, 5, 2), 1))
        self.assertEqual(json.loads(KeyValueStore.objects.get(pk='settings').v), {'labels': ['x']})

    def test_bad_backup_changes_nothing(self):
        Task.objects.create(project='Kitchen', title='Paint', due=date.today())
        f = SimpleUploadedFile('b.json', b'{"app": "something-else"}', content_type='application/json')
        r = self.client.post('/api/restore', {'file': f})
        self.assertEqual(r.status_code, 400)
        self.assertEqual(Task.objects.count(), 1)


@override_settings(CACHES=LOCMEM, PASSWORD_HASHERS=FAST_HASH, LOGIN_MAX_ATTEMPTS=3)
class SecurityTests(TestCase):
    def setUp(self):
        cache.clear()  # lockout counters live in the cache
        User.objects.create_user('owner', password='a-long-test-password')

    def test_pages_redirect_and_api_refuses_when_signed_out(self):
        r = self.client.get('/board/')
        self.assertEqual(r.status_code, 302)
        self.assertTrue(r['Location'].startswith('/login/'))
        self.assertEqual(self.client.get('/api/tasks').status_code, 401)
        self.assertEqual(self.client.get('/login/').status_code, 200)

    def test_sign_in_and_out(self):
        r = self.client.post('/login/', {'username': 'owner', 'password': 'a-long-test-password'})
        self.assertEqual(r.status_code, 302)
        self.assertEqual(self.client.get('/api/tasks').status_code, 200)
        self.client.post('/logout/')
        self.assertEqual(self.client.get('/api/tasks').status_code, 401)

    def test_lockout_after_repeated_failures(self):
        for _ in range(3):
            self.assertEqual(self.client.post('/login/', {'username': 'owner', 'password': 'wrong'}).status_code, 200)
        r = self.client.post('/login/', {'username': 'owner', 'password': 'a-long-test-password'})
        self.assertEqual(r.status_code, 429)  # even the right password is refused while locked
        self.assertEqual(self.client.get('/api/tasks').status_code, 401)

    def test_api_writes_require_csrf_token(self):
        c = Client(enforce_csrf_checks=True)
        c.force_login(User.objects.get())
        body = json.dumps({'project': 'Kitchen', 'title': 'Paint'})
        self.assertEqual(c.post('/api/tasks/new', body, content_type='application/json').status_code, 403)
        c.get('/board/')  # page render sets the CSRF cookie
        token = c.cookies['csrftoken'].value
        r = c.post('/api/tasks/new', body, content_type='application/json', HTTP_X_CSRFTOKEN=token)
        self.assertEqual(r.status_code, 200)


class ImportWizardTests(AuthedTestCase):
    HEAD = 'Task,Area,Room,Frequency,Interval (Months),Timing,Notes,Tutorial URL,Last Done,Next Due\n'

    def preview(self, text):
        f = SimpleUploadedFile('s.csv', text.encode('utf-8'), content_type='text/csv')
        return self.client.post('/api/import/preview', {'file': f})

    def test_preview_flags_gaps_without_saving(self):
        r = self.preview(
            self.HEAD + ',Kitchen,,Monthly,1,Any,,,,\n'  # no task name -> error
            'Sweep,,Attic,Quarterly,,Any,,,,\n'  # no area, unknown room, interval from Frequency, no due
            'Paint,Kitchen,laundry,Every 2 years,,Any,,,,3/15/2027\n'  # alias room, US date
            '\n'
        )
        self.assertEqual(r.status_code, 200)
        rows = r.json()['rows']
        self.assertEqual(len(rows), 3)  # blank line ignored
        self.assertEqual(Task.objects.count(), 0)
        levels = lambda row: {(i['field'], i['level']) for i in row['issues']}
        self.assertIn(('title', 'error'), levels(rows[0]))
        self.assertEqual(levels(rows[1]), {('project', 'warn'), ('room', 'warn'), ('due', 'warn')})
        self.assertEqual((rows[1]['interval'], rows[1]['room']), (3, ''))
        self.assertEqual((rows[2]['room'], rows[2]['interval'], rows[2]['due']), ('basement', 24, '2027-03-15'))
        self.assertEqual(rows[2]['issues'], [])

    def test_missing_columns_are_reported_not_rejected(self):
        r = self.preview('Task\nSweep\n')
        self.assertEqual(r.status_code, 200)
        self.assertIn('Room', r.json()['columns_missing'])
        self.assertEqual(self.preview('foo,bar\n1,2\n').status_code, 400)  # nothing recognizable

    def test_commit_saves_fixed_rows_and_skips_existing(self):
        Task.objects.create(project='Kitchen', title='Paint', due=date.today())
        rows = [
            {
                'title': 'Sweep',
                'project': '',
                'room': 'garage',
                'tags': 'Quarterly',
                'interval': 3,
                'due': '2027-01-01',
            },
            {'title': 'paint', 'project': 'Kitchen', 'due': '2027-01-01'},
            {'title': 'Mop', 'project': 'Kitchen', 'due': 'soon'},
        ]
        r = self.client.post('/api/import/commit', json.dumps({'rows': rows}), content_type='application/json').json()
        self.assertEqual(r['imported'], 1)
        self.assertEqual([s['reason'] for s in r['skipped']], ['Already in the app', 'No valid due date'])
        t = Task.objects.get(title='Sweep')
        self.assertEqual((t.project, t.room, t.interval), ('General', 'garage', 3))


class TaskRoomTests(AuthedTestCase):
    def test_task_room_saved_validated_and_kept_by_next_copy(self):
        body = {
            'project': 'Safety',
            'title': 'Test sump pump',
            'due': date.today().isoformat(),
            'room': 'Basement',
            'interval': 1,
        }
        self.client.post('/api/tasks/new', json.dumps(body), content_type='application/json')
        t = Task.objects.get()
        self.assertEqual(t.room, 'basement')
        self.assertEqual(self.client.get('/api/tasks').json()[0]['room'], 'basement')
        body.update(room='moon base', status='done')
        self.client.put(f'/api/tasks/{t.pk}', json.dumps(body), content_type='application/json')
        t.refresh_from_db()
        self.assertEqual(t.room, '')  # unknown room -> project's room
        Task.objects.filter(pk=t.pk).update(room='basement', done_at=date.today() - relativedelta(months=1))
        self.client.get('/api/tasks')
        self.assertEqual(Task.objects.exclude(status='done').get().room, 'basement')


class ClearHistoryTests(AuthedTestCase):
    def test_clears_only_old_finished_history(self):
        old = date.today() - timedelta(days=400)
        Task.objects.create(project='A', title='old one-off', due=old, status='done', done_at=old)
        Task.objects.create(
            project='A',
            title='old recurring, next copy made',
            due=old,
            status='done',
            done_at=old,
            interval=1,
            spawned=1,
        )
        Task.objects.create(
            project='A', title='old recurring, next copy pending', due=old, status='done', done_at=old, interval=24
        )
        Task.objects.create(project='A', title='recent', due=date.today(), status='done', done_at=date.today())
        Task.objects.create(project='A', title='open', due=old)
        r = self.client.post('/api/history/clear', json.dumps({'days': 365}), content_type='application/json')
        self.assertEqual(r.json()['deleted'], 2)
        self.assertEqual(
            set(Task.objects.values_list('title', flat=True)), {'old recurring, next copy pending', 'recent', 'open'}
        )
        self.assertEqual(
            self.client.post('/api/history/clear', '{"days": 5}', content_type='application/json').status_code, 400
        )


class RenameProjectTests(AuthedTestCase):
    def rename(self, old, new):
        return self.client.post(
            '/api/projects/rename', json.dumps({'old': old, 'new': new}), content_type='application/json'
        )

    def test_rename_moves_tasks_and_settings(self):
        Task.objects.create(project='Kitchen', title='Paint', due=date.today())
        Task.objects.create(project='Garage', title='Sweep', due=date.today())
        KeyValueStore.objects.create(
            k='settings',
            v=json.dumps(
                {
                    'projects': {'Kitchen': 1},
                    'pcolors': {'Kitchen': '#fff'},
                    'rooms': {'Kitchen': 'kitchen'},
                    'projectNames': ['Kitchen', 'Empty'],
                    'porder': ['Garage', 'Kitchen'],
                }
            ),
        )
        r = self.rename('Kitchen', '  Kitchen   remodel ')
        self.assertEqual(r.json()['renamed'], 1)
        self.assertEqual(Task.objects.get(title='Paint').project, 'Kitchen remodel')
        st = json.loads(KeyValueStore.objects.get(pk='settings').v)
        self.assertEqual(
            (st['projects'], st['pcolors'], st['rooms']),
            ({'Kitchen remodel': 1}, {'Kitchen remodel': '#fff'}, {'Kitchen remodel': 'kitchen'}),
        )
        self.assertEqual(
            (st['projectNames'], st['porder']), (['Kitchen remodel', 'Empty'], ['Garage', 'Kitchen remodel'])
        )

    def test_rename_refuses_existing_name_but_allows_case_change(self):
        Task.objects.create(project='Kitchen', title='Paint', due=date.today())
        Task.objects.create(project='Garage', title='Sweep', due=date.today())
        KeyValueStore.objects.create(k='settings', v=json.dumps({'projectNames': ['Empty']}))
        self.assertEqual(self.rename('Kitchen', 'garage').status_code, 409)
        self.assertEqual(self.rename('Kitchen', 'empty').status_code, 409)
        self.assertEqual(self.rename('Kitchen', 'KITCHEN').status_code, 200)
        self.assertEqual(Task.objects.get(title='Paint').project, 'KITCHEN')


class CustomMapTests(AuthedTestCase):
    """Rooms come from the user's own map (settings 'map'), not a fixed list."""

    def setUp(self):
        super().setUp()
        KeyValueStore.objects.create(
            k='settings',
            v=json.dumps(
                {
                    'map': {
                        'floors': [{'id': 'main', 'name': 'Main'}],
                        'ground': 'main',
                        'rooms': [
                            {
                                'id': 'rgame1',
                                'name': 'Game room',
                                'emoji': '🎮',
                                'floor': 'main',
                                'x': 90,
                                'y': 80,
                                'w': 200,
                                'h': 150,
                            },
                            {
                                'id': 'rstair1',
                                'kind': 'stairs',
                                'name': 'Stairs',
                                'floor': 'main',
                                'to': 'upper',
                                'x': 300,
                                'y': 80,
                                'w': 60,
                                'h': 120,
                            },
                            {
                                'id': 'rblock1',
                                'kind': 'blocked',
                                'name': 'Over garage',
                                'floor': 'main',
                                'x': 400,
                                'y': 80,
                                'w': 100,
                                'h': 100,
                            },
                        ],
                    }
                }
            ),
        )

    def save(self, room):
        body = {'project': 'Fun', 'title': f'Task {room}', 'due': date.today().isoformat(), 'room': room}
        self.client.post('/api/tasks/new', json.dumps(body), content_type='application/json')
        return Task.objects.get(title=f'Task {room}').room

    def test_task_rooms_follow_the_map(self):
        self.assertEqual(self.save('rgame1'), 'rgame1')
        self.assertEqual(self.save('Game Room'), 'rgame1')  # by name, any case
        self.assertEqual(self.save('kitchen'), '')  # starter room no longer on this map
        self.assertEqual(self.save('yard'), 'yard')  # built-ins always exist
        self.assertEqual(self.save('rstair1'), '')  # stairs are drawn on the map but aren't a room
        self.assertEqual(self.save('Stairs'), '')
        self.assertEqual(self.save('rblock1'), '')  # blocked-off areas aren't rooms either
        self.assertEqual(self.save('Over garage'), '')

    def test_csv_room_matches_custom_names(self):
        f = SimpleUploadedFile('s.csv', b'Task,Room\nTune piano,game room\nMop,Kitchen\n', content_type='text/csv')
        rows = self.client.post('/api/import/preview', {'file': f}).json()['rows']
        self.assertEqual(rows[0]['room'], 'rgame1')
        self.assertEqual(rows[1]['room'], '')
        self.assertIn('room', [i['field'] for i in rows[1]['issues']])  # flagged: not on this map


class OutsideMapTests(AuthedTestCase):
    """The Outside tab: structures are rooms, trees aren't, the yard can be renamed."""

    def put_map(self, m):
        self.client.put('/api/settings/put', data=json.dumps({'map': m}), content_type='application/json')

    def test_starter_map_has_outside_yards(self):
        from .rooms import DEFAULT_MAP, all_rooms

        self.assertIn('outside', [f['id'] for f in DEFAULT_MAP['floors']])
        ids = [r[0] for r in all_rooms()]
        self.assertIn('backyard', ids)
        self.assertIn('frontyard', ids)

    def test_structures_are_rooms_trees_are_not(self):
        from .rooms import all_rooms, match_room

        self.put_map(
            {
                'floors': [{'id': 'main', 'name': 'Main'}, {'id': 'outside', 'name': 'Outside'}],
                'ground': 'main',
                'yard': {'name': 'Grounds', 'emoji': '🌱'},
                'rooms': [
                    {'id': 'k', 'name': 'Kitchen', 'floor': 'main', 'x': 0, 'y': 0, 'w': 100, 'h': 100},
                    {
                        'id': 'shed',
                        'kind': 'structure',
                        'name': 'Shed',
                        'floor': 'outside',
                        'x': -200,
                        'y': 0,
                        'w': 80,
                        'h': 60,
                    },
                    {
                        'id': 'oak',
                        'kind': 'tree',
                        'name': 'Oak',
                        'floor': 'outside',
                        'x': 300,
                        'y': 0,
                        'w': 80,
                        'h': 80,
                    },
                ],
            }
        )
        rooms = dict((r[0], r[1]) for r in all_rooms())
        self.assertIn('shed', rooms)
        self.assertNotIn('oak', rooms)
        self.assertEqual(rooms['yard'], 'Grounds')
        self.assertEqual(match_room('Shed'), 'shed')
        self.assertEqual(match_room('Grounds'), 'yard')
        res = self.client.post(
            '/api/tasks/new',
            data=json.dumps({'project': 'Yard', 'title': 'Paint shed', 'due': '2027-01-01', 'room': 'shed'}),
            content_type='application/json',
        )
        self.assertEqual(res.status_code, 200)
        self.assertEqual(Task.objects.get(title='Paint shed').room, 'shed')


class RankingTests(AuthedTestCase):
    def test_tier_boundaries(self):
        from .ranking import tier

        expect = {
            0: 'perfect',
            1: 'thriving',
            3: 'thriving',
            4: 'livable',
            6: 'livable',
            7: 'neutral',
            10: 'neutral',
            11: 'slacking',
            20: 'slacking',
            21: 'neglected',
            400: 'neglected',
        }
        for n, key in expect.items():
            self.assertEqual(tier(n)['tier'], key, n)
        self.assertEqual(tier(0)['rank'], 'Perfect')

    def test_api_ranks_rooms_projects_and_home(self):
        KeyValueStore.objects.create(k='settings', v=json.dumps({'rooms': {'Upkeep': 'garage'}}))
        today = date.today()
        for i in range(12):
            Task.objects.create(project='Kitchen remodel', title=f'k{i}', due=today)  # guessed: kitchen
        Task.objects.create(project='Upkeep', title='oil', due=today - timedelta(days=3))  # stored: garage, overdue
        Task.objects.create(project='Upkeep', title='bath fan', due=today, room='bath')  # own room
        Task.objects.create(project='Upkeep', title='doing', due=today, status='doing')
        Task.objects.create(project='Upkeep', title='old', due=today, status='done')
        r = self.client.get('/api/ranking')
        self.assertEqual(r.status_code, 200)
        data = r.json()
        rooms = {x['id']: x for x in data['rooms']}
        self.assertEqual((rooms['kitchen']['todo'], rooms['kitchen']['tier']), (12, 'slacking'))
        self.assertEqual((rooms['garage']['todo'], rooms['garage']['overdue'], rooms['garage']['doing']), (1, 1, 1))
        self.assertEqual(rooms['garage']['tier'], 'thriving')
        self.assertEqual(rooms['bath']['todo'], 1)
        self.assertEqual(rooms['office']['tier'], 'perfect')  # no tasks = the goal
        self.assertEqual(data['rooms'][0]['id'], 'kitchen')  # most ToDo first
        self.assertEqual((data['home']['todo'], data['home']['tier']), (14, 'slacking'))
        self.assertEqual({p['name']: p['todo'] for p in data['projects']}, {'Kitchen remodel': 12, 'Upkeep': 2})
        self.assertEqual(sum(data['summary'].values()), len(data['rooms']))
        self.assertEqual(
            [t['tier'] for t in data['tiers']], ['perfect', 'thriving', 'livable', 'neutral', 'slacking', 'neglected']
        )
        main = next(f for f in data['floors'] if f['id'] == 'main')
        self.assertEqual(main['todo'], 14)

    def test_needs_sign_in_and_get(self):
        self.assertEqual(self.client.post('/api/ranking').status_code, 405)
        self.client.logout()
        self.assertEqual(self.client.get('/api/ranking').status_code, 401)
