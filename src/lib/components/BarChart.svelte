<script lang="ts">
	import { onMount } from 'svelte';
	import type { Chart as ChartType } from 'chart.js';

	interface Props {
		labels: string[];
		values: number[];
		height?: number;
		format?: (v: number) => string;
	}
	let { labels, values, height = 220, format = (v) => v.toLocaleString('de-DE') }: Props = $props();

	let canvas: HTMLCanvasElement;
	let chart: ChartType | null = null;
	const css = (name: string) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();

	onMount(() => {
		let disposed = false;
		import('chart.js/auto').then(({ default: Chart }) => {
			if (disposed) return;
			chart = new Chart(canvas, {
				type: 'bar',
				data: { labels, datasets: [{ data: values, backgroundColor: css('--chart-1'), borderRadius: 4, maxBarThickness: 36 }] },
				options: {
					responsive: true,
					maintainAspectRatio: false,
					animation: false,
					plugins: { legend: { display: false }, tooltip: { callbacks: { label: (c) => format(Number(c.parsed.y)) } } },
					scales: {
						x: { grid: { display: false }, ticks: { color: css('--muted'), maxRotation: 0, autoSkip: true } },
						y: { grid: { color: css('--chart-grid') }, ticks: { color: css('--muted'), callback: (v) => format(Number(v)) } }
					}
				}
			});
		});
		return () => {
			disposed = true;
			chart?.destroy();
		};
	});

	$effect(() => {
		void labels;
		void values;
		if (!chart) return;
		chart.data.labels = labels;
		chart.data.datasets[0]!.data = values;
		chart.update();
	});
</script>

<div style="position:relative;height:{height}px">
	<canvas bind:this={canvas}></canvas>
</div>
