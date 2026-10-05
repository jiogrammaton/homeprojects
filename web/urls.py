from django.urls import path

from . import views

urlpatterns = [
    # Pages (the same shell; app.js draws the content)
    path('', views.page_view, {'page': 'home'}, name='home'),
    path('board/', views.page_view, {'page': 'board'}, name='board'),
    path('calendar/', views.page_view, {'page': 'cal'}, name='calendar'),
    path('stats/', views.page_view, {'page': 'stats'}, name='stats'),
    path('settings/', views.page_view, {'page': 'settings'}, name='settings'),
    path('settings/<str:tab>/', views.page_view, {'page': 'settings'}, name='settings_tab'),
    # JSON API (sign-in + CSRF token required; see web/CLAUDE.md for the full table)
    path('api/tasks', views.list_tasks, name='list_tasks'),
    path('api/tasks/new', views.save_task, name='create_task'),
    path('api/tasks/<int:task_id>', views.save_task, name='update_task'),
    path('api/tasks/<int:task_id>/del', views.delete_task, name='delete_task'),
    path('api/projects/del', views.delete_project, name='delete_project'),
    path('api/projects/rename', views.rename_project, name='rename_project'),
    path('api/reset', views.reset_all, name='reset_all'),
    path('api/backup', views.backup, name='backup'),
    path('api/restore', views.restore, name='restore'),
    path('api/import', views.import_csv, name='import_csv'),
    path('api/import/preview', views.import_preview, name='import_preview'),
    path('api/import/commit', views.import_commit, name='import_commit'),
    path('api/history/clear', views.clear_history, name='clear_history'),
    path('api/ranking', views.ranking, name='ranking'),
    path('api/settings', views.get_settings, name='get_settings'),
    path('api/settings/put', views.put_settings, name='put_settings'),
]
