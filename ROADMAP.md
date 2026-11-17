# Roadmap

Stand: 11.11.2026. Reihenfolge = Empfehlung.

## 1. Absicherung (zuerst)

- [x] **Überwachung des täglichen Abrufs** (11/2026, auf staging, Einrichtung durch Mo offen) – Status im Dashboard und auf der System-Seite; E-Mail über Resend bei fehlgeschlagenem Lauf; Wächter-Cron `/api/cron/watchdog` (16:41 UTC) meldet > 48 h ohne Erfolg und hängengebliebene Läufe.
- [x] **Backups** (11/2026, auf staging, Einrichtung durch Mo offen) – `/api/backup` (seitenweise, Beträge als Text), Download-Knopf auf der System-Seite, wöchentliche GitHub-Action im privaten Repo `finance-cockpit-backup` (Vorlage in `tools/backup/`).
  - [ ] Wiederherstellung einmal testen (Sicherung in Test-Postgres einspielen, Summen vergleichen)

## 2. Daten vervollständigen

- [ ] **Tageskurse je Coin** (öffentliche Bitget-Kerzen)
  - Earn-Bewertung: Einkünfte § 22 Nr. 3 EStG, Freigrenze 256 €
  - Anschaffungskosten der Zins-Bestände → Einstand und unrealisiert vollständig
  - Wertverlauf des Portfolios

## 3. Inhaltliche Erweiterungen

- [ ] **Haltefrist-Kalender**: je Spot-Bestand das Datum, ab dem er steuerfrei ist; Verkaufs-Simulation („wenn ich heute X verkaufe, was ist steuerpflichtig?“)
- [ ] **Steuerschätzung / Rücklage**: KAP-Saldo und SO-Ergebnis → grobe Steuerlast (Abgeltungsteuer, Soli, ggf. Kirchensteuer, Sparerpauschbetrag), klar als Schätzung gekennzeichnet
- [ ] **Trading-Journal Futures**: Positionen aus Fills rekonstruieren (ab ca. 09/2025) – Eröffnung bis Schließung, Haltedauer, Ø-Preise, Gebühren und Funding je Position; Notizen und Tags je Trade (Setup, ICT-Konzept, Sitzung, Fehler) mit Auswertung je Tag
- [ ] **Kostenanalyse**: Funding und Gebühren je Position/Haltedauer, Maker/Taker-Anteil im Zeitverlauf, Ersparnis bei Maker-Ausführung (Historie: Funding −900 USDT vs. Gebühren −161 USDT)
- [ ] **Prüfliste abhaken & Korrekturen**: Warnungen auf der Steuer-Seite als „geprüft“ markieren; fehlende Anschaffungsdaten (z. B. DOT, MINA) über eine Maske nachtragen (`manual_adjustments`)
- [ ] **Jahresabschluss 2026** (Januar 2027): eingefrorener Snapshot (`report_snapshots`) und PDF für Steuererklärung / Steuerberater

## 4. KuCoin per API

- [ ] Ursache des API-Fehlers bei CoinTracking klären; eigenen Read-Only-Key für das Cockpit anlegen
- [ ] Reichweiten-Prüfung und Inventur der KuCoin-Buchungsarten (wie bei Bitget), Spot/Trading, Funding, ggf. Futures (eigene API)
- [ ] Rohdaten in `api_records` (source `kucoin`), täglicher Abruf; Dedup gegen den CoinTracking-Import (KuCoin-Historie bis 08/2025)
- [ ] Steuer: Ledger-View und Mapper je Börse; FIFO-Bestände je Börse statt je Coin global (Methode mit Steuerberater bestätigen)
- [ ] Dashboard/Analysen: Broker-Auswahl Bitget / KuCoin / alle

## 5. Technik (ohne Eile)

- [ ] GitHub Action: Typecheck und Tests bei jedem Pull Request
- [ ] Sicherheit: Content-Security-Policy-Header, Supabase „Leaked Password Protection“, jährliche Rotation des Bitget-Keys mit Erinnerung
- [ ] Performance: bei Bedarf Zusammenfassungen in die Datenbank verlagern (derzeit ~15.000 Buchungen im Browser)
- [ ] Weitere Broker per API; Dashboard ist für mehrere Broker vorbereitet

## Offene Prüfpunkte

- Earn-Bestände im Dashboard: Schnittstelle `/api/v2/earn/savings/assets` noch nicht mit echten Daten bestätigt
- FIFO pro Börse/Wallet vs. global: Methode mit Steuerberater bestätigen
- Perpetual Futures als Termingeschäfte (KAP): BMF-Schreiben 06.03.2025 regelt sie nicht ausdrücklich
