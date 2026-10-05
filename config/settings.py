"""Django settings for Home Projects.

Everything that differs between machines comes from environment variables, optionally kept in a .env file next to
manage.py (see .env.example for every DJANGO_* key). Defaults are safe for a home server: DEBUG off, sign-in
required everywhere, CSRF on every write. Sections: Environment · Core · Sign-in & security · Logging · Static files.
"""

import os
import secrets
import sys
from pathlib import Path

# Build paths inside the project like this: BASE_DIR / 'subdir'.
BASE_DIR = Path(__file__).resolve().parent.parent


# ---- Environment ----------------------------------------------------------
# Deployment settings come from environment variables. For convenience they can
# also live in a .env file next to manage.py (KEY=value per line, see .env.example).
# Real environment variables win over .env.


def _load_dotenv(path):
    if not path.exists():
        return
    for line in path.read_text().splitlines():
        line = line.strip()
        if not line or line.startswith('#') or '=' not in line:
            continue
        key, value = line.split('=', 1)
        os.environ.setdefault(key.strip(), value.strip().strip('"').strip("'"))


_load_dotenv(BASE_DIR / '.env')


def env(key, default=''):
    return os.environ.get(key, default)


def env_bool(key, default=False):
    return env(key, str(default)).strip().lower() in ('1', 'true', 'yes', 'on')


def env_list(key, default=''):
    return [x.strip() for x in env(key, default).split(',') if x.strip()]


def _secret_key():
    """DJANGO_SECRET_KEY if set; otherwise a random key generated once and kept in .secret_key (owner-only)."""
    if env('DJANGO_SECRET_KEY'):
        return env('DJANGO_SECRET_KEY')
    path = BASE_DIR / '.secret_key'
    if not path.exists():
        path.write_text(secrets.token_urlsafe(50))
        path.chmod(0o600)
    return path.read_text().strip()


# ---- Core -----------------------------------------------------------------

SECRET_KEY = _secret_key()

# Off unless explicitly turned on (DJANGO_DEBUG=1). Never enable on a server other devices can reach.
DEBUG = env_bool('DJANGO_DEBUG', False)

# Hostnames / IPs the app may be reached at, e.g. "192.168.1.50,homeserver.local"
ALLOWED_HOSTS = ['localhost', '127.0.0.1', '[::1]'] + env_list('DJANGO_ALLOWED_HOSTS')

# Needed only when served over HTTPS from another origin, e.g. "https://home.example.lan"
CSRF_TRUSTED_ORIGINS = env_list('DJANGO_CSRF_TRUSTED_ORIGINS')

# Application definition

INSTALLED_APPS = [
    'django.contrib.admin',
    'django.contrib.auth',
    'django.contrib.contenttypes',
    'django.contrib.sessions',
    'django.contrib.messages',
    'django.contrib.staticfiles',
    'web.apps.WebConfig',
]

MIDDLEWARE = [
    'django.middleware.security.SecurityMiddleware',
    'whitenoise.middleware.WhiteNoiseMiddleware',  # serves /static/ without a separate web server
    'django.contrib.sessions.middleware.SessionMiddleware',
    'django.middleware.common.CommonMiddleware',
    'django.middleware.csrf.CsrfViewMiddleware',
    'django.contrib.auth.middleware.AuthenticationMiddleware',
    'web.security.LoginRequiredMiddleware',  # every page and API call needs a signed-in user
    'django.contrib.messages.middleware.MessageMiddleware',
    'django.middleware.clickjacking.XFrameOptionsMiddleware',
    'web.security.AuditLogMiddleware',  # logs every data change (who, what, from where)
]

ROOT_URLCONF = 'config.urls'

TEMPLATES = [
    {
        'BACKEND': 'django.template.backends.django.DjangoTemplates',
        'DIRS': [],
        'APP_DIRS': True,
        'OPTIONS': {
            'context_processors': [
                'django.template.context_processors.debug',
                'django.template.context_processors.request',
                'django.contrib.auth.context_processors.auth',
                'django.contrib.messages.context_processors.messages',
            ],
        },
    },
]

WSGI_APPLICATION = 'config.wsgi.application'

# Database
# https://docs.djangoproject.com/en/dev/ref/settings/#databases

DATABASES = {
    'default': {
        'ENGINE': 'django.db.backends.sqlite3',
        'NAME': env('DJANGO_DB_PATH') or BASE_DIR / 'db.sqlite3',
        'OPTIONS': {'timeout': 20},  # wait for a lock instead of failing when two requests write at once
    }
}

# Shared between server worker processes (used for the login lockout counter)
CACHES = {
    'default': {
        'BACKEND': 'django.core.cache.backends.filebased.FileBasedCache',
        'LOCATION': BASE_DIR / '.cache',
    }
}

# Password validation
# https://docs.djangoproject.com/en/dev/ref/settings/#auth-password-validators

AUTH_PASSWORD_VALIDATORS = [
    {
        'NAME': 'django.contrib.auth.password_validation.UserAttributeSimilarityValidator',
    },
    {
        'NAME': 'django.contrib.auth.password_validation.MinimumLengthValidator',
        'OPTIONS': {'min_length': 10},
    },
    {
        'NAME': 'django.contrib.auth.password_validation.CommonPasswordValidator',
    },
    {
        'NAME': 'django.contrib.auth.password_validation.NumericPasswordValidator',
    },
]


# ---- Sign-in & security ----------------------------------------------------

LOGIN_URL = 'login'
LOGIN_REDIRECT_URL = 'home'
LOGOUT_REDIRECT_URL = 'login'

# Lock an IP address out of the login form after this many failed attempts...
LOGIN_MAX_ATTEMPTS = int(env('DJANGO_LOGIN_MAX_ATTEMPTS', '5'))
# ...for this many seconds
LOGIN_LOCKOUT_SECONDS = int(env('DJANGO_LOGIN_LOCKOUT_SECONDS', '900'))

SESSION_COOKIE_AGE = 60 * 60 * 24 * 14  # stay signed in for two weeks
SESSION_COOKIE_HTTPONLY = True
SESSION_COOKIE_SAMESITE = 'Lax'
CSRF_COOKIE_SAMESITE = 'Lax'
X_FRAME_OPTIONS = 'DENY'
SECURE_CONTENT_TYPE_NOSNIFF = True
SECURE_REFERRER_POLICY = 'same-origin'
SECURE_CROSS_ORIGIN_OPENER_POLICY = 'same-origin'

# Set DJANGO_HTTPS=1 once the app is behind an HTTPS reverse proxy (e.g. Caddy or nginx)
if env_bool('DJANGO_HTTPS'):
    SESSION_COOKIE_SECURE = True
    CSRF_COOKIE_SECURE = True
    SECURE_PROXY_SSL_HEADER = ('HTTP_X_FORWARDED_PROTO', 'https')
    SECURE_HSTS_SECONDS = int(env('DJANGO_HSTS_SECONDS', '0'))  # leave 0 unless the certificate is trusted everywhere

# Trust X-Forwarded-For for client IPs (logs + lockout) only when a reverse proxy sets it
TRUST_X_FORWARDED_FOR = env_bool('DJANGO_TRUST_X_FORWARDED_FOR', False)


# ---- Logging ---------------------------------------------------------------
# logs/app.log       data changes (audit trail) and server errors
# logs/security.log  sign-ins, failed sign-ins, lockouts, CSRF/host rejections

LOG_DIR = Path(env('DJANGO_LOG_DIR') or BASE_DIR / 'logs')
LOG_DIR.mkdir(parents=True, exist_ok=True)

LOGGING = {
    'version': 1,
    'disable_existing_loggers': False,
    'formatters': {
        'plain': {'format': '{asctime} {levelname:<7} {name}: {message}', 'style': '{'},
    },
    'handlers': {
        'console': {'class': 'logging.StreamHandler', 'formatter': 'plain'},
        'app_file': {
            'class': 'logging.handlers.RotatingFileHandler',
            'filename': LOG_DIR / 'app.log',
            'maxBytes': 5 * 1024 * 1024,
            'backupCount': 5,
            'formatter': 'plain',
            'encoding': 'utf-8',
        },
        'security_file': {
            'class': 'logging.handlers.RotatingFileHandler',
            'filename': LOG_DIR / 'security.log',
            'maxBytes': 5 * 1024 * 1024,
            'backupCount': 5,
            'formatter': 'plain',
            'encoding': 'utf-8',
        },
    },
    'loggers': {
        'web.audit': {'handlers': ['app_file', 'console'], 'level': 'INFO', 'propagate': False},
        'web.security': {'handlers': ['security_file', 'console'], 'level': 'INFO', 'propagate': False},
        'django.security': {'handlers': ['security_file', 'console'], 'level': 'WARNING', 'propagate': False},
        'django.request': {'handlers': ['app_file', 'console'], 'level': 'ERROR', 'propagate': False},
    },
}


# Internationalization
# https://docs.djangoproject.com/en/dev/topics/i18n/

LANGUAGE_CODE = 'en-us'

# Only affects stored timestamps; due dates use the server machine's own clock (date.today())
TIME_ZONE = env('DJANGO_TIME_ZONE', 'UTC')

USE_I18N = True

USE_TZ = True

# Static files (CSS, JavaScript, Images)
# https://docs.djangoproject.com/en/dev/howto/static-files/

# There is no STATIC_ROOT and no collectstatic step: whitenoise serves web/static/ straight from the app folder
# (WHITENOISE_USE_FINDERS). Templates add ?v=N to every static URL, so browsers fetch new copies after a change.
STATIC_URL = 'static/'
WHITENOISE_USE_FINDERS = True
# Under `manage.py runserver`, re-read CSS/JS on every request so edits show up without a restart.
# (Otherwise whitenoise indexes files at startup and can serve stale or cut-off copies of edited files.)
WHITENOISE_AUTOREFRESH = DEBUG or 'runserver' in sys.argv

# Default primary key field type
# https://docs.djangoproject.com/en/dev/ref/settings/#default-auto-field

DEFAULT_AUTO_FIELD = 'django.db.models.BigAutoField'
