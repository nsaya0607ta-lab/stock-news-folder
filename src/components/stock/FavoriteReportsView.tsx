'use client';

/** お気に入りに登録したレポートの一覧。 */
import { useMemo } from 'react';
import { Header } from '@/components/views/Header';
import { useStock } from '@/store/StockStore';
import type { StockReportEntry } from '@/lib/stock/types';
import { ReportListPanel } from './ReportList';
import { StateBlock } from './StockBits';

export function FavoriteReportsView({
  onOpenReport,
}: {
  onOpenReport: (report: StockReportEntry) => void;
}) {
  const { reports, toggleReportFavorite } = useStock();
  const favorites = useMemo(() => reports.filter((entry) => entry.isFavorite), [reports]);

  return (
    <>
      <Header title="お気に入り" subtitle={`${favorites.length} 件のレポート`} />
      {favorites.length === 0 ? (
        <StateBlock
          title="お気に入りはまだありません"
          description="レポート一覧の星印を押すと、ここにまとめて表示されます。"
        />
      ) : (
        <div className="mt-3">
          <ReportListPanel
            reports={favorites}
            showTicker
            onOpen={onOpenReport}
            onToggleFavorite={(report) => void toggleReportFavorite(report.reportId)}
          />
        </div>
      )}
    </>
  );
}
