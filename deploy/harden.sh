#!/usr/bin/env bash
# Hardens a fresh Ubuntu/Debian VPS. Run once as root: sudo bash deploy/harden.sh [deploy-user]
# Safe to re-run. Refuses to disable password login unless a working SSH key is already in place.
set -euo pipefail

USER_NAME="${1:-deploy}"
[[ $EUID -eq 0 ]] || { echo "run as root" >&2; exit 1; }

# 1. Non-root user with the same SSH keys as root (or the invoking sudo user).
id "$USER_NAME" >/dev/null 2>&1 || adduser --disabled-password --gecos "" "$USER_NAME"
usermod -aG sudo "$USER_NAME"
echo "$USER_NAME ALL=(ALL) NOPASSWD:ALL" > "/etc/sudoers.d/90-$USER_NAME"
chmod 440 "/etc/sudoers.d/90-$USER_NAME"

SRC_KEYS="/root/.ssh/authorized_keys"
[[ -n "${SUDO_USER:-}" && -s "/home/$SUDO_USER/.ssh/authorized_keys" ]] && SRC_KEYS="/home/$SUDO_USER/.ssh/authorized_keys"
HOME_DIR="$(getent passwd "$USER_NAME" | cut -d: -f6)"
if [[ ! -s "$HOME_DIR/.ssh/authorized_keys" ]]; then
  [[ -s "$SRC_KEYS" ]] || { echo "no SSH keys in $SRC_KEYS: add one first or you would be locked out" >&2; exit 1; }
  install -d -m 700 -o "$USER_NAME" -g "$USER_NAME" "$HOME_DIR/.ssh"
  install -m 600 -o "$USER_NAME" -g "$USER_NAME" "$SRC_KEYS" "$HOME_DIR/.ssh/authorized_keys"
fi

# 2. Packages
export DEBIAN_FRONTEND=noninteractive
apt-get update -y
apt-get install -y ufw fail2ban unattended-upgrades ca-certificates curl gnupg

# 3. SSH keys only
cat > /etc/ssh/sshd_config.d/90-hardening.conf <<CONF
PasswordAuthentication no
KbdInteractiveAuthentication no
PermitRootLogin no
CONF
sshd -t
systemctl reload ssh 2>/dev/null || systemctl reload sshd

# 4. Firewall. Only Caddy publishes ports in docker-compose.yml, so Docker's ufw bypass exposes nothing else.
ufw default deny incoming
ufw default allow outgoing
ufw allow 22/tcp
ufw allow 80/tcp
ufw allow 443/tcp
ufw allow 443/udp
ufw --force enable

# 5. fail2ban
cat > /etc/fail2ban/jail.d/sshd.local <<CONF
[sshd]
enabled = true
maxretry = 5
bantime = 1h
CONF
systemctl enable --now fail2ban
systemctl restart fail2ban

# 6. Docker, from Docker's own repository
if ! command -v docker >/dev/null; then
  . /etc/os-release
  install -d -m 755 /etc/apt/keyrings
  curl -fsSL "https://download.docker.com/linux/$ID/gpg" -o /etc/apt/keyrings/docker.asc
  chmod a+r /etc/apt/keyrings/docker.asc
  echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/$ID $VERSION_CODENAME stable" > /etc/apt/sources.list.d/docker.list
  apt-get update -y
  apt-get install -y docker-ce docker-ce-cli containerd.io docker-compose-plugin
fi
usermod -aG docker "$USER_NAME"
systemctl enable --now docker

echo "Done. Before closing this session, confirm in a NEW terminal: ssh $USER_NAME@<server>"
