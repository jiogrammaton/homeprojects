# web/templates/ — HTML templates

Django templates, found by name through `APP_DIRS` (no namespace folder: `render(request, 'home.html')`). The app pages are thin: the server renders the shell, and `static/app.js` draws everything inside `<main id="m">`.

## Files

| file | purpose |
|---|---|
| `base.html` | The app shell used by every app page. `<head>`: csrf `<meta name="csrf-token">` (app.js sends it as `X-CSRFToken`), `style.css?v=N`, `favicon.svg?v=N`. `<body data-view data-tab data-user>` tells app.js which page/tab it is. Top bar: brand · `.tabs` nav (Home, Board, Calendar, Stats, Settings; current one `.on` + `aria-current`) · `.tools` (filter `#q`, Import button → hidden `#f` file input → `imp()`, `+ New` → `edit()`, sign-out POST form). Then `<main id="m">`, and three dialogs: `#d` (task/project form: mode switch `#mt`/`#mp`, project fields `#pf` (`#pn #pp #pr #pc`), task fields `#tf` (`#p #tr #t #tp #s #lb #u` + date picker `#dp`, `#l #n`), `#qa-msg`, sticky `.formbtns`: Delete `#x`, Cancel, Save & add another `#addmore`, Save), `#cd` (confirm/notice used by `ask()`), `#iw` (CSV import wizard). Ends with `{{ default_map\|json_script:"map-default" }}` (the starter map from `web/rooms.py`) and `app.js?v=N`. |
| `home.html`, `board.html`, `calendar.html`, `stats.html`, `settings.html` | Two-line stubs: extend `base.html` and set the `<title>`. `views.PAGES` maps page keys (`home`, `board`, `cal`, `stats`, `settings`) to them. |
| `auth_base.html` | Standalone shell for the sign-in pages (no app.js, no top bar): centered `.authbox`, same `style.css?v=N` and favicon. |
| `login.html` | Sign-in form (extends `auth_base.html`). Shows `lockout` (set by `ThrottledLoginView` on 429) or a generic error. `enterkeyhint`, and an inline script: Enter on Username moves to Password. |
| `password_change.html` | Change-password form, and the `done` state (`extra_context={'done': True}` in `config/urls.py`). |

## Rules

- **Cache busting:** `base.html` and `auth_base.html` load `style.css?v=N`, `app.js?v=N`, `favicon.svg?v=N` (currently **41**). Bump N in both files on every CSS/JS change (`sed -i 's/?v=41/?v=42/g' web/templates/*.html`).
- Static URLs are `{% static 'app.js' %}` etc. (files sit directly in `web/static/`).
- Form help text goes behind `?` icons: `<span class="help" id="help-x" tabindex="-1" role="img" data-tip="…" aria-label="…">?</span>` inside the `<label>`, with `aria-describedby="help-x"` on the field. Keep `data-tip` and `aria-label` identical. Don't add `<p class="hint">` paragraphs (the user wants descriptions behind `?`).
- Every form must work with Tab alone. app.js handles focus wrapping, Enter-to-next-field, and the label chips/date picker keyboard.
- The mode buttons call `setMode(…);focusName()` so switching to Project/Task puts the cursor in the name field (and opens the phone keyboard).
