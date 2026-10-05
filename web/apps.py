from django.apps import AppConfig


class WebConfig(AppConfig):
    """The Home Projects app: pages, JSON API, map/rooms, ranking and sign-in security.

    The Python package is `web`, but the app label stays 'tasks' (its name before the folder was renamed):
    the database's migration history (django_migrations) and permissions are recorded under that label,
    and keeping it means existing databases need no changes.
    """

    name = 'web'
    label = 'tasks'
    verbose_name = 'Home Projects'

    def ready(self):
        from . import security  # noqa: F401  (connects the sign-in logging/lockout signal handlers)
