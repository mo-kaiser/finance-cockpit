# finance-cockpit

Privates Krypto-Steuer-Cockpit unter **cockpit.moritz-kaiser.com** (noindex).
Ab Steuerjahr 2026: Bitget Perpetuals (Anlage KAP) und Spot (Anlage SO), Earn später.

## Stack
SvelteKit 2 + TypeScript (Svelte 5), Vercel (`fra1`), Supabase (Postgres, Auth mit TOTP-2FA, RLS), decimal.js, Chart.js.

## Prinzipien
- Rohbuchungen unverändert speichern (`ct_rows`, `api_records`), abgeleitete Werte nicht speichern.
- Ausnahme: Jahresreports als eingefrorene Snapshots (`report_snapshots`, nur insert/select).
- Jahresgrenze in `Europe/Berlin`. EUR-Umrechnung über EZB-Kurs plus USDT/USD (`fx_rates`).
- Datenbankzugriff nur für den eigenen User **und** nur mit zweitem Faktor (`aal2`, in jeder RLS-Policy).
- Beträge nie als JS-`number`: aus der DB per `spalte::text` lesen, mit decimal.js rechnen.
- Finanzdaten (CSV, XLSX) gehören nie ins Repo.

## Struktur
```
supabase/migrations/   SQL-Migrationen (im Supabase SQL-Editor ausführen)
src/hooks.server.ts    Supabase-Client, Login-/2FA-Pflicht, Sicherheits-Header
src/routes/login       Anmeldung
src/routes/mfa         TOTP einrichten / prüfen
src/routes/import      CoinTracking-CSV-Import (Parsing im Browser, Batches à 1000)
src/routes/+page       Übersicht
src/routes/steuer      Steuer-Ansicht (Berechnung im Browser, CSV-Export)
src/routes/api/fx      EZB-Kursabruf (EUR/USD) → fx_rates
src/lib/import         Parser + Tests
src/lib/tax            Klassifizierung, EZB-Kurse, Steuer-Engine (KAP, FIFO/SO, Earn-Vorschau) + Tests
```

## Lokal
```
cp .env.example .env   # nur für geheime Werte (Cron/Bitget)
npm install
npm run dev
npm run check && npm test
CT_CSV=/pfad/export.csv npm test   # Parser gegen echten Export
```

## Datenquellen
- **CoinTracking „Trade Table“**: Zeitstempel in Europe/Berlin (geprüft an Funding-Zeiten 00/08/16 UTC). Tx-ID ist Dedup-Schlüssel und stabil über Exporte; neuere Exporte ergänzen nur neue Zeilen.
- **Bitget-API** (folgt): täglicher Vercel-Cron mit Read-Only-Key → `api_records`.

## Branches
`staging` (Vercel Preview) → PR (Squash) → `main` (Production).
