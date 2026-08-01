/**
 * 取得スケジュールの計算。
 *
 * 定期処理は一定間隔（既定10分）で起動し、「実行時刻を迎えた銘柄」だけを処理する。
 * ここではタイムゾーンを明示した日付計算だけを行い、副作用は持たない。
 */

export const DEFAULT_TIME_ZONE = 'Asia/Tokyo';

/** 取得頻度。 */
export const FREQUENCIES = ['daily', 'weekdays', 'weekly', 'manual'];

export const FREQUENCY_LABELS = {
  daily: '毎日',
  weekdays: '平日のみ',
  weekly: '曜日指定',
  manual: '手動のみ',
};

export const WEEKDAY_LABELS = ['日', '月', '火', '水', '木', '金', '土'];

/** アプリで選べるタイムゾーン。 */
export const TIME_ZONES = ['Asia/Tokyo', 'America/New_York', 'UTC'];

/**
 * 指定タイムゾーンでの日付・時刻を取り出す。
 * @returns {{date: string, time: string, minutes: number, weekday: number}}
 */
export function zonedParts(date = new Date(), timeZone = DEFAULT_TIME_ZONE) {
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    weekday: 'short',
    hourCycle: 'h23',
  });
  const map = Object.fromEntries(formatter.formatToParts(date).map((part) => [part.type, part.value]));
  const weekdayIndex = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(map.weekday);
  return {
    date: `${map.year}-${map.month}-${map.day}`,
    time: `${map.hour}:${map.minute}`,
    minutes: Number(map.hour) * 60 + Number(map.minute),
    weekday: weekdayIndex < 0 ? 0 : weekdayIndex,
  };
}

/** 「YYYY-MM-DD」から「YYYYMMDD」を作る。 */
export function compactDate(dateKey) {
  return String(dateKey ?? '').replaceAll('-', '');
}

/** 「HH:MM」を 0時からの分数へ。形式が不正なら null。 */
export function parseTime(value) {
  const match = /^(\d{1,2}):(\d{2})$/.exec(String(value ?? '').trim());
  if (!match) return null;
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (hour > 23 || minute > 59) return null;
  return hour * 60 + minute;
}

/** 分数を「HH:MM」へ。 */
export function formatTime(minutes) {
  const total = ((Math.round(Number(minutes) || 0) % 1440) + 1440) % 1440;
  return `${String(Math.floor(total / 60)).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`;
}

/** 日付キーに日数を足す（タイムゾーン内の暦日で計算する）。 */
export function addDays(dateKey, days) {
  const base = new Date(`${dateKey}T00:00:00Z`);
  base.setUTCDate(base.getUTCDate() + Number(days || 0));
  return base.toISOString().slice(0, 10);
}

/** 日付キーの曜日（0=日）。 */
export function weekdayOf(dateKey) {
  return new Date(`${dateKey}T00:00:00Z`).getUTCDay();
}

/** その日付が取得対象の曜日かどうか。 */
export function isScheduledDay(subscription, dateKey) {
  const frequency = subscription?.frequency ?? 'daily';
  if (frequency === 'manual') return false;
  const weekday = weekdayOf(dateKey);
  if (frequency === 'daily') return true;
  if (frequency === 'weekdays') return weekday >= 1 && weekday <= 5;
  if (frequency === 'weekly') {
    const days = Array.isArray(subscription?.weekdays) ? subscription.weekdays.map(Number) : [];
    return days.includes(weekday);
  }
  return false;
}

/**
 * 実行時刻を迎えているか（同じ日に成功済みなら false）。
 * @param subscription 購読設定
 * @param now zonedParts の結果（購読設定のタイムゾーンで求めたもの）
 */
export function isDue(subscription, now) {
  if (!subscription?.enabled) return false;
  if (!isScheduledDay(subscription, now.date)) return false;
  const target = parseTime(subscription.time);
  if (target === null) return false;
  if (now.minutes < target) return false;
  // 同じ日に成功していれば再実行しない（冪等性）。失敗した日だけ再試行する。
  if (subscription.lastRunDate === now.date && subscription.lastRunStatus !== 'failed') return false;
  return true;
}

/**
 * 次回の取得予定時刻を ISO 文字列で返す。
 * 手動のみ、または無効の場合は null。
 */
export function nextRunAt(subscription, from = new Date()) {
  if (!subscription?.enabled) return null;
  const timeZone = subscription.timeZone || DEFAULT_TIME_ZONE;
  const target = parseTime(subscription.time);
  if (target === null || subscription.frequency === 'manual') return null;

  const now = zonedParts(from, timeZone);
  for (let offset = 0; offset <= 14; offset += 1) {
    const dateKey = addDays(now.date, offset);
    if (!isScheduledDay(subscription, dateKey)) continue;
    if (offset === 0) {
      // 当日分がまだ実行されておらず、時刻も過ぎていなければ当日が次回。
      if (now.minutes < target) return zonedIso(dateKey, target, timeZone);
      // 時刻を過ぎていて未実行なら「まもなく実行」。
      if (subscription.lastRunDate !== dateKey) return zonedIso(dateKey, target, timeZone);
      continue;
    }
    return zonedIso(dateKey, target, timeZone);
  }
  return null;
}

/**
 * 「タイムゾーン上の日付＋分」を UTC の ISO 文字列へ変換する。
 * 夏時間の切り替え日でもずれないよう、実際のオフセットを測って補正する。
 */
export function zonedIso(dateKey, minutes, timeZone = DEFAULT_TIME_ZONE) {
  // 目標の「見た目の時刻」をいったん UTC として数値化する。
  const wanted = Date.parse(`${dateKey}T${formatTime(minutes)}:00Z`);
  let instant = wanted;
  // 実際にそのタイムゾーンで表示される時刻とのずれを 2 回まで補正する
  // （夏時間の切り替え日でも 1 回の補正で収束する）。
  for (let index = 0; index < 3; index += 1) {
    const parts = zonedParts(new Date(instant), timeZone);
    const shown = Date.parse(`${parts.date}T${formatTime(parts.minutes)}:00Z`);
    const diff = wanted - shown;
    if (diff === 0) break;
    instant += diff;
  }
  return new Date(instant).toISOString();
}

/** 対象期間（前回実行から今回まで。最大 7 日）を求める。 */
export function reportPeriod(subscription, runDate) {
  const lastDate = typeof subscription?.lastRunDate === 'string' ? subscription.lastRunDate : '';
  const earliest = addDays(runDate, -7);
  const from = lastDate && lastDate > earliest && lastDate <= runDate ? lastDate : addDays(runDate, -1);
  return { from, to: runDate };
}
