-- Server-Zugriff mit dem Secret Key (Rolle service_role) für den Bitget-Cron.
-- service_role umgeht RLS, braucht aber – da neue Tabellen nicht automatisch
-- freigegeben werden – ausdrückliche Tabellenrechte.
grant usage on schema public to service_role;
grant select, insert, update, delete on all tables in schema public to service_role;
grant usage, select on all sequences in schema public to service_role;
