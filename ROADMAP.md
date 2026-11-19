# Roadmap

Stand: 19.11.2026. Reihenfolge = Empfehlung.

## 1. Absicherung (zuerst)

- [x] **Überwachung des täglichen Abrufs** (seit 17.11.2026 live) – Status im Dashboard und auf der System-Seite; E-Mail über Resend bei fehlgeschlagenem Lauf; Wächter-Cron `/api/cron/watchdog` (16:41 UTC) meldet > 48 h ohne Erfolg und hängengebliebene Läufe.
- [x] **Backups** (seit 17.11.2026 live, erster Lauf 2,8 MB) – `/api/backup` (seitenweise, Beträge als Text), Download-Knopf auf der System-Seite, wöchentliche GitHub-Action im privaten Repo `finance-cockpit-backup` (sonntags 03:23 UTC; Vorlage in `tools/backup/`).
  - [x] Wiederherstellung getestet (17.11.2026, `tools/backup/restore-test.mjs`): alle Tabellen vollständig und wertgleich, Summen = CoinTracking-CSV

- [x] **Karte „Ein- und Auszahlungen“** im Dashboard (17.11.2026), inkl. Euro-Einzahlungen per Überweisung (Bitget bucht sie als Kauf EUR → USDT)
  - [ ] Namen für bekannte Adressen (z. B. „KuCoin“), damit Herkunft/Ziel benannt sind

## 2. Daten vervollständigen

- [x] **Tageskurse je Coin** (öffentliche Bitget-Kerzen, live seit 18.11.2026; 42 von 73 Coins, 31 delistete Airdrop-Token ohne Kurs)
  - Earn-Bewertung: Einkünfte § 22 Nr. 3 EStG, Freigrenze 256 €
  - Anschaffungskosten der Zins-Bestände → Einstand und unrealisiert vollständig
  - [x] Wertverlauf des Portfolios (live seit 18.11.2026, PR #8)

## 3. Inhaltliche Erweiterungen

- [ ] **Haltefrist-Kalender**: je Spot-Bestand das Datum, ab dem er steuerfrei ist; Verkaufs-Simulation („wenn ich heute X verkaufe, was ist steuerpflichtig?“)
- [ ] **Steuerschätzung / Rücklage**: KAP-Saldo und SO-Ergebnis → grobe Steuerlast (Abgeltungsteuer, Soli, ggf. Kirchensteuer, Sparerpauschbetrag), klar als Schätzung gekennzeichnet
- [ ] **Trading-Journal Futures**: Positionen aus Fills rekonstruieren (ab ca. 09/2025) – Eröffnung bis Schließung, Haltedauer, Ø-Preise, Gebühren und Funding je Position; Notizen und Tags je Trade (Setup, ICT-Konzept, Sitzung, Fehler) mit Auswertung je Tag
- [ ] **Kostenanalyse**: Funding und Gebühren je Position/Haltedauer, Maker/Taker-Anteil im Zeitverlauf, Ersparnis bei Maker-Ausführung (Historie: Funding −900 USDT vs. Gebühren −161 USDT)
- [ ] **Prüfliste abhaken & Korrekturen**
  - [x] Seite `/korrekturen` mit Abgleich Bitget ↔ Buchungen und Anfangsbestand (live seit 18.11.2026); eingetragen: BGB, GRIMACE, ZRX (Kauf vor 08/2023, Tageswert geschätzt)
  - [ ] Einzahlungen von außen: echtes Kaufdatum und Kosten je Einzahlung (ohne Eintrag gilt Einzahlungstag + Tageswert, geschätzt – Entscheidung Mo 17.11.)
  - [ ] Warnungen auf der Steuer-Seite als „geprüft“ markieren
- [ ] **Jahresabschluss 2026** (Januar 2027): eingefrorener Snapshot (`report_snapshots`) und PDF für Steuererklärung / Steuerberater

## 4. KuCoin per API

- [x] Eigener Read-Only-Key („General“), KuCoin global (nicht EU); API liefert Kontobuchungen 1 Jahr rückwirkend (ab 20.11.2025), Export max. 100 Tage – nicht nötig
- [x] Rohdaten in `api_records` (source `kucoin`), täglicher Abruf (live seit 18.11.2026, PR #11); Inventur 18.11.: Earn-Erträge, Earn-Anlagen, Umbuchungen, Spot (DASH, SUPRA), Kleinstbetrag → KCS, Auszahlung ETH
- [x] Ledger: KuCoin aus CoinTracking (bis 08/2025) + API (ab 11/2025), Überweisungen zwischen Börsen verknüpft, FIFO je Börse (BMF 06.03.2025 walletbezogen) – auf staging 19.11.2026
- [x] Dashboard Alle/Bitget/KuCoin, Korrekturen je Börse – auf staging
- [ ] Offen: DASH-Verkauf 18.01.2026 ohne Kauf in den Daten (Anfangsbestand KuCoin nachtragen), FTM → S (Sonic) Token-Umstellung 01/2025, DFI/XMR-Reste bei KuCoin klären
- [ ] Optional: Tageskurse von KuCoin für Coins ohne Bitget-Kurs (z. B. KCS); Steuerberater: Bitget-Unterkonten als eine Wallet?

## 5. Technik (ohne Eile)

- [ ] GitHub Action: Typecheck und Tests bei jedem Pull Request
- [ ] Sicherheit: Content-Security-Policy-Header, Supabase „Leaked Password Protection“, jährliche Rotation des Bitget-Keys mit Erinnerung
- [ ] Performance: bei Bedarf Zusammenfassungen in die Datenbank verlagern (derzeit ~15.000 Buchungen im Browser)
- [ ] Weitere Broker per API; Dashboard ist für mehrere Broker vorbereitet

## Offene Prüfpunkte

- Earn-Bestände im Dashboard: Schnittstelle `/api/v2/earn/savings/assets` noch nicht mit echten Daten bestätigt
- FIFO pro Börse/Wallet vs. global: Methode mit Steuerberater bestätigen
- Perpetual Futures als Termingeschäfte (KAP): BMF-Schreiben 06.03.2025 regelt sie nicht ausdrücklich
