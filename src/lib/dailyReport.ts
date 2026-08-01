/**
 * 毎朝の学習レポート PDF の自動取り込み。
 *
 * GitHub Actions が毎朝 5 時に PDF を生成し、`public/daily/` へコミットする。
 * Vercel がそれを静的ファイルとして配信するので、アプリは同一オリジンの
 * `/daily/index.json` を見て、まだ取り込んでいない分だけを回収する。
 *
 * shareTarget.ts と同じく「起動時に外部から届いた PDF を集めて返すだけ」に
 * 徹し、実際の登録 (重複処理・Blob 保存) は repository.addPdf に任せる。
 *
 * オフラインや未生成の場合は例外を投げず空配列を返す。毎回の起動で静かに
 * 失敗してよい機能であり、ここでエラーを出すとアプリの起動体験を損なうため。
 */

const INDEX_URL = '/daily/index.json';

/** 1 回の起動で取り込む上限。初回に何十件も落とさないための保険。 */
const MAX_PER_RUN = 5;

/** index.json の 1 エントリー。 */
type ReportEntry = {
  /** 取り込み済み判定に使う一意な ID (生成日 `YYYY-MM-DD`)。 */
  id: string;
  /** `public/daily/` からの相対ファイル名。 */
  file: string;
  /** アプリ内で付けるファイル名。 */
  name?: string;
};

export type PendingReport = { id: string; name: string; blob: Blob };

function isReportEntry(value: unknown): value is ReportEntry {
  if (!value || typeof value !== 'object') return false;
  const entry = value as Partial<ReportEntry>;
  if (typeof entry.id !== 'string' || !entry.id) return false;
  if (typeof entry.file !== 'string' || !entry.file) return false;
  // 配信元は自分のリポジトリだが、万一おかしな値が入っても
  // 親ディレクトリへ抜けられないようにしておく
  return !entry.file.includes('/') && !entry.file.includes('\\');
}

/**
 * まだ取り込んでいないレポートを取得する。
 *
 * @param imported 取り込み済みレポートの ID 一覧 (Settings.importedReports)
 */
export async function fetchPendingReports(imported: string[]): Promise<PendingReport[]> {
  if (typeof fetch === 'undefined') return [];

  let entries: ReportEntry[];
  try {
    // Service Worker は /_next/static/ 以外を networkFirst で扱うが、
    // ここは常に最新を見たいのでブラウザーキャッシュも明示的に無効化する
    const response = await fetch(INDEX_URL, { cache: 'no-store' });
    if (!response.ok) return [];
    const data: unknown = await response.json();
    const list = Array.isArray(data)
      ? data
      : (data as { reports?: unknown })?.reports;
    if (!Array.isArray(list)) return [];
    entries = list.filter(isReportEntry);
  } catch {
    // オフライン、または index.json がまだ存在しない
    return [];
  }

  const done = new Set(imported);
  const targets = entries
    .filter((entry) => !done.has(entry.id))
    // 日付 ID の新しい順に並べ、古いものが溜まっていても直近から取り込む
    .sort((a, b) => b.id.localeCompare(a.id))
    .slice(0, MAX_PER_RUN);

  const results: PendingReport[] = [];
  for (const entry of targets) {
    try {
      const response = await fetch(`/daily/${entry.file}`, { cache: 'no-store' });
      if (!response.ok) continue;
      const blob = await response.blob();
      if (blob.size === 0) continue;
      results.push({
        id: entry.id,
        name: entry.name || entry.file,
        blob,
      });
    } catch {
      // 1 件失敗しても他は続行する。取り込めなかった分は
      // importedReports に記録されないので次回の起動で再試行される
    }
  }
  return results;
}
