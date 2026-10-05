#!/bin/bash
# Run on YOUR COMPUTER from the project folder. Uploads the app to a server over SSH and installs or updates it.
# (On the server itself you don't need this: see the three-command install in DEPLOY.md.)
#
#   deploy/push.sh you@server update                    Upload code (never your database), then: sudo homeprojects update
#   deploy/push.sh you@server install                   First-time setup of a new server (empty database), then start it
#   deploy/push.sh you@server install --with-db         ...starting with this computer's db.sqlite3 (tasks + accounts)
#   deploy/push.sh you@server install -- --dir /srv/hp  Pass options after "--" to install.sh (see install.sh --help)
#
# Uses ssh/rsync, so set up key login first (ssh-copy-id you@server). sudo on the server may ask for your password.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."

usage() { sed -n '2,/^set -euo/p' "$0" | sed '$d; s/^# \{0,1\}//'; exit "${1:-0}"; }
[ $# -ge 2 ] || usage 2
HOST="$1" ACTION="$2"; shift 2
WITH_DB=0
while [ $# -gt 0 ]; do
  case "$1" in
    --with-db) WITH_DB=1; shift ;;
    --) shift; break ;;
    -h|--help) usage ;;
    *) echo "Unknown option: $1"; usage 2 ;;
  esac
done
EXTRA=("$@")
[ "$ACTION" = install ] || [ "$ACTION" = update ] || usage 2
[ "$WITH_DB" = 0 ] || [ "$ACTION" = install ] || { echo "--with-db is only for install (updates never send your database)."; exit 2; }

EXCLUDES=(--exclude-from=deploy/rsync-exclude.txt)
[ "$WITH_DB" = 1 ] || EXCLUDES+=(--exclude=/db.sqlite3)

echo "==> Uploading to $HOST:homeprojects-upload/ $([ "$WITH_DB" = 1 ] && echo '(including db.sqlite3)' || echo '(without the database)')"
rsync -a --delete "${EXCLUDES[@]}" ./ "$HOST:homeprojects-upload/"

if [ "$ACTION" = install ]; then
  echo "==> Installing on $HOST"
  ARGS=''
  [ ${#EXTRA[@]} -eq 0 ] || ARGS=$(printf '%q ' "${EXTRA[@]}")
  ssh -t "$HOST" "sudo bash ~/homeprojects-upload/install.sh $ARGS && sudo /usr/local/sbin/homeprojects start"
else
  echo "==> Updating on $HOST"
  # Servers installed before the `homeprojects` command existed run the uploaded copy once; it then installs itself.
  ssh -t "$HOST" 'if [ -x /usr/local/sbin/homeprojects ]; then sudo /usr/local/sbin/homeprojects update;
                  else sudo bash ~/homeprojects-upload/deploy/homeprojects.sh update; fi'
fi
