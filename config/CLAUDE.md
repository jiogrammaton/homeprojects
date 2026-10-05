# config/ — the Django project package

Project-level wiring: settings, the top-level URL table, and the WSGI/ASGI entry points. App code lives in `web/`.

## Files

| file | purpose |
|---|---|
| `settings.py` | All settings, driven by environment variables / `.env` (see below). |
| `urls.py` | `admin/`, `login/` (`web.security.ThrottledLoginView`), `logout/` (POST only), `password/` and `password/done/` (Django's password-change views with `password_change.html`), then `include('web.urls')`. |
| `wsgi.py` | `application` for gunicorn (`deploy/home-projects.service` runs `config.wsgi:application`). `DJANGO_SETTINGS_MODULE='config.settings'` (it was wrongly `home.settings` until the first deploy dry run). |
| `asgi.py` | ASGI entry point; unused (kept for ASGI servers). |
| `__init__.py` | empty (package marker). |

## settings.py

Sections: Environment · Core · Sign-in & security · Logging · Static files.

- **Environment:** `_load_dotenv()` reads `.env` next to `manage.py` (real environment variables win). Helpers `env`, `env_bool`, `env_list`. Every key is documented in `.env.example`:
  `DJANGO_ALLOWED_HOSTS` (localhost/127.0.0.1/[::1] always allowed), `DJANGO_SECRET_KEY` (else generated once into `.secret_key`, chmod 600), `DJANGO_DEBUG` (default **off**), `DJANGO_HTTPS` (secure cookies + `SECURE_PROXY_SSL_HEADER` + optional `DJANGO_HSTS_SECONDS`), `DJANGO_CSRF_TRUSTED_ORIGINS`, `DJANGO_TRUST_X_FORWARDED_FOR`, `DJANGO_LOGIN_MAX_ATTEMPTS` (5), `DJANGO_LOGIN_LOCKOUT_SECONDS` (900), `DJANGO_DB_PATH` (default `db.sqlite3`), `DJANGO_LOG_DIR` (default `logs/`), `DJANGO_TIME_ZONE` (UTC; only affects stored timestamps, due dates use the machine clock).
- **Apps / middleware:** `INSTALLED_APPS` ends with `'web.apps.WebConfig'` (app label `tasks`, see the root CLAUDE.md). Middleware adds whitenoise (after SecurityMiddleware), `web.security.LoginRequiredMiddleware` (after auth) and `web.security.AuditLogMiddleware` (last).
- **Database:** SQLite with a 20 s lock timeout. **Cache:** file-based in `.cache/` so gunicorn's workers share the login-lockout counters and save keys.
- **Passwords:** min length 10 + Django's default validators. Sessions last 14 days; cookies HttpOnly/SameSite=Lax; `X_FRAME_OPTIONS=DENY`; nosniff; same-origin referrer and COOP.
- **Logging:** `web.audit` → `logs/app.log` (data changes, from `AuditLogMiddleware` and the views); `web.security` and `django.security` → `logs/security.log` (sign-ins, failures, lockouts, CSRF/host rejections); `django.request` errors → `app.log`. Rotating 5 MB × 5. `LOG_DIR` is created at startup. Tests call `logging.disable()`.
- **Static files:** `STATIC_URL='static/'`, **no `STATIC_ROOT`** and no collectstatic: `WHITENOISE_USE_FINDERS=True` serves `web/static/` directly in every environment. `WHITENOISE_AUTOREFRESH` is on under `runserver`/DEBUG so CSS/JS edits show without a restart. Browsers get fresh copies because templates add `?v=N`.

`check --deploy` on plain HTTP reports exactly 4 HTTPS-related warnings; that's expected until `DJANGO_HTTPS=1` behind Caddy.
