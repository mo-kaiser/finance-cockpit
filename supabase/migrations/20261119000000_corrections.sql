-- =============================================================================
-- Nachträge erweitern: Ausbuchung (z. B. delisteter Token) und Token-Umstellung
-- (z. B. FTM → S bei KuCoin, Kaufdatum und Einstand wandern mit).
-- Außerdem Leserechte des Servers (service_role) auf die Views für Crons.
-- =============================================================================

alter table public.manual_adjustments
	add column if not exists to_asset text,
	add column if not exists to_amount numeric;

alter table public.manual_adjustments drop constraint if exists manual_adjustments_kind_check;
alter table public.manual_adjustments
	add constraint manual_adjustments_kind_check
	check (kind in ('opening_balance', 'correction', 'write_off', 'token_swap'));

alter table public.manual_adjustments drop constraint if exists manual_adjustments_swap_check;
alter table public.manual_adjustments
	add constraint manual_adjustments_swap_check
	check (kind <> 'token_swap' or (to_asset is not null and to_amount > 0));

grant select on public.v_ledger, public.v_api_ledger to service_role;
