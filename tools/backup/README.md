# Cockpit-Sicherung

Vorlage für das private Repository `mo-kaiser/finance-cockpit-backup`:

- `backup.mjs` → ins Hauptverzeichnis des Backup-Repos
- `backup.yml` → nach `.github/workflows/backup.yml`
- Repository-Secret `BACKUP_SECRET` = derselbe Wert wie die Vercel-Variable `BACKUP_SECRET`

Die Action läuft sonntags und schreibt `data/<tabelle>.ndjson.gz` (api_records je Monat).
Jede Zeile ist ein Datensatz wie in der Datenbank; Beträge (`numeric`) und JSON-Rohdaten (`raw`, `summary` …)
stehen als Text, damit nichts gerundet wird. Abgeleitete Spalten (`ct_rows.venue/account`) fehlen,
sie entstehen beim Einspielen neu. `manifest.json` nennt Zeitpunkt und Zeilenzahl je Tabelle.

Schlägt die Action fehl, schickt GitHub eine E-Mail.
