#!/bin/bash
# Installs Home Projects on a Linux server (Fedora/RHEL or Debian/Ubuntu): packages, a service account,
# the app folder, Python packages, settings, database, systemd service, firewall, and the `homeprojects` command.
# Safe to run again: an existing database, .env and sign-in accounts are always kept.
#
#   git clone https://github.com/jiogrammaton/homeprojects.git
#   sudo bash homeprojects/install.sh [OPTIONS]
#   sudo homeprojects start                  (creates your first sign-in account, then starts the app)
#
# OPTIONS
#   --dir PATH            Install folder, also the service account's home (default: /opt/homeprojects).
#   --user NAME           Account the app runs as; created if it doesn't exist (default: homeprojects).
#   --port N              Port the app listens on (default: 8000).
#   --allowed-hosts LIST  Addresses/names people type to reach the app, comma-separated
#                         (default: this server's IP addresses and hostname). Only used when creating .env.
#   --trust-proxy         The app sits behind Caddy/nginx: use the client IP it forwards. Only used when creating .env.
#   --no-service          Don't install the systemd service (e.g. inside a container).
#   --no-firewall         Don't open the port in the firewall.
#   -h, --help            Show this help.
#
# Running it again without --dir/--user/--port reuses the values from the last install (/etc/homeprojects.conf).
set -euo pipefail

CONF=/etc/homeprojects.conf
SERVICE=home-projects
CLI=/usr/local/sbin/homeprojects
SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"     # the downloaded project folder (this script is at its top)

# ---- Options ----
APP=/opt/homeprojects APP_USER=homeprojects PORT=8000
[ -r "$CONF" ] && . "$CONF"                                # a previous install's choices are the new defaults

ALLOWED_HOSTS='' TRUST_PROXY=0 WITH_SERVICE=1 WITH_FIREWALL=1
while [ $# -gt 0 ]; do
  case "$1" in
    --dir)           APP="${2:?--dir needs a path}"; shift 2 ;;
    --user)          APP_USER="${2:?--user needs a name}"; shift 2 ;;
    --port)          PORT="${2:?--port needs a number}"; shift 2 ;;
    --allowed-hosts) ALLOWED_HOSTS="${2:?--allowed-hosts needs a value}"; shift 2 ;;
    --trust-proxy)   TRUST_PROXY=1; shift ;;
    --no-service)    WITH_SERVICE=0; shift ;;
    --no-firewall)   WITH_FIREWALL=0; shift ;;
    -h|--help)       sed -n '2,/^set -euo/p' "$0" | sed '$d; s/^# \{0,1\}//'; exit 0 ;;
    *) echo "Unknown option: $1 (see --help)"; exit 2 ;;
  esac
done
APP="${APP%/}"

die() { echo "!! $*" >&2; exit 1; }
step() { echo; echo "==> $*"; }
as_app() { (cd "$APP" && runuser -u "$APP_USER" -- "$@"); }   # runuser (util-linux) is installed in step 1; sudo may not be

[ "$(id -u)" -eq 0 ] || die "Run as root: sudo bash $0 $*"
[ -f "$SRC/manage.py" ] || die "Can't find the project next to this script ($SRC)."
[[ "$APP" =~ ^/[A-Za-z0-9._/-]+$ ]] || die "--dir must be an absolute path made of letters, digits, . _ - / (got '$APP')."
case "$APP/" in
  /home/*|/root/*) die "--dir can't be inside /home or /root: the service is sandboxed away from home folders. Try /srv/homeprojects." ;;
esac
case "$APP" in
  /bin|/boot|/dev|/etc|/home|/lib|/lib64|/media|/mnt|/opt|/proc|/root|/run|/sbin|/srv|/sys|/tmp|/usr|/usr/*|/var|/var/lib)
    die "--dir $APP is a system folder. Use a folder of its own, e.g. $APP/homeprojects." ;;
esac
if [ -d "$APP" ] && [ -n "$(ls -A "$APP" 2>/dev/null)" ] && [ ! -e "$APP/manage.py" ] && [ "$(stat -c %U "$APP")" != "$APP_USER" ]; then
  die "$APP already exists and holds other files. Choose an empty or new folder with --dir."
fi
[[ "$APP_USER" =~ ^[a-z_][a-z0-9_-]{0,31}$ ]] || die "--user must be a lowercase account name (got '$APP_USER')."
[ "$APP_USER" != root ] || die "Don't run the app as root; pick another --user."
[[ "$PORT" =~ ^[0-9]+$ ]] && [ "$PORT" -ge 1 ] && [ "$PORT" -le 65535 ] || die "--port must be a number from 1 to 65535."

echo "Installing into $APP as user '$APP_USER', port $PORT."

# ---- 1. Packages ----
step "1/9 System packages (Python 3.12+, rsync, curl, runuser)"
find_python() {
  for c in python3.14 python3.13 python3.12 python3; do
    command -v "$c" >/dev/null && "$c" -c 'import sys; sys.exit(sys.version_info < (3, 12))' 2>/dev/null \
      && { command -v "$c"; return; }
  done
}
LOG=$(mktemp)
if command -v dnf >/dev/null; then
  dnf install -y python3 rsync curl util-linux >"$LOG" 2>&1 || { cat "$LOG"; exit 1; }
  [ -n "$(find_python)" ] || dnf install -y python3.12 >"$LOG" 2>&1 || true   # RHEL/Rocky/Alma 9 ship 3.9 as python3
elif command -v apt-get >/dev/null; then
  { apt-get update && DEBIAN_FRONTEND=noninteractive apt-get install -y python3 python3-venv rsync curl util-linux; } \
    >"$LOG" 2>&1 || { cat "$LOG"; exit 1; }
else
  echo "No dnf or apt-get here: make sure python3 (3.12+) with venv, rsync, curl and util-linux are installed."
fi
rm -f "$LOG"
PY=$(find_python || true)
[ -n "$PY" ] || die "Python 3.12 or newer is required (found: $(python3 --version 2>&1)). Debian 12 is too old; use Debian 13 or Ubuntu 24.04+."
echo "$("$PY" --version), rsync $(rsync --version | head -1 | awk '{print $3}')"

# ---- 2. Account ----
step "2/9 App account '$APP_USER'"
if id "$APP_USER" >/dev/null 2>&1; then
  echo "Already exists."
else
  useradd --system --create-home --home-dir "$APP" --shell /sbin/nologin "$APP_USER"
  echo "Created (home: $APP)."
fi
APP_GROUP=$(id -gn "$APP_USER")

# ---- 3. Files ----
step "3/9 App files in $APP"
mkdir -p "$APP"
if [ "$SRC" = "$APP" ]; then
  echo "Running from $APP itself; nothing to copy."
else
  if [ -e "$APP/db.sqlite3" ] && [ -e "$SRC/db.sqlite3" ]; then
    echo "Keeping the server's existing database; the uploaded db.sqlite3 is ignored. (Use the restore in Settings to replace data.)"
  elif [ -e "$SRC/db.sqlite3" ]; then
    echo "Using the uploaded db.sqlite3 (your tasks, settings and sign-in accounts)."
  fi
  rsync -a --exclude-from="$SRC/deploy/rsync-exclude.txt" \
        $([ -e "$APP/db.sqlite3" ] && echo --exclude=/db.sqlite3) "$SRC/" "$APP/"
  echo "Copied from $SRC"
fi
chown -R "$APP_USER:$APP_GROUP" "$APP"
chmod 750 "$APP"

# ---- 4. Python ----
step "4/9 Python environment"
[ -x "$APP/venv/bin/python" ] || as_app "$PY" -m venv venv
as_app venv/bin/pip install -q --disable-pip-version-check -r requirements.txt
echo "Packages installed: $(as_app venv/bin/pip freeze | tr '\n' ' ')"

# ---- 5. Settings ----
step "5/9 Settings (.env)"
if [ -e "$APP/.env" ]; then
  echo "Keeping the existing .env ($(grep -E '^DJANGO_ALLOWED_HOSTS=' "$APP/.env" || echo 'no DJANGO_ALLOWED_HOSTS line'))."
else
  if [ -z "$ALLOWED_HOSTS" ]; then
    # This server's IPv4 addresses, its hostname, and hostname.local (mDNS). Minimal images may lack `hostname`.
    ALLOWED_HOSTS="$(hostname -I 2>/dev/null | tr ' ' '\n' | grep -E '^[0-9.]+$' | paste -sd, - || true)"
    NAME=$(uname -n)
    ALLOWED_HOSTS="${ALLOWED_HOSTS:+$ALLOWED_HOSTS,}$NAME"
    case "$NAME" in *.*) ;; *) ALLOWED_HOSTS="$ALLOWED_HOSTS,$NAME.local" ;; esac
  fi
  sed -e "s|^DJANGO_ALLOWED_HOSTS=.*|DJANGO_ALLOWED_HOSTS=$ALLOWED_HOSTS|" \
      -e "s|^DJANGO_DEBUG=.*|DJANGO_DEBUG=0|" \
      -e "s|^DJANGO_TRUST_X_FORWARDED_FOR=.*|DJANGO_TRUST_X_FORWARDED_FOR=$TRUST_PROXY|" \
      "$APP/.env.example" > "$APP/.env"
  chown "$APP_USER:$APP_GROUP" "$APP/.env"
  chmod 600 "$APP/.env"
  echo "Created .env with DJANGO_ALLOWED_HOSTS=$ALLOWED_HOSTS (trust proxy: $TRUST_PROXY). Edit $APP/.env to change it."
fi

# ---- 6. Database ----
step "6/9 Database"
as_app venv/bin/python manage.py migrate --noinput
echo "Database is up to date."

# ---- 7. Service ----
step "7/9 Service ($SERVICE)"
if [ "$WITH_SERVICE" = 1 ]; then
  UNIT=/etc/systemd/system/$SERVICE.service
  NEW=$(mktemp)
  sed -e "s|/opt/homeprojects|$APP|g" -e "s|^User=.*|User=$APP_USER|" -e "s|^Group=.*|Group=$APP_GROUP|" \
      -e "s|0\.0\.0\.0:8000|0.0.0.0:$PORT|" "$APP/deploy/$SERVICE.service" > "$NEW"
  if [ -e "$UNIT" ] && ! cmp -s "$NEW" "$UNIT"; then
    cp "$UNIT" "$UNIT.bak"
    echo "Your previous service file was saved as $UNIT.bak."
  fi
  install -m 644 "$NEW" "$UNIT"
  rm -f "$NEW"
  systemctl daemon-reload
  if systemctl is-active -q $SERVICE; then
    systemctl restart $SERVICE
    echo "Installed and restarted (it was already running)."
  else
    echo "Installed. Start it with: sudo homeprojects start"
  fi
else
  echo "Skipped (--no-service)."
fi

# ---- 8. Firewall ----
step "8/9 Firewall (port $PORT)"
if [ "$WITH_FIREWALL" = 0 ]; then
  echo "Skipped (--no-firewall)."
elif command -v firewall-cmd >/dev/null && firewall-cmd --state >/dev/null 2>&1; then
  firewall-cmd -q --permanent --add-port="$PORT/tcp" && firewall-cmd -q --reload && echo "firewalld: port $PORT/tcp open."
elif command -v ufw >/dev/null && ufw status | grep -q 'Status: active'; then
  ufw allow "$PORT/tcp" >/dev/null && echo "ufw: port $PORT/tcp open."
else
  echo "No active firewall found; nothing to open."
fi

# ---- 9. Command ----
step "9/9 The homeprojects command"
{
  echo "# Written by install.sh; read by $CLI. Re-run install.sh with --dir/--user/--port to change."
  printf 'APP=%q\nAPP_USER=%q\nPORT=%q\n' "$APP" "$APP_USER" "$PORT"
  case "$SRC" in */homeprojects-upload|"$APP") ;; *) printf 'SOURCE=%q\n' "$SRC" ;; esac   # where `update` pulls from
} > "$CONF"
chmod 644 "$CONF"
install -D -o root -g root -m 755 "$APP/deploy/homeprojects.sh" "$CLI"
# Older installs had a separate `homeprojects-update` command; keep that name working (and any sudoers rule for it)
[ ! -e /usr/local/sbin/homeprojects-update ] || ln -sf homeprojects /usr/local/sbin/homeprojects-update
echo "Installed $CLI (settings in $CONF)."

case "$SRC" in */homeprojects-upload) rm -rf "$SRC" ;; esac

echo
echo "Installed. Next:  sudo homeprojects start"
echo "  (creates your first sign-in account if there isn't one, then starts the app and shows its address)"
