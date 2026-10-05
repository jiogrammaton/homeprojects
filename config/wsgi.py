"""WSGI entry point, used by gunicorn in production (deploy/home-projects.service: `config.wsgi:application`)."""

import os

from django.core.wsgi import get_wsgi_application

os.environ.setdefault('DJANGO_SETTINGS_MODULE', 'config.settings')

application = get_wsgi_application()
