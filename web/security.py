"""Sign-in enforcement, login lockout, and audit/security logging."""

import logging
import time

from django.conf import settings
from django.contrib.auth import middleware as auth_middleware
from django.contrib.auth.signals import user_logged_in, user_logged_out, user_login_failed
from django.contrib.auth.views import LoginView
from django.core.cache import cache
from django.dispatch import receiver
from django.http import JsonResponse

audit = logging.getLogger('web.audit')
security = logging.getLogger('web.security')


def client_ip(request):
    if getattr(settings, 'TRUST_X_FORWARDED_FOR', False):
        forwarded = request.META.get('HTTP_X_FORWARDED_FOR', '')
        if forwarded:
            return forwarded.split(',')[0].strip()
    return request.META.get('REMOTE_ADDR', '?')


def who(request):
    user = getattr(request, 'user', None)
    return user.get_username() if user is not None and user.is_authenticated else 'anonymous'


class LoginRequiredMiddleware(auth_middleware.LoginRequiredMiddleware):
    """Pages redirect to the login form; API calls get a 401 the front end can react to."""

    def handle_no_permission(self, request, view_func):
        if request.path.startswith('/api/'):
            return JsonResponse({'error': 'Sign in required'}, status=401)
        return super().handle_no_permission(request, view_func)


class AuditLogMiddleware:
    """One log line per data change: user, IP, method, path, status, duration."""

    def __init__(self, get_response):
        self.get_response = get_response

    def __call__(self, request):
        start = time.monotonic()
        response = self.get_response(request)
        if request.method not in ('GET', 'HEAD', 'OPTIONS') and request.path.startswith('/api/'):
            ms = (time.monotonic() - start) * 1000
            level = logging.INFO if response.status_code < 400 else logging.WARNING
            audit.log(
                level,
                '%s %s %s -> %s (%s, %.0f ms)',
                who(request),
                request.method,
                request.path,
                response.status_code,
                client_ip(request),
                ms,
            )
        return response


# ---- login lockout ----------------------------------------------------------


def _attempts_key(ip):
    return f'login-failures:{ip}'


def locked_out(ip):
    return cache.get(_attempts_key(ip), 0) >= settings.LOGIN_MAX_ATTEMPTS


class ThrottledLoginView(LoginView):
    """The normal login form, refusing further attempts from an IP that failed too often."""

    template_name = 'login.html'
    redirect_authenticated_user = True

    def post(self, request, *args, **kwargs):
        ip = client_ip(request)
        if locked_out(ip):
            security.warning(
                'Blocked login attempt from locked-out %s (username %r)', ip, request.POST.get('username', '')
            )
            minutes = max(1, settings.LOGIN_LOCKOUT_SECONDS // 60)
            # don't even check the password while locked out
            form = self.form_class(request=request, initial={'username': request.POST.get('username', '')})
            context = self.get_context_data(
                form=form, lockout=f'Too many failed sign-in attempts. Try again in {minutes} minutes.'
            )
            return self.render_to_response(context, status=429)
        return super().post(request, *args, **kwargs)


@receiver(user_login_failed)
def _on_login_failed(sender, credentials, request=None, **kwargs):
    if request is None:
        return
    ip = client_ip(request)
    key = _attempts_key(ip)
    n = cache.get(key, 0) + 1
    cache.set(key, n, settings.LOGIN_LOCKOUT_SECONDS)
    security.warning(
        'Failed sign-in for %r from %s (%d/%d)', credentials.get('username', ''), ip, n, settings.LOGIN_MAX_ATTEMPTS
    )
    if n == settings.LOGIN_MAX_ATTEMPTS:
        security.warning('Locked out %s for %d seconds', ip, settings.LOGIN_LOCKOUT_SECONDS)


@receiver(user_logged_in)
def _on_login(sender, request, user, **kwargs):
    if request is None:
        return
    cache.delete(_attempts_key(client_ip(request)))
    security.info('Signed in: %s from %s', user.get_username(), client_ip(request))


@receiver(user_logged_out)
def _on_logout(sender, request, user, **kwargs):
    if request is not None and user is not None:
        security.info('Signed out: %s from %s', user.get_username(), client_ip(request))
