/** 表示用の整形ユーティリティ。 */

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '-';
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let value = bytes / 1024;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }
  return `${value >= 100 ? Math.round(value) : value.toFixed(1)} ${units[unitIndex]}`;
}

export function formatDateTime(iso?: string): string {
  if (!iso) return '-';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '-';
  const y = date.getFullYear();
  const m = `${date.getMonth() + 1}`.padStart(2, '0');
  const d = `${date.getDate()}`.padStart(2, '0');
  const hh = `${date.getHours()}`.padStart(2, '0');
  const mm = `${date.getMinutes()}`.padStart(2, '0');
  return `${y}/${m}/${d} ${hh}:${mm}`;
}

export function formatDate(iso?: string): string {
  if (!iso) return '-';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '-';
  return `${date.getFullYear()}/${`${date.getMonth() + 1}`.padStart(2, '0')}/${`${date.getDate()}`.padStart(2, '0')}`;
}

/** 相対表記 (最近使った項目などで使用)。 */
export function formatRelative(iso?: string): string {
  if (!iso) return '-';
  const time = new Date(iso).getTime();
  if (Number.isNaN(time)) return '-';
  const diff = Date.now() - time;
  const minute = 60_000;
  const hour = 60 * minute;
  const day = 24 * hour;
  if (diff < minute) return 'たった今';
  if (diff < hour) return `${Math.floor(diff / minute)}分前`;
  if (diff < day) return `${Math.floor(diff / hour)}時間前`;
  if (diff < 7 * day) return `${Math.floor(diff / day)}日前`;
  return formatDate(iso);
}

/** 残り日数 (ごみ箱の自動削除)。 */
export function daysUntilPurge(deletedAt: string | undefined, retentionDays: number): number {
  if (!deletedAt) return retentionDays;
  const elapsed = Date.now() - new Date(deletedAt).getTime();
  return Math.max(0, retentionDays - Math.floor(elapsed / 86_400_000));
}

/**
 * 長いファイル名の中央を省略する。
 * 拡張子は残し、先頭側を多めに見せる。
 */
export function middleEllipsis(name: string, max = 28): string {
  if (name.length <= max) return name;
  const dot = name.lastIndexOf('.');
  const ext = dot > 0 && name.length - dot <= 6 ? name.slice(dot) : '';
  const base = ext ? name.slice(0, dot) : name;
  const keep = max - ext.length - 1;
  if (keep < 6) return `${name.slice(0, max - 1)}…`;
  const head = Math.ceil(keep * 0.6);
  const tail = keep - head;
  return `${base.slice(0, head)}…${base.slice(base.length - tail)}${ext}`;
}
