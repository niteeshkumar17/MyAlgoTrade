#!/usr/bin/env bash
# ============================================================================
# /deploy/install.sh
# Idempotent Provisioning, Hardening & Update Script for Oracle Cloud Always Free VM
# Tested on Ubuntu 22.04 LTS & 24.04 LTS (Ampere A1 ARM64 & AMD E2.1.Micro x86_64)
# ============================================================================
set -euo pipefail

INSTALL_DIR="/opt/aegis-options-bot"
ENV_DIR="/etc/aegis-bot"
ENV_FILE="${ENV_DIR}/bot.env"
DATA_DIR="/var/lib/aegis-bot"
LOG_DIR="/var/log/aegis-bot"
SERVICE_USER="aegisbot"

echo "[1/8] Detecting architecture and verifying OS..."
ARCH="$(uname -m)"
echo "      Detected architecture: ${ARCH} (supports x86_64 AMD Micro & aarch64 Ampere A1)"

echo "[2/8] Configuring 2 GB swap file (essential for 1 GB RAM AMD E2.1.Micro shape)..."
if [ ! -f /swapfile ]; then
    sudo fallocate -l 2G /swapfile || sudo dd if=/dev/zero of=/swapfile bs=1M count=2048
    sudo chmod 600 /swapfile
    sudo mkswap /swapfile
    sudo swapon /swapfile
    if ! grep -q "/swapfile" /etc/fstab; then
        echo "/swapfile none swap sw 0 0" | sudo tee -a /etc/fstab >/dev/null
    fi
    sudo sysctl vm.swappiness=20
    echo "      2 GB swapfile created and activated."
else
    echo "      /swapfile already exists; skipping."
fi

echo "[3/8] Installing system packages, Chrony NTP sync, UFW, Fail2ban, and Unattended Upgrades..."
sudo apt-get update -y
sudo DEBIAN_FRONTEND=noninteractive apt-get install -y \
    python3 python3-venv python3-pip git curl rsync chrony ufw fail2ban unattended-upgrades sqlite3

sudo systemctl enable --now chrony
sudo chronyc makestep || true
echo "      Note: Bot service forces TZ=Asia/Kolkata (IST) for NSE 09:15-15:30 market hours regardless of VM region (e.g., Canada)."

echo "[4/8] Hardening firewall (outbound-only + inbound SSH port 22 only)..."
sudo ufw default deny incoming
sudo ufw default allow outgoing
sudo ufw allow 22/tcp comment 'SSH key-only access'
sudo ufw --force enable
sudo systemctl enable --now fail2ban
sudo dpkg-reconfigure -f noninteractive unattended-upgrades

echo "[5/8] Creating non-root service user (${SERVICE_USER}) and state directories..."
if ! id -u "${SERVICE_USER}" >/dev/null 2>&1; then
    sudo useradd --system --no-create-home --shell /usr/sbin/nologin "${SERVICE_USER}"
fi

sudo mkdir -p "${INSTALL_DIR}" "${ENV_DIR}" "${DATA_DIR}/backups" "${LOG_DIR}"
sudo chown -R "${SERVICE_USER}:${SERVICE_USER}" "${DATA_DIR}" "${LOG_DIR}"

echo "[6/8] Syncing repository (https://github.com/niteeshkumar17/MyAlgoTrade) and building Python virtualenv..."
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
GIT_REPO_URL="${GIT_REPO_URL:-https://github.com/niteeshkumar17/MyAlgoTrade.git}"

if [ -f "${REPO_ROOT}/bot/requirements.txt" ]; then
    if [ "${REPO_ROOT}" != "${INSTALL_DIR}" ]; then
        sudo rsync -a --delete --exclude '.git' --exclude 'node_modules' "${REPO_ROOT}/" "${INSTALL_DIR}/"
    fi
else
    echo "      Cloning ${GIT_REPO_URL} into ${INSTALL_DIR}..."
    sudo rm -rf "${INSTALL_DIR}"
    sudo git clone "${GIT_REPO_URL}" "${INSTALL_DIR}"
fi
sudo chown -R "${SERVICE_USER}:${SERVICE_USER}" "${INSTALL_DIR}"

sudo -u "${SERVICE_USER}" python3 -m venv "${INSTALL_DIR}/bot/.venv"
sudo -u "${SERVICE_USER}" "${INSTALL_DIR}/bot/.venv/bin/pip" install --upgrade pip wheel
sudo -u "${SERVICE_USER}" "${INSTALL_DIR}/bot/.venv/bin/pip" install -r "${INSTALL_DIR}/bot/requirements.txt"

echo "[7/8] Installing chmod 600 environment template if not present..."
if [ ! -f "${ENV_FILE}" ]; then
    sudo cp "${INSTALL_DIR}/bot/.env.example" "${ENV_FILE}"
    sudo chown root:${SERVICE_USER} "${ENV_FILE}"
    sudo chmod 600 "${ENV_FILE}"
    echo "      Created ${ENV_FILE} (chmod 600). Edit it with your Alpaca paper keys and Neon DATABASE_URL!"
else
    sudo chmod 600 "${ENV_FILE}"
    echo "      Existing ${ENV_FILE} preserved and verified chmod 600."
fi

echo "[8/8] Installing systemd unit and enabling automatic boot startup..."
sudo cp "${INSTALL_DIR}/deploy/aegis-options-bot.service" /etc/systemd/system/aegis-options-bot.service
sudo systemctl daemon-reload
sudo systemctl enable aegis-options-bot.service

echo "============================================================================"
echo " Installation complete!"
echo " Next steps:"
echo "   1. Edit secrets:   sudo nano ${ENV_FILE}"
echo "   2. Dry-run check:  sudo -u ${SERVICE_USER} ${INSTALL_DIR}/bot/.venv/bin/python -m src.main --dry-run-once"
echo "   3. Start service:  sudo systemctl restart aegis-options-bot && sudo journalctl -u aegis-options-bot -f"
echo "============================================================================"
