"""ASGI entry point. Not used today (production runs gunicorn with WSGI, see wsgi.py); kept for ASGI servers."""

import os

from django.core.asgi import get_asgi_application

os.environ.setdefault('DJANGO_SETTINGS_MODULE', 'config.settings')

application = get_asgi_application()
