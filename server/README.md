# WYRE Centraal op een eigen server

Dezelfde site als op GitHub Pages, maar met een eigen PostgreSQL-database en een eigen
serverprogramma in plaats van Firebase.

## Installeren (Ubuntu of Debian)

Log in op de server en voer uit:

```bash
curl -fsSL https://raw.githubusercontent.com/timshtcone-sketch/wyre-centraal/main/server/install.sh -o install.sh && sudo bash install.sh
```

Het script vraagt om het e-mailadres, de naam en het wachtwoord van de eerste beheerder en
eventueel een domeinnaam. Daarna installeert het Docker, bouwt het de site en start het alles.

## Bijwerken

Hetzelfde script opnieuw draaien. Gegevens, wachtwoorden en instellingen blijven staan.

## Gegevens overzetten vanuit de Firebase-versie

1. Oude site → **Import** → **Volledige back-up downloaden**.
2. Nieuwe site → **Import** → kies dat bestand → **Opslaan in database**.

Wachtwoorden zitten niet in de back-up. Wie op de toegangslijst staat, logt de eerste keer in
met het standaardwachtwoord en moet dan meteen een eigen wachtwoord kiezen.

## Onderdelen

| Bestand | Doel |
|---|---|
| `app.js` | Serverprogramma: inloggen, rechten, opslag in PostgreSQL |
| `public/fb-shim.js` | Laat de site met deze server praten in plaats van met Firebase |
| `build.js` | Maakt de serverversie van `../index.html` |
| `docker-compose.yml`, `Dockerfile`, `Caddyfile` | Database, serverprogramma en webserver (https) |
| `install.sh` | Installatie en bijwerken |

Instellingen staan in `/opt/wyre-centraal/server/.env` (alleen leesbaar voor root).
Elke nacht komt er een kopie van de database in `/opt/wyre-centraal/server/backups/` (14 dagen bewaard).

## Verschillen met de Firebase-versie

- Accounts worden alleen door een beheerder aangemaakt (scherm **Team**); zelf registreren en
  e-mailbevestiging bestaan niet.
- Wachtwoord vergeten: een beheerder klikt in **Team** op **Gebruiker aanmaken** met dat
  e-mailadres. Het wachtwoord gaat dan terug naar het standaardwachtwoord.
- Wijzigingen van anderen verschijnen binnen ongeveer 15 seconden in plaats van direct.
