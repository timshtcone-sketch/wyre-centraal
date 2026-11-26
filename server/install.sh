#!/usr/bin/env bash
# WYRE Centraal installeren op een eigen server (Ubuntu of Debian).
# Gebruik, ingelogd op de server:
#   curl -fsSL https://raw.githubusercontent.com/timshtcone-sketch/wyre-centraal/main/server/install.sh -o install.sh && sudo bash install.sh
# Het script kan opnieuw gedraaid worden om bij te werken; bestaande gegevens en wachtwoorden blijven dan staan.
set -euo pipefail

REPO="https://github.com/timshtcone-sketch/wyre-centraal.git"
MAP="/opt/wyre-centraal"
zeg() { printf '\n\033[1m%s\033[0m\n' "$*"; }
stop() { printf '\n\033[31mGestopt: %s\033[0m\n' "$*" >&2; exit 1; }

[ "$(id -u)" = "0" ] || stop "start dit script met sudo (als root)."
command -v apt-get >/dev/null || stop "dit script is gemaakt voor Ubuntu of Debian."

zeg "1/5  Benodigde programma's installeren"
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq git curl ca-certificates openssl >/dev/null
if ! command -v docker >/dev/null; then
  curl -fsSL https://get.docker.com | sh >/dev/null
fi
docker compose version >/dev/null 2>&1 || apt-get install -y -qq docker-compose-plugin >/dev/null
systemctl enable --now docker >/dev/null 2>&1 || true

zeg "2/5  De site ophalen"
if [ -d "$MAP/.git" ]; then
  git -C "$MAP" pull --ff-only
else
  git clone --depth 1 "$REPO" "$MAP"
fi
cd "$MAP/server"

zeg "3/5  Instellingen"
if [ -f .env ]; then
  echo "Er is al een installatie (.env bestaat). Instellingen en wachtwoorden blijven ongewijzigd."
else
  echo "Maak de eerste beheerder aan. Daarmee log je straks in op de site."
  read -r -p "E-mailadres van de beheerder: " ADMIN_EMAIL
  [ -n "$ADMIN_EMAIL" ] || stop "geen e-mailadres ingevuld."
  read -r -p "Naam van de beheerder: " ADMIN_NAAM
  while :; do
    read -r -s -p "Wachtwoord (minstens 8 tekens, je ziet niets tijdens het typen): " P1; echo
    read -r -s -p "Wachtwoord herhalen: " P2; echo
    [ "$P1" = "$P2" ] || { echo "De wachtwoorden zijn niet gelijk."; continue; }
    [ "${#P1}" -ge 8 ] || { echo "Te kort."; continue; }
    case "$P1" in *"'"*|*'$'*|*'\'*|*'"'*) echo "Gebruik geen aanhalingstekens, \$ of \\ in dit wachtwoord."; continue;; esac
    break
  done
  echo
  echo "Heb je al een domeinnaam die naar deze server wijst (bv. wyre.voorbeeld.be)?"
  echo "Laat leeg als je die nog niet hebt; de site werkt dan via het IP-adres, zonder https."
  read -r -p "Domeinnaam (of leeg): " DOMEIN
  umask 077
  cat > .env <<ENV
POSTGRES_PASSWORD=$(openssl rand -hex 24)
SECRET=$(openssl rand -hex 48)
STANDAARD_PW=0123456789
SITE_ADDRESS=${DOMEIN:-:80}
ADMIN_EMAIL='${ADMIN_EMAIL}'
ADMIN_NAAM='${ADMIN_NAAM//\'/}'
ADMIN_PASSWORD='${P1}'
ENV
  unset P1 P2
fi

zeg "4/5  Bouwen en starten (dit duurt de eerste keer enkele minuten)"
docker compose up -d --build

zeg "5/5  Dagelijkse reservekopie van de database instellen"
mkdir -p "$MAP/server/backups"
cat > /etc/cron.d/wyre-centraal-backup <<CRON
# Elke nacht om 02:30 een kopie van de database; kopieën ouder dan 14 dagen worden verwijderd.
30 2 * * * root cd $MAP/server && docker compose exec -T db pg_dump -U wyre wyre | gzip > backups/wyre-\$(date +\%F).sql.gz && find backups -name 'wyre-*.sql.gz' -mtime +14 -delete
CRON

sleep 5
IP=$(curl -fsS -4 --max-time 5 https://ifconfig.me 2>/dev/null || hostname -I | awk '{print $1}')
ADRES=$(grep '^SITE_ADDRESS=' .env | cut -d= -f2)
zeg "Klaar."
docker compose ps --format 'table {{.Service}}\t{{.Status}}'
echo
if [ "$ADRES" = ":80" ]; then
  echo "De site staat op:  http://$IP/"
  echo "Later een domeinnaam koppelen: laat de naam naar $IP wijzen, zet in $MAP/server/.env"
  echo "  SITE_ADDRESS=jouw.domein.be   en draai:  cd $MAP/server && docker compose up -d"
else
  echo "De site staat op:  https://$ADRES/   (de domeinnaam moet naar $IP wijzen)"
fi
echo "Log in met het e-mailadres en wachtwoord van de beheerder die je net hebt opgegeven."
echo "Bijwerken naar een nieuwe versie: dit script opnieuw draaien."
