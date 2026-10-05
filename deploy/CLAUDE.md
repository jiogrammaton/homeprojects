# deploy/ — getting the app onto a server and keeping it updated

Shell scripts and config files for running Home Projects on a Linux server (Fedora/RHEL or Debian 13+/Ubuntu 24.04+) under systemd + gunicorn. The installer itself is `install.sh` at the project root. User-facing instructions: `DEPLOY.md`. The user's own server: `CLAUDE.local.md` (git-ignored).

## The public flow

```
git clone https://github.com/jiogrammaton/homeprojects.git
sudo bash homeprojects/install.sh [--dir PATH] [--user NAME] [--port N] [...]
sudo homeprojects start
```

Defaults `/opt/homeprojects`, `homeprojects`, `8000`. `install.sh` writes them to **`/etc/homeprojects.conf`** (`APP`, `APP_USER`, `PORT`, and `SOURCE` = the folder installed from, unless it was a push.sh upload), which `homeprojects` sources; a re-run of `install.sh` without options reuses it. With no conf file (servers from before Oct 2026) everything falls back to the defaults.

## Files

| file | runs where | purpose |
|---|---|---|
| `../install.sh` | server (root) | Idempotent install, 9 steps: packages (`dnf`/`apt-get`; finds python3.14…3.12 or python3 ≥3.12, tries `dnf install python3.12` on RHEL 9; dies with a clear message on Debian 12), the account (`useradd --system`, home = install folder; an existing account is reused), copy files (`rsync-exclude.txt`; an existing server DB is kept), venv + pip, `.env` from `.env.example` (allowed hosts = IPv4s + hostname + `hostname.local`), migrate, systemd unit (generated from `home-projects.service` by `sed`ing the folder, User/Group and port; old unit saved as `.bak` if it differed; restarted only if already running, otherwise left for `start`), firewall (firewalld/ufw), `/etc/homeprojects.conf` + `/usr/local/sbin/homeprojects`. Validates options: `--dir` absolute, `[A-Za-z0-9._/-]`, not a system folder (`/opt`, `/usr`, …), not under `/home`/`/root` (ProtectHome + SELinux), not a non-empty folder without `manage.py`; `--user` not root. `--help` prints the header. |
| `homeprojects.sh` | server (root) | Installed as root-owned `/usr/local/sbin/homeprojects`. `start` (createsuperuser if no accounts and a TTY, else dies; `enable --now`; waits ≤15 s for `/login/` 200; prints `http://<ip>:<port>/`), `stop`, `restart`, `status`, `logs` (journalctl -f), `adduser`, `manage ARGS` (manage.py as the app account), `update [DIR]`. **update:** DIR = arg, else `~$SUDO_USER/homeprojects-upload` if present, else `SOURCE`. 1/5 stop + back up DB to `backups/db-<stamp>.sqlite3`; 2/5 rsync with `rsync-exclude.txt` + `/db.sqlite3*` + `/backups/` excluded (a dev copy's DB/.env/venv never land), then mirror `CODE_DIRS` (`config deploy web`) with `--delete`; 3/5 pip; 4/5 migrate; 5/5 start (if it was running or enabled) + health check. ERR trap restarts the app. Then re-installs itself (`install` to `.new` + `mv`, so the running copy is unaffected), turns a legacy `/usr/local/sbin/homeprojects-update` file into a symlink (invoked under that name it acts as `update`, so old sudoers rules keep working), and deletes the upload folder (never a `SOURCE` clone). |
| `push.sh` | your computer | `push.sh user@host update` uploads to `~/homeprojects-upload/` (rsync `--delete`, `rsync-exclude.txt`, never the DB) and runs `sudo /usr/local/sbin/homeprojects update` (or, on a server without it, the uploaded `deploy/homeprojects.sh update`, which installs itself). `push.sh user@host install [--with-db] [-- install.sh opts]` uploads and runs `install.sh` then `homeprojects start`. Uses full paths because RHEL's sudo `secure_path` lacks `/usr/local/sbin`. |
| `rsync-exclude.txt` | both | Never copied to the server: `.git/`, `venv/`, `.cache/`, `logs/`, `__pycache__/`, tool caches, `.env`, `.secret_key`, backup JSON exports. |
| `home-projects.service` | template | systemd unit with the defaults (`/opt/homeprojects`, `homeprojects`, `0.0.0.0:8000`); `install.sh` substitutes the chosen values. gunicorn `config.wsgi:application`, `--workers 2`, `Restart=on-failure`, hardened (`ProtectSystem=strict`, `ProtectHome`, `PrivateTmp`, `NoNewPrivileges`, `ReadWritePaths=<folder>`). |
| `Caddyfile` | server | Optional HTTPS in front of gunicorn (`tls internal`); needs `DJANGO_HTTPS=1`, `DJANGO_CSRF_TRUSTED_ORIGINS`, `DJANGO_TRUST_X_FORWARDED_FOR=1`. |
| `Caddyfile.vm-host` | the VM's host computer | Plain-HTTP proxy `:8080` → the VM's `:8000`, for a VM on virt-manager's private NAT network. |

**Important:** the install folder is also the app account's home (`.bashrc`, `.gunicorn/`, `venv/`, `.env`, `.secret_key`, `db.sqlite3`, `backups/`, `logs/`, `.cache/`). Never `rsync --delete` into the whole folder; only into `CODE_DIRS`.

No `collectstatic` and no `staticfiles/`: whitenoise serves `web/static/` directly (`config/settings.py`).

## Testing deploy changes

- Test changes to how the app is served (settings, static files, WSGI) by copying the project with the exclude list into a scratch folder and running **gunicorn** there (not runserver, which hides WSGI/static problems).
- Test `install.sh` / `homeprojects.sh` in podman: a `fedora:44` image with `systemd` installed, run with `--systemd=always` (tests `start`, `update`, the unit file); `ubuntu:24.04` and `debian:12` with `--no-service --no-firewall`. Copy the project in with `rsync --exclude-from=deploy/rsync-exclude.txt --exclude=/db.sqlite3`. Interactive `start` needs a TTY: `script -qec "homeprojects start" /dev/null` (package `util-linux-script`).
