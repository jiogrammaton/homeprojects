from django.contrib import admin
from django.contrib.auth import views as auth_views
from django.urls import include, path, reverse_lazy

from web.security import ThrottledLoginView

urlpatterns = [
    path('admin/', admin.site.urls),
    path('login/', ThrottledLoginView.as_view(), name='login'),
    path('logout/', auth_views.LogoutView.as_view(), name='logout'),
    path(
        'password/',
        auth_views.PasswordChangeView.as_view(
            template_name='password_change.html', success_url=reverse_lazy('password_change_done')
        ),
        name='password_change',
    ),
    path(
        'password/done/',
        auth_views.PasswordChangeDoneView.as_view(template_name='password_change.html', extra_context={'done': True}),
        name='password_change_done',
    ),
    path('', include('web.urls')),
]
