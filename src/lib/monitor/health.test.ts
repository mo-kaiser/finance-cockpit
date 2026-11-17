import { describe, expect, it } from 'vitest';
import { ago, assessSync, type SyncRun } from './health';

const now = Date.parse('2026-11-11T12:00:00Z');
const run = (created: string, status: SyncRun['status'], note: string | null = null): SyncRun => ({
	id: created,
	status,
	note,
	created_at: created,
	finished_at: status === 'running' ? null : created
});

describe('assessSync', () => {
	it('ok bei erfolgreichem Lauf heute', () => {
		const h = assessSync([run('2026-11-11T04:17:00Z', 'done'), run('2026-11-10T04:17:00Z', 'done')], now);
		expect(h.level).toBe('ok');
		expect(h.problems).toEqual([]);
		expect(Math.round(h.hoursSinceSuccess!)).toBe(8);
	});

	it('warn, wenn der letzte Lauf fehlschlug, der vorige aber erfolgreich war', () => {
		const h = assessSync([run('2026-11-10T04:17:00Z', 'done'), run('2026-11-11T04:17:00Z', 'failed', 'x')], now);
		expect(h.level).toBe('warn');
		expect(h.problems[0]).toContain('fehlgeschlagen');
	});

	it('error nach über 48 Stunden ohne Erfolg', () => {
		const h = assessSync([run('2026-11-09T04:17:00Z', 'done'), run('2026-11-10T04:17:00Z', 'failed')], now);
		expect(h.level).toBe('error');
		expect(h.problems[0]).toContain('Seit 55 Stunden');
	});

	it('error ohne jeden Lauf', () => {
		expect(assessSync([], now).level).toBe('error');
	});

	it('erkennt hängengebliebene Läufe, aber nicht laufende', () => {
		const h = assessSync(
			[run('2026-11-11T04:17:00Z', 'done'), run('2026-11-11T11:00:00Z', 'running'), run('2026-11-11T11:55:00Z', 'running')],
			now
		);
		expect(h.stuck.map((r) => r.id)).toEqual(['2026-11-11T11:00:00Z']);
		expect(h.level).toBe('warn');
	});
});

describe('ago', () => {
	it('formatiert Abstände', () => {
		expect(ago(null, now)).toBe('noch nie');
		expect(ago('2026-11-11T11:30:00Z', now)).toBe('vor 30 Min.');
		expect(ago('2026-11-11T04:00:00Z', now)).toBe('vor 8 Std.');
		expect(ago('2026-11-08T12:00:00Z', now)).toBe('vor 3 Tagen');
	});
});
