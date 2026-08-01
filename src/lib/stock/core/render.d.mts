import type { StockReport } from './report.d.mts';

export function escapeHtml(value: unknown): string;
export function renderReportHtml(report: StockReport): string;
