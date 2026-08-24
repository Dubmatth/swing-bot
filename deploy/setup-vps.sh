#!/usr/bin/env bash
# Installation initiale du runner de trading papier sur un VPS Ubuntu
# 24.04 LTS neuf (Hetzner CX22 ou équivalent). À exécuter UNE FOIS, en
# root, juste après la première connexion SSH.
#
# Usage : REPO_URL=https://github.com/<toi>/swing-bot.git bash setup-vps.sh
# (REPO_URL par défaut si non fourni : voir ci-dessous)

set -euo pipefail

REPO_URL="${REPO_URL:-https://github.com/Dubmatth/swing-bot.git}"
APP_DIR=/opt/swing-bot
SERVICE_USER=swingbot

echo "==> Mise à jour du système"
apt-get update
apt-get -y upgrade

echo "==> Installation de Node.js 22.x (dépôt officiel NodeSource)"
curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
apt-get install -y nodejs git ufw unattended-upgrades

echo "==> Utilisateur système dédié (aucun privilège, aucun shell de connexion)"
if ! id "$SERVICE_USER" &>/dev/null; then
  useradd --system --home-dir "$APP_DIR" --shell /usr/sbin/nologin "$SERVICE_USER"
fi

echo "==> Récupération du code"
if [ -d "$APP_DIR/.git" ]; then
  git -C "$APP_DIR" pull
else
  git clone "$REPO_URL" "$APP_DIR"
fi
mkdir -p "$APP_DIR/data"
chown -R "$SERVICE_USER":"$SERVICE_USER" "$APP_DIR"

echo "==> Emplacement réservé pour un futur fichier de secrets (vide pour l'instant)"
mkdir -p /etc/swing-bot
chown "$SERVICE_USER":"$SERVICE_USER" /etc/swing-bot
chmod 700 /etc/swing-bot

echo "==> Pare-feu local (en plus du Cloud Firewall Hetzner — défense en profondeur)"
ufw allow OpenSSH
ufw --force enable

echo "==> Mises à jour de sécurité automatiques"
dpkg-reconfigure -f noninteractive unattended-upgrades

echo "==> Services systemd (runner + tableau de bord)"
cp "$APP_DIR/deploy/swing-bot.service" /etc/systemd/system/swing-bot.service
cp "$APP_DIR/deploy/swing-bot-dashboard.service" /etc/systemd/system/swing-bot-dashboard.service
systemctl daemon-reload
systemctl enable --now swing-bot
systemctl enable --now swing-bot-dashboard

echo "==> Terminé. Vérifier l'état avec : systemctl status swing-bot swing-bot-dashboard"
echo "    Suivre les logs avec       : journalctl -u swing-bot -f"
echo "    Tableau de bord (localhost uniquement, voir deploy/README.md pour le tunnel SSH)"
