<script lang="ts">
	import { onMount } from 'svelte';
	import type { Chart as ChartType } from 'chart.js';

	interface Props {
		labels: string[];
		values: number[];
		/** Fläche unter der Linie einfärben (grün über, rot unter Null). */
		fill?: boolean;
		height?: number;
		format?: (v: number) => string;
		/** Optionale zweite Linie (gestrichelt, ohne Fläche), z. B. Netto-Einzahlungen */
		values2?: number[];
		label?: string;
		label2?: string;
	}
	let { labels, values, fill = true, height = 240, format = (v) => v.toLocaleString('de-DE'), values2, label = '', label2 = '' }: Props = $props();

	let canvas: HTMLCanvasElement;
	let chart: ChartType | null = null;

	const css = (name: string) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();

	function config() {
		const up = css('--chart-1');
		const down = css('--chart-2');
		return {
			type: 'line' as const,
			data: {
				labels,
				datasets: [
					{
						data: values,
						borderColor: up,
						borderWidth: 2,
						pointRadius: 0,
						tension: 0.15,
						fill: fill ? { target: 'origin', above: up + '22', below: down + '22' } : false,
						segment: { borderColor: (ctx: { p1: { parsed: { y: number } } }) => (ctx.p1.parsed.y < 0 ? down : up) },
						label
					},
					...(values2
						? [{ data: values2, borderColor: css('--chart-3') || css('--muted'), borderWidth: 2, borderDash: [6, 4], pointRadius: 0, tension: 0, fill: false, label: label2 }]
						: [])
				]
			},
			options: {
				responsive: true,
				maintainAspectRatio: false,
				animation: false as const,
				interaction: { mode: 'index' as const, intersect: false },
				plugins: {
					legend: { display: false },
					tooltip: {
						callbacks: {
							label: (c: { parsed: { y: number }; dataset: { label?: string } }) => `${c.dataset.label ? c.dataset.label + ': ' : ''}${format(c.parsed.y)}`
						}
					}
				},
				scales: {
					x: { grid: { display: false }, ticks: { color: css('--muted'), maxTicksLimit: 8, maxRotation: 0 } },
					y: { grid: { color: css('--chart-grid') }, ticks: { color: css('--muted'), callback: (v: string | number) => format(Number(v)) } }
				}
			}
		};
	}

	onMount(() => {
		let disposed = false;
		import('chart.js/auto').then(({ default: Chart }) => {
			if (disposed) return;
			chart = new Chart(canvas, config() as never);
		});
		return () => {
			disposed = true;
			chart?.destroy();
		};
	});

	$effect(() => {
		// bei neuen Daten aktualisieren
		void labels;
		void values;
		void values2;
		if (!chart) return;
		chart.data.labels = labels;
		chart.data.datasets[0]!.data = values;
		if (values2 && chart.data.datasets[1]) chart.data.datasets[1].data = values2;
		chart.update();
	});
</script>

<div style="position:relative;height:{height}px">
	<canvas bind:this={canvas}></canvas>
</div>
