# OberFans – Freunde finden (Swipe · Match · Chat) auf Netlify

Struktur:
- `public/index.html` – Frontend
- `netlify/functions/api.mjs` – Backend (alle `/api/*`-Routen)
- `netlify.toml` – Build-Einstellungen

Alles läuft über **Netlify Blobs** (Nutzer, Posts, Chats, Matches, Bilder/Videos, Login-Schlüssel); Standard-Avatare erzeugt die Function selbst – kein externer Dienst außer Gmail für den Code-Versand – automatisch aktiv, nichts einzurichten.

## Environment variables (Netlify → Site configuration → Environment variables)
Nur zwei Variablen nötig. Der Login-Schlüssel wird automatisch erzeugt und in Netlify Blobs (Store `config`) gespeichert – ein neues App-Passwort loggt niemanden aus:
- `GMAIL_USER` – deine Gmail-Adresse
- `GMAIL_APP_PASSWORD` – 16-stelliges Google-App-Passwort

## Gmail App-Passwort
1. Google-Konto → Sicherheit → Bestätigung in zwei Schritten aktivieren
2. https://myaccount.google.com/apppasswords → App-Name "OberFans" → Passwort kopieren

## Deploy
Repo zu GitHub pushen → bei Netlify "Import from Git" → Variablen setzen → Deploy.
Lokal testen: `npm i -g netlify-cli && npm install && netlify dev` (mit `.env` nach `.env.example`).

## Funktionen
- Registrierung wie bei Tinder (Schritt für Schritt: Name, E-Mail, Passwort, Geburtstag, Geschlecht, Interessen, Bio, Foto), **Profilbild Pflicht**, E-Mail-Code (Gmail), **Mindestalter 18**
- Profil bearbeiten wie bei Tinder: bis zu 6 Fotos (erstes = Profilbild, ★ Hauptfoto, ✕ löschen), Bio, Geschlecht, Interessen. Alter kommt aus dem Geburtstag. Jedes Gerät holt sich beim Öffnen das aktuelle Profil vom Server.
- Entdecken: Swipe-Karten (Drag oder Buttons, Tippen links/rechts blättert durch die Fotos), Filter nach Alter und Interesse
- Match bei gegenseitigem Like, Chat nur zwischen Matches
- Blockieren und Melden (Meldungen liegen im Blob-Store `reports`, Netlify → Blobs)
- Feed mit Beiträgen und Kommentaren bleibt erhalten

## Grenzen
Uploads max. 5 MB pro Datei (Netlify-Function-Limit ~6 MB). Fotos werden im Browser automatisch verkleinert.

## Design (v3)
Tinder-Look (Flammen-Gradient #fd267a → #ff6036, Swipe-Karten mit Overlay, LIKE/NOPE-Stempel, Match-Popup mit Konfetti) kombiniert mit iOS-26-„Liquid Glass“ (schwebende Glas-Header/-Tab-Bar, Glas-Chips, Bottom-Sheets, Dynamic-Island-Toast). Reine CSS/JS-Änderung in `public/index.html`, das Backend bleibt unverändert.
Zusätzlich: `manifest.webmanifest` + Icons (installierbar als PWA).

## Android-App (APK)
Die APK ist ein WebView-Wrapper, der https://ober.fans.netlify.app lädt (Vollbild, Datei-Upload, Zurück-Taste, Offline-Seite). Änderungen an der Webseite erscheinen in der App sofort nach dem Netlify-Deploy – kein neues APK nötig.
