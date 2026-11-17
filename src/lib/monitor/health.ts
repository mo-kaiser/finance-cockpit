/**
 * Zustand des täglichen Bitget-Abrufs aus der Tabelle `imports` (source = 'bitget_api').
 * Reine Funktionen ohne Datenbank, damit Dashboard, System-Seite und Wächter-Cron dieselbe Regel nutzen.
 */

export interface SyncRun {
	id: string;
	status: 'running' | 'done' | 'failed';
	note: string | null;
	created_at: string;
	finished_at: string | null;
}

export interface SyncHealth {
	/** ok = alles gut, warn = letzter Lauf fehlgeschlagen, error = zu lange kein Erfolg */
	level: 'ok' | 'warn' | 'error';
	lastSuccess: string | null;
	lastRun: SyncRun | null;
	/** Stunden seit dem letzten erfolgreichen Lauf (null = noch nie) */
	hoursSinceSuccess: number | null;
	/** Läufe, die seit über STUCK_MINUTES auf „running“ stehen (Zeitlimit überschritten o. ä.) */
	stuck: SyncRun[];
	problems: string[];
}

/** Ab so vielen Stunden ohne erfolgreichen Lauf wird gewarnt (Roadmap: 2 Tage). */
export const MAX_HOURS_WITHOUT_SUCCESS = 48;
/** Ein Lauf darf höchstens 60 s dauern (maxDuration); danach gilt er als abgebrochen. */
export const STUCK_MINUTES = 15;

const HOUR = 3_600_000;

/** Bewertet die letzten Läufe (beliebige Reihenfolge). */
export function assessSync(runs: SyncRun[], now = Date.now()): SyncHealth {
	const sorted = [...runs].sort((a, b) => b.created_at.localeCompare(a.created_at));
	const lastRun = sorted[0] ?? null;
	const lastOk = sorted.find((r) => r.status === 'done');
	const lastSuccess = lastOk ? (lastOk.finished_at ?? lastOk.created_at) : null;
	const hoursSinceSuccess = lastSuccess ? (now - Date.parse(lastSuccess)) / HOUR : null;
	const stuck = sorted.filter((r) => r.status === 'running' && now - Date.parse(r.created_at) > STUCK_MINUTES * 60_000);

	const problems: string[] = [];
	if (hoursSinceSuccess === null) problems.push('Noch kein erfolgreicher Abruf.');
	else if (hoursSinceSuccess > MAX_HOURS_WITHOUT_SUCCESS)
		problems.push(`Seit ${Math.floor(hoursSinceSuccess)} Stunden kein erfolgreicher Abruf.`);
	if (lastRun?.status === 'failed') problems.push(`Letzter Lauf fehlgeschlagen: ${lastRun.note ?? 'ohne Meldung'}`);
	for (const r of stuck) problems.push(`Lauf vom ${r.created_at} wurde nicht beendet (vermutlich Zeitlimit).`);

	const tooOld = hoursSinceSuccess === null || hoursSinceSuccess > MAX_HOURS_WITHOUT_SUCCESS;
	const level = tooOld ? 'error' : problems.length ? 'warn' : 'ok';
	return { level, lastSuccess, lastRun, hoursSinceSuccess, stuck, problems };
}

/** „vor 5 Std.“ / „vor 2 Tagen“ */
export function ago(iso: string | null, now = Date.now()): string {
	if (!iso) return 'noch nie';
	const h = (now - Date.parse(iso)) / HOUR;
	if (h < 1) return `vor ${Math.max(1, Math.round(h * 60))} Min.`;
	if (h < 48) return `vor ${Math.round(h)} Std.`;
	return `vor ${Math.floor(h / 24)} Tagen`;
}

/** Datum und Uhrzeit in Europe/Berlin */
export const berlin = (iso: string | null) =>
	iso
		? new Date(iso).toLocaleString('de-DE', { timeZone: 'Europe/Berlin', dateStyle: 'short', timeStyle: 'short' })
		: '–';
