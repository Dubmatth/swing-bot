# Déploiement sur VPS (Hetzner)

Runner de trading papier tournant en continu, indépendamment du Mac, via
un service `systemd` qui redémarre automatiquement (crash, reboot du
serveur).

## 1. Créer le serveur (Hetzner Cloud Console)

- Emplacement : Falkenstein ou Nuremberg (Allemagne).
- Image : Ubuntu 24.04 LTS.
- Type : CX22 (2 vCPU / 4 Go, le moins cher — largement suffisant).
- Clé SSH : ajouter ta clé publique (`~/.ssh/id_ed25519.pub`), jamais de
  mot de passe.
- Cloud Firewall Hetzner : n'autoriser que le port 22 (SSH) en entrée.

Noter l'adresse IP donnée à la création.

## 2. Pousser le code sur GitHub (si pas déjà fait)

```bash
git push origin master
```

## 3. Dépôt privé : clé de déploiement (lecture seule)

Le dépôt `Dubmatth/swing-bot` est privé — le clone HTTPS anonyme échoue.
Sur le VPS, en root :

```bash
ssh-keygen -t ed25519 -f /root/.ssh/github_deploy_key -N "" -C "swing-bot-vps-deploy-key"
cat >> /root/.ssh/config <<EOF
Host github.com
  IdentityFile /root/.ssh/github_deploy_key
  IdentitiesOnly yes
EOF
chmod 600 /root/.ssh/config
ssh-keyscan -t ed25519 github.com >> /root/.ssh/known_hosts
```

Ajouter la clé publique affichée (`cat /root/.ssh/github_deploy_key.pub`)
sur https://github.com/Dubmatth/swing-bot/settings/keys → **Add deploy
key** → **ne pas** cocher « Allow write access » (lecture seule).

Puis cloner via SSH plutôt que `REPO_URL` (HTTPS) :

```bash
git clone git@github.com:Dubmatth/swing-bot.git /opt/swing-bot
```

## 4. Lancer l'installation

```bash
bash /opt/swing-bot/deploy/setup-vps.sh
```

Le script installe Node 22, crée un utilisateur dédié `swingbot` sans
privilège, met à jour le dépôt déjà cloné (`git pull`, fonctionne
maintenant via la clé de déploiement), configure le pare-feu local et les
mises à jour automatiques, puis démarre les services `systemd` (runner +
tableau de bord).

## 5. Vérifier que ça tourne

```bash
systemctl status swing-bot swing-bot-dashboard   # état des services
journalctl -u swing-bot -f                       # logs en direct
```

## 6. Consulter le statut du portefeuille à distance (terminal)

```bash
ssh root@<IP> "cd /opt/swing-bot && sudo -u swingbot npm run status"
```

## 7. Tableau de bord visuel (navigateur, via tunnel SSH)

Le tableau de bord (`scripts/dashboard.ts`) n'écoute que sur
`127.0.0.1:8080` du serveur — jamais exposé publiquement, par choix
délibéré (voir la conversation de conception). Pour le consulter, ouvrir
un tunnel SSH depuis le Mac :

```bash
ssh -N -L 8080:localhost:8080 root@<IP>
```

Puis ouvrir **http://localhost:8080** dans un navigateur, tant que le
tunnel reste ouvert (`Ctrl+C` dans le terminal du tunnel pour le fermer).

## 8. Mettre à jour le code après un nouveau commit

```bash
ssh root@<IP>
cd /opt/swing-bot
git pull
systemctl restart swing-bot swing-bot-dashboard
```

## 9. Arrêter / redémarrer les services

```bash
systemctl stop swing-bot swing-bot-dashboard
systemctl restart swing-bot swing-bot-dashboard
```

## Hors périmètre pour l'instant

- Gestion des clés API réelles (voir
  `docs/superpowers/specs/2026-08-24-real-order-api-key-security-notes.md`) —
  le fichier `/etc/swing-bot/.env` est prévu par le service `systemd` mais
  reste vide, aucune clé n'est nécessaire pour le trading papier.
- Sauvegardes automatiques de `data/live-state/` — Hetzner propose des
  snapshots payants du disque si besoin plus tard.
- Alerting/notifications sur trade ou erreur.
