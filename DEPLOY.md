# Deploying Home Projects on your home network

This guide runs the app on an always-on Linux machine or VM (Fedora/RHEL, or Debian 13+/Ubuntu 24.04+) so phones, tablets, and laptops on your network can use it at `http://<server-ip>:8000/`.

It is meant for a **home network only**. Don't forward a router port to it or expose it to the internet.

## Install in three commands

On the **server**, as a user who can `sudo`:

```bash
git clone https://github.com/jiogrammaton/homeprojects.git
sudo bash homeprojects/install.sh
sudo homeprojects start
```

1. **Download.** No `git`? Use `curl -L https://github.com/jiogrammaton/homeprojects/archive/refs/heads/master.tar.gz | tar xz` and run `homeprojects-master/install.sh` in the next step instead.
2. **Install.** Installs everything the app needs (Python 3.12+, rsync, curl), creates the `homeprojects` account, copies the app to `/opt/homeprojects`, sets up its Python packages, settings and database, adds the systemd service, opens port 8000 in the firewall, and installs the `homeprojects` command. It's safe to run again: an existing database, `.env`, and sign-in accounts are always kept.
3. **Start.** Asks you to create your sign-in account (first time only), starts the app (and from then on at every boot), and prints the address to open, such as `http://192.168.1.50:8000/`.

Keep the downloaded folder: `sudo homeprojects update` installs new versions from it (see [Updating](#updating-the-app)).

### Choosing the folder, account, or port

The defaults are `/opt/homeprojects`, an account named `homeprojects`, and port `8000`. To use others, pass them to the installer:

```bash
sudo bash homeprojects/install.sh --dir /srv/homeprojects --user homeapp --port 8080
```

| Option | Default | What it does |
|---|---|---|
| `--dir PATH` | `/opt/homeprojects` | The install folder, which is also the account's home. It must be a folder of its own (not `/opt` itself) and not inside `/home` or `/root`, which the service is sandboxed from. |
| `--user NAME` | `homeprojects` | The account the app runs as. Created as a system account if it doesn't exist. |
| `--port N` | `8000` | The port the app listens on (and that the installer opens in the firewall). |
| `--allowed-hosts LIST` | this server's IPs, hostname and `hostname.local` | The addresses people type to reach the app, comma-separated. Only used the first time (when `.env` is created). |
| `--trust-proxy` | off | The app sits behind Caddy or nginx (step 7a/8): use the client IP the proxy forwards. Only used the first time. |
| `--no-firewall` | | Don't open the port in the firewall. |
| `--no-service` | | Don't install the systemd service (for containers). |

Your choices are saved in `/etc/homeprojects.conf`, so the `homeprojects` command and later runs of `install.sh` use them automatically. To change them, run `install.sh` again with new options.

Give the server a fixed IP address (a DHCP reservation in your router) so the address you open doesn't change. If it does change, add the new address to `DJANGO_ALLOWED_HOSTS` in the install folder's `.env` and run `sudo homeprojects restart`.

## The `homeprojects` command

| Command | What it does |
|---|---|
| `sudo homeprojects start` | Creates the first sign-in account if there is none, starts the app (also at every boot), and shows its address |
| `sudo homeprojects stop` / `restart` | Stops / restarts the app |
| `sudo homeprojects status` | Shows whether it's running, its folder, account and port, and where to open it |
| `sudo homeprojects logs` | Follows the server log (`Ctrl+C` to stop) |
| `sudo homeprojects update [DIR]` | Installs a new version (see [Updating](#updating-the-app)) |
| `sudo homeprojects adduser` | Adds another sign-in account |
| `sudo homeprojects manage …` | Runs any `manage.py` command as the app's account, e.g. `manage changepassword <username>` |

On RHEL, Rocky, and Alma Linux, `sudo` doesn't search `/usr/local/sbin`, so type `sudo /usr/local/sbin/homeprojects …` there.

## What's in the install folder

| In `/opt/homeprojects` (or your `--dir`) | What it is |
|---|---|
| project files, `venv/` | The app and its Python packages |
| `db.sqlite3` | Your data and user accounts |
| `.env`, `.secret_key` | Settings and the secret key (both readable only by the app's account) |
| `logs/` | `app.log` (every change) and `security.log` (sign-ins), rotated automatically |
| `backups/` | A copy of the database from before each update |
| `.cache/` | Sign-in lockout counters |

The app needs about 200 MB including logs.

## Deploying from your computer instead

If you develop on another computer, `deploy/push.sh` uploads the project over SSH and runs the same scripts on the server. Run it from the project folder on **your computer**, after setting up key login (`ssh-copy-id you@<server-ip>`):

| Goal | Command |
|---|---|
| **New server**, starting empty | `deploy/push.sh you@<server-ip> install` |
| **New server** with this computer's data (tasks, settings, sign-in accounts) | `deploy/push.sh you@<server-ip> install --with-db` |
| New server with installer options | `deploy/push.sh you@<server-ip> install -- --dir /srv/homeprojects --port 8080` |
| **Update** an existing server (never sends your database) | `deploy/push.sh you@<server-ip> update` |

It uploads to `~/homeprojects-upload` on the server (applying `deploy/rsync-exclude.txt`), then runs `install.sh` + `homeprojects start`, or `homeprojects update`.

The manual steps further down are what the scripts do, for reference or if you'd rather go step by step. They use the default folder and account; substitute yours if you chose others.

## What's already built in

| Area | What the app does |
|------|-------------------|
| Sign-in | Every page and API call needs a signed-in user. Sessions last two weeks. |
| Brute-force protection | After 5 failed sign-ins, that device's IP is locked out for 15 minutes (adjustable in `.env`). |
| CSRF protection | Every change sent to the server must carry the page's CSRF token, so other websites can't make changes on your behalf. |
| Secrets | The secret key is generated on first start and stored in `.secret_key` (readable only by its owner). `DEBUG` is off unless you turn it on. |
| Allowed hosts | Only the hostnames/IPs listed in `.env` are answered. |
| Headers | Clickjacking protection, no MIME sniffing, same-origin referrer policy. |
| Audit log | `logs/app.log` gets one line per change: who, what, from which IP, result. Deletions, restores, and imports get an extra line. |
| Security log | `logs/security.log` records sign-ins, sign-outs, failed sign-ins, lockouts, and rejected requests. |
| Log rotation | Each log rolls over at 5 MB and keeps 5 old files. |
| Backups | Settings › Miscellaneous › Download backup gives you one JSON file you can restore from. |

## 1. Prepare the server

On the **server** (over SSH):

```bash
python --version                 # needs 3.12 or newer
sudo dnf install -y rsync         # Fedora/RHEL; on Debian/Ubuntu: sudo apt install rsync python3-venv
sudo useradd --system --create-home --home-dir /opt/homeprojects homeprojects
```

## 2. Copy the app from your computer

On **your computer**, from the project folder (the one with `manage.py`). Replace `you@<server-ip>` with your SSH login:

```bash
rsync -av --exclude-from=deploy/rsync-exclude.txt ./ you@<server-ip>:homeprojects-upload/
```

This includes `db.sqlite3`, so the server starts with your current tasks, settings, and sign-in account. To start empty instead, add `--exclude db.sqlite3`.

Then on the **server**, move it into place:

```bash
sudo rsync -a ~/homeprojects-upload/ /opt/homeprojects/
sudo chown -R homeprojects:homeprojects /opt/homeprojects
sudo chmod 750 /opt/homeprojects
rm -rf ~/homeprojects-upload
```

## 3. Install

Still on the server, work as the `homeprojects` user:

```bash
sudo -u homeprojects -H bash
cd /opt/homeprojects
python -m venv venv
source venv/bin/activate
pip install -r requirements.txt
python manage.py migrate
```
(There is no collectstatic step: whitenoise serves CSS/JS straight from `web/static/`.)

## 4. Configure

```bash
cp .env.example .env
chmod 600 .env
vim .env
```

At minimum set `DJANGO_ALLOWED_HOSTS` to the server's IP address and/or hostname, for example `192.168.1.50,homeserver.local`. Leave `DJANGO_DEBUG=0`.

Give the server a fixed IP address (a DHCP reservation in your router) so the address doesn't change.

## 5. Sign-in accounts

If you copied `db.sqlite3`, your existing account already works. To add another person, or if you started empty:

```bash
python manage.py createsuperuser
```

Use a password of at least 10 characters.

## 6. Run it as a service

```bash
exit   # back to your normal user
sudo cp /opt/homeprojects/deploy/home-projects.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now home-projects
sudo systemctl status home-projects
```

## 7. Open the firewall

```bash
# Fedora / RHEL
sudo firewall-cmd --permanent --add-port=8000/tcp && sudo firewall-cmd --reload
# Ubuntu / Debian with ufw
sudo ufw allow from 192.168.1.0/24 to any port 8000 proto tcp
```

Then open `http://<server-ip>:8000/`.

**VM networking:** if the VM uses virt-manager's default **NAT** network (an IP like `192.168.122.x`), only the computer running the VM can reach it. For phones and other devices, the VM needs an address on your home network: a network **bridge** if your computer uses Ethernet, or a **port forward** from your computer if it's on Wi-Fi (next section).

### 7a. VM on a Wi-Fi computer: forward requests with Caddy

Wi-Fi can't be bridged, so the computer running the VM passes requests through to it. Use Caddy rather than a firewall port forward: libvirt's NAT firewall blocks new connections forwarded into the VM network, and Caddy also passes on each device's real IP. Without that, every phone would look like the host, so one person's typos could lock everyone out.

**On the host computer:**

1. Find the VM's address:
   ```bash
   sudo virsh domifaddr <vm-name>        # e.g. 192.168.122.10 (sudo virsh list shows the name)
   ```
2. Keep that address fixed. Reserve it in libvirt's DHCP using the MAC address from step 1:
   ```bash
   sudo virsh net-update default add ip-dhcp-host \
     "<host mac='52:54:00:xx:xx:xx' ip='192.168.122.10'/>" --live --config
   ```
3. Check that the host can reach the app; you should see `HTTP/1.1 200 OK`:
   ```bash
   curl -sI http://192.168.122.10:8000/login/ | head -1
   ```
4. Install and configure Caddy, editing the VM address in the file to match step 1:
   ```bash
   sudo dnf install caddy
   sudo cp deploy/Caddyfile.vm-host /etc/caddy/Caddyfile
   sudo vim /etc/caddy/Caddyfile
   sudo setsebool -P httpd_can_network_connect 1
   sudo systemctl enable --now caddy
   ```
5. Open port 8080 on the host if its firewall zone doesn't already allow it (Fedora Workstation allows 1025–65535 by default):
   ```bash
   sudo firewall-cmd --permanent --add-port=8080/tcp && sudo firewall-cmd --reload
   ```

**In the VM**, in `/opt/homeprojects/.env`, add the **host's** home-network IP to the allowed hosts (that's the address phones type), and trust Caddy's forwarded IPs:
```bash
DJANGO_ALLOWED_HOSTS=<host-ip>
DJANGO_TRUST_X_FORWARDED_FOR=1
```
Then `sudo homeprojects restart`. (On a new VM you can set both at install time instead: `sudo bash homeprojects/install.sh --trust-proxy --allowed-hosts <host-ip>`.)

**From a phone** on the same Wi-Fi, open `http://<host-ip>:8080/`.

Keep in mind:
- The app is only reachable while the host computer is awake and the VM is running. In virt-manager, set the VM to start at boot (VM details → Boot Options → **Start virtual machine on host boot up**).
- Reserve the host's IP in your router so it doesn't change.
- Guest Wi-Fi networks often block devices from reaching each other, so use your main network.
- For HTTPS later, put the HTTPS setup from step 8 in this host's Caddyfile instead of inside the VM.

## 8. Optional: HTTPS

Over plain HTTP, someone else on your Wi-Fi could in principle read your traffic, including your password. On a trusted home network that's usually acceptable. If you want encryption:

1. Install [Caddy](https://caddyserver.com) on the server and use `deploy/Caddyfile` (change the hostname).
2. In the service file, change `--bind 0.0.0.0:8000` to `--bind 127.0.0.1:8000` so the app is only reachable through Caddy.
3. In `.env` set `DJANGO_HTTPS=1`, `DJANGO_CSRF_TRUSTED_ORIGINS=https://homeserver.local`, and `DJANGO_TRUST_X_FORWARDED_FOR=1`.
4. Open ports 80/443 instead of 8000, and restart both services.
5. Browsers will warn about the certificate until you install Caddy's root certificate on each device (`sudo caddy trust` on the server; on other devices, import `/var/lib/caddy/.local/share/caddy/pki/authorities/local/root.crt`).

## Updating the app

On the **server**, get the new code and install it:

```bash
git -C homeprojects pull            # or download the tarball again
sudo homeprojects update
```

`update` stops the app, backs up the database to `backups/db-<date>.sqlite3` in the install folder, copies the new code (the `config/`, `deploy/` and `web/` folders are mirrored exactly, so moved or deleted files don't linger), installs Python packages, migrates the database, and starts the app again. If a step fails, it starts the app again rather than leaving it down. It never copies a database, `.env`, `.secret_key`, `venv/` or logs from the downloaded folder, so your data and settings on the server are safe.

With no folder given, it uses `~/homeprojects-upload` (from `deploy/push.sh`) if that exists, otherwise the folder you installed from. To use another: `sudo homeprojects update /path/to/homeprojects`.

Download a backup (Settings › Miscellaneous) before updating, too: it's a single file you keep on your own device.

### Optional: updates without a password

To let an automated job (or an assistant) deploy updates without your password, and allow nothing else (replace `you` with your username):

```bash
echo 'you ALL=(root) NOPASSWD: /usr/local/sbin/homeprojects update' | sudo tee /etc/sudoers.d/homeprojects-update
sudo chmod 440 /etc/sudoers.d/homeprojects-update
sudo visudo -c                     # must say "parsed OK" for every file
sudo -n homeprojects update        # should run without asking for a password
```

The command lives in a root-owned folder on purpose: if a password-free rule pointed at a file you can edit, anyone who could edit that file could run anything as root. `update` refreshes that root-owned copy itself.

## Day-to-day

Run these on the server (paths assume the default install folder).

| Task | How |
|------|-----|
| Watch activity | `sudo tail -f /opt/homeprojects/logs/app.log` |
| Check sign-in attempts | `sudo tail -f /opt/homeprojects/logs/security.log` |
| Server errors | `sudo homeprojects logs` |
| Back up | Settings › Miscellaneous › Download backup, or `sudo homeprojects stop`, copy `/opt/homeprojects/db.sqlite3`, then `sudo homeprojects start` |
| Unlock a locked-out device | Wait 15 minutes, or `sudo rm -rf /opt/homeprojects/.cache && sudo homeprojects restart` |
| Reset a forgotten password | `sudo homeprojects manage changepassword <username>` |
| Check the security settings | `sudo homeprojects manage check --deploy` (the HTTPS warnings are expected until step 8) |

## Uninstalling

```bash
sudo systemctl disable --now home-projects
sudo rm /etc/systemd/system/home-projects.service /usr/local/sbin/homeprojects* /etc/homeprojects.conf
sudo systemctl daemon-reload
sudo userdel homeprojects            # your --user, if you chose another
sudo rm -rf /opt/homeprojects        # your --dir; this deletes your data, so download a backup first
```
