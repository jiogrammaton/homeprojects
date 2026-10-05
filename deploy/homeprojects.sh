#!/bin/bash
# The `homeprojects` command: installed by install.sh as root-owned /usr/local/sbin/homeprojects.
#
#   sudo homeprojects start            Create the first sign-in account if there is none, start the app, show its address
#   sudo homeprojects stop | restart   Stop / restart the app
#   sudo homeprojects status           Is it running, and where to open it
#   sudo homeprojects logs             Follow the server log (Ctrl+C to stop)
#   sudo homeprojects update [DIR]     Back up the database, install new code from DIR, migrate, restart.
#                                      DIR defaults to ~/homeprojects-upload (from deploy/push.sh) if it exists,
#                                      otherwise the folder you installed from (e.g. after `git pull`).
#   sudo homeprojects adduser          Add another sign-in account
#   sudo homeprojects manage ARGS...   Run any manage.py command as the app user (e.g. changepassword NAME)
#
# Install folder, account and port come from /etc/homeprojects.conf (written by install.sh).
set -euo pipefail

APP=/opt/homeprojects APP_USER=homeprojects PORT=8000 SOURCE=''
[ -r /etc/homeprojects.conf ] && . /etc/homeprojects.conf
SERVICE=home-projects
CLI=/usr/local/sbin/homeprojects
CODE_DIRS="config deploy web"        # mirrored exactly on update (files deleted in the project are deleted here too)

usage() { sed -n '2,/^set -euo/p' "$0" | sed '$d; s/^# \{0,1\}//'; exit "${1:-0}"; }
die() { echo "!! $*" >&2; exit 1; }
as_app() { (cd "$APP" && runuser -u "$APP_USER" -- "$@"); }
manage() { as_app venv/bin/python manage.py "$@"; }

# Old installs called the updater `homeprojects-update` (now a symlink to this file)
[ "${0##*/}" != homeprojects-update ] || set -- update "$@"
[ $# -ge 1 ] || usage 2
CMD="$1"; shift
case "$CMD" in -h|--help|help) usage ;; esac
[ "$(id -u)" -eq 0 ] || die "Run with sudo: sudo homeprojects $CMD $*"
[ -f "$APP/manage.py" ] || die "Home Projects isn't installed in $APP. Run install.sh first."

urls() {
  local ips; ips=$(hostname -I 2>/dev/null | tr ' ' '\n' | grep -E '^[0-9.]+$' || true)
  for ip in ${ips:-127.0.0.1}; do echo "  http://$ip:$PORT/"; done
}

healthy() {   # wait up to 15 s for the sign-in page
  for _ in $(seq 15); do
    [ "$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:$PORT/login/" || true)" = 200 ] && return 0
    sleep 1
  done
  return 1
}

case "$CMD" in
  # ---- start / stop ----
  start)
    USERS=$(manage shell -c "from django.contrib.auth.models import User; print(User.objects.count())" 2>/dev/null | tail -1)
    if [ "${USERS:-0}" -eq 0 ]; then
      [ -t 0 ] || die "No sign-in accounts yet. Run 'sudo homeprojects start' in a terminal to create one."
      echo "Create your sign-in account (password: 10+ characters):"
      manage createsuperuser
    fi
    systemctl enable -q --now $SERVICE
    healthy || die "The app didn't answer on port $PORT. See: sudo homeprojects logs"
    echo "Home Projects is running. Open it from any device on your network:"
    urls
    ;;
  stop)    systemctl stop $SERVICE; echo "Stopped. (It starts again at boot; 'sudo systemctl disable home-projects' prevents that.)" ;;
  restart) systemctl restart $SERVICE; healthy && echo "Restarted." || die "The app didn't come back. See: sudo homeprojects logs" ;;
  status)
    systemctl status $SERVICE --no-pager -n 0 || true
    echo; echo "Folder: $APP   Account: $APP_USER   Port: $PORT"
    systemctl is-active -q $SERVICE && { echo "Open:"; urls; }
    ;;
  logs)    exec journalctl -u $SERVICE -f -n 50 ;;
  adduser) manage createsuperuser ;;
  manage)  manage "$@" ;;

  # ---- update ----
  update)
    UPLOAD="$(getent passwd "${SUDO_USER:-root}" | cut -d: -f6)/homeprojects-upload"   # where deploy/push.sh uploads
    SRC="${1:-}"
    if [ -z "$SRC" ]; then
      if [ -f "$UPLOAD/manage.py" ]; then SRC="$UPLOAD"
      elif [ -n "$SOURCE" ]; then SRC="$SOURCE"
      else die "No code to install. Give the folder: sudo homeprojects update /path/to/homeprojects"; fi
    fi
    SRC="$(cd "$SRC" && pwd)"
    [ -f "$SRC/manage.py" ] || die "No Home Projects code in $SRC"
    [ "$SRC" != "$APP" ] || die "$SRC is the install folder itself; point update at the downloaded copy."
    STAMP=$(date +%F-%H%M%S)
    GROUP=$(id -gn "$APP_USER")
    echo "Updating $APP from $SRC"

    # If anything below fails, start the app again rather than leaving it stopped
    trap 'echo "!! Update failed at the step above. Starting the app again."; systemctl start $SERVICE' ERR

    echo "1/5 Stopping the app and backing up the database"
    WAS_ACTIVE=0; systemctl is-active -q $SERVICE && WAS_ACTIVE=1
    systemctl stop $SERVICE
    install -d -o "$APP_USER" -g "$GROUP" -m 750 "$APP/backups"
    [ ! -e "$APP/db.sqlite3" ] || cp -a "$APP/db.sqlite3" "$APP/backups/db-$STAMP.sqlite3"

    echo "2/5 Copying the new code"
    # Never the source's own database, secrets, venv or logs (rsync-exclude.txt), so a developer's copy is safe to use
    rsync -a --exclude-from="$SRC/deploy/rsync-exclude.txt" --exclude='/db.sqlite3*' --exclude=/backups/ "$SRC/" "$APP/"
    # The code folders are mirrored exactly, so files removed or moved in the project don't linger.
    # (Not the whole of $APP: it is also the service account's home, with its own dotfiles, venv, data and logs.)
    for dir in $CODE_DIRS; do
      [ -d "$SRC/$dir" ] && rsync -a --delete --exclude=__pycache__/ "$SRC/$dir/" "$APP/$dir/"
    done
    chown -R "$APP_USER:$GROUP" "$APP"

    echo "3/5 Installing Python packages"
    as_app venv/bin/pip install -q --disable-pip-version-check -r requirements.txt

    echo "4/5 Updating the database"
    manage migrate --noinput

    echo "5/5 Starting the app"
    if [ "$WAS_ACTIVE" = 1 ] || systemctl is-enabled -q $SERVICE; then
      systemctl start $SERVICE
      healthy || { echo "!! The app didn't answer after the update. See: sudo homeprojects logs"; exit 1; }
      echo "   running"
    else
      echo "   not started (it wasn't running); start it with: sudo homeprojects start"
    fi
    trap - ERR

    # Install this command's new version (a rename, so this running copy is unaffected)
    install -o root -g root -m 755 "$APP/deploy/homeprojects.sh" "$CLI.new" && mv -f "$CLI.new" "$CLI"
    [ ! -e /usr/local/sbin/homeprojects-update ] || [ -L /usr/local/sbin/homeprojects-update ] \
      || ln -sf homeprojects /usr/local/sbin/homeprojects-update
    [ "$SRC" != "$UPLOAD" ] || rm -rf "$SRC"
    echo "Done.$([ -e "$APP/backups/db-$STAMP.sqlite3" ] && echo " Database backup: $APP/backups/db-$STAMP.sqlite3")"
    ;;

  *) echo "Unknown command: $CMD"; usage 2 ;;
esac
