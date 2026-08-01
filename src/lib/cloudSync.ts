/**
 * 「どの PDF をクラウドへ移すか / どのキャッシュを片付けるか」の判定。
 *
 * PWA はアプリを閉じている間に処理を続けられないため、
 *   - アプリ起動時
 *   - オンライン復帰時
 *   - 画面表示の復帰時 (ホーム画面版をもう一度開いたとき)
 * の 3 つのタイミングで対象を選び直す。ここは副作用のない純粋な判定だけを置き、
 * 実際の通信は cloudStorage、実行の制御は CloudStore が担当する。
 */
import { isBusy } from './cloudStorage';
import { storageStateOf, type PdfFileMeta, type Settings } from './types';

export const DAY_MS = 86_400_000;

/** 「最後に使った時刻」。一度も開いていない PDF は登録日時を使う。 */
export function lastUsedAt(file: PdfFileMeta): string {
  return file.lastOpenedAt ?? file.createdAt;
}

function elapsedDaysReached(iso: string | undefined, days: number, now: number): boolean {
  if (!iso) return false;
  const time = new Date(iso).getTime();
  if (!Number.isFinite(time)) return false;
  return now - time >= days * DAY_MS;
}

/**
 * クラウドへ移す対象か。次をすべて満たすものだけが対象になる。
 *   - 最後に開いてから (未閲覧なら登録から) 指定日数以上たっている
 *   - ごみ箱に入っていない
 *   - クラウド移動処理中ではない
 *   - すでにクラウド保管済みではない
 *   - PDF 本体が端末内にある (実際の有無は実行時にもう一度確認する)
 */
export function isUploadCandidate(file: PdfFileMeta, idleDays: number, now: number): boolean {
  // 負の日数は「自動移動しない」。0 は「経過時間を問わずすべて」(手動実行で使う)。
  if (idleDays < 0) return false;
  if (file.deletedAt) return false;
  const state = storageStateOf(file);
  // error は「前回失敗して端末内に残っている」状態なので再試行の対象にする
  if (state !== 'local' && state !== 'error') return false;
  if (isBusy(file.id)) return false;
  return elapsedDaysReached(lastUsedAt(file), idleDays, now);
}

/**
 * 端末内キャッシュを片付ける対象か。
 * 一度クラウドから取得した PDF が、また指定日数ぶん使われなかった場合に
 * 「クラウドのみ」の状態へ戻す。クラウド上の実体は消さない。
 */
export function isEvictCandidate(file: PdfFileMeta, idleDays: number, now: number): boolean {
  if (idleDays < 0) return false;
  if (storageStateOf(file) !== 'cloud') return false;
  if (!file.cloudPath || !file.localCachedAt) return false;
  if (isBusy(file.id)) return false;
  // 「最後に開いた時刻」と「端末へ取得した時刻」の新しい方から数える。
  // 共有や印刷のために取得しただけ (= 開いてはいない) のキャッシュを
  // すぐ捨ててしまい、直後の閲覧でまた通信する、という無駄を避ける。
  const since =
    file.lastOpenedAt && file.lastOpenedAt > file.localCachedAt
      ? file.lastOpenedAt
      : file.localCachedAt;
  return elapsedDaysReached(since, idleDays, now);
}

/**
 * 自動実行で使う未使用日数。設定が「自動移動しない」なら -1 (対象なし)。
 */
export function autoIdleDays(settings: Settings): number {
  return settings.cloudIdleDays > 0 ? settings.cloudIdleDays : -1;
}

/**
 * 手動実行 (「今すぐ対象ファイルをクラウドへ移動」) で使う未使用日数。
 * 「自動移動しない」を選んでいる場合でも、手動なら経過時間を問わず移動できる。
 */
export function manualIdleDays(settings: Settings): number {
  return settings.cloudIdleDays > 0 ? settings.cloudIdleDays : 0;
}

export function pickUploadCandidates(
  files: PdfFileMeta[],
  settings: Settings,
  options: { manual?: boolean; now?: number } = {},
): PdfFileMeta[] {
  if (!settings.cloudEnabled) return [];
  const now = options.now ?? Date.now();
  const idleDays = options.manual ? manualIdleDays(settings) : autoIdleDays(settings);
  return files
    .filter((file) => isUploadCandidate(file, idleDays, now))
    // 使っていない期間が長いものから順に処理する
    .sort((a, b) => lastUsedAt(a).localeCompare(lastUsedAt(b)));
}

export function pickEvictCandidates(
  files: PdfFileMeta[],
  settings: Settings,
  options: { manual?: boolean; now?: number } = {},
): PdfFileMeta[] {
  if (!settings.cloudEnabled) return [];
  const now = options.now ?? Date.now();
  const idleDays = options.manual ? manualIdleDays(settings) : autoIdleDays(settings);
  return files.filter((file) => isEvictCandidate(file, idleDays, now));
}

/* ------------------------------------------------------------------ */
/* 接続状態                                                            */
/* ------------------------------------------------------------------ */

export type NetworkKind = 'offline' | 'wifi' | 'cellular' | 'unknown';

type NetworkInformation = {
  type?: string;
  effectiveType?: string;
  saveData?: boolean;
};

function connection(): NetworkInformation | undefined {
  if (typeof navigator === 'undefined') return undefined;
  const nav = navigator as Navigator & {
    connection?: NetworkInformation;
    mozConnection?: NetworkInformation;
    webkitConnection?: NetworkInformation;
  };
  return nav.connection ?? nav.mozConnection ?? nav.webkitConnection;
}

/**
 * いまの接続の種類。
 *
 * iPhone の Safari は Network Information API を持たないため、多くの場合 `unknown` になる。
 * 判定できない環境で「Wi-Fi のときだけ」を厳密に適用すると永久にアップロードできないので、
 * `unknown` は許可扱いにし、その旨を設定画面へ明記している。
 */
export function networkKind(): NetworkKind {
  if (typeof navigator !== 'undefined' && navigator.onLine === false) return 'offline';
  const info = connection();
  if (!info) return 'unknown';
  if (info.saveData) return 'cellular';
  const type = info.type;
  if (type === 'wifi' || type === 'ethernet') return 'wifi';
  if (type === 'cellular') return 'cellular';
  if (info.effectiveType && ['slow-2g', '2g', '3g'].includes(info.effectiveType)) return 'cellular';
  return 'unknown';
}

/** いまアップロードしてよいか。 */
export function canUploadNow(settings: Settings): { ok: boolean; reason?: string } {
  const kind = networkKind();
  if (kind === 'offline') return { ok: false, reason: 'オフラインのため待機しています。' };
  if (settings.cloudWifiOnly && kind === 'cellular') {
    return { ok: false, reason: 'モバイル通信のため待機しています（Wi-Fi接続時にアップロードします）。' };
  }
  return { ok: true };
}
