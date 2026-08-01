/**
 * 自動分類ルールの判定。
 *
 * ここは「どのルールに一致するか」を決めるだけで、PDF の移動は一切行わない。
 * 実際の移動は classifyRun.ts が担当する。テスト実行 (移動せずに結果だけ見る) が
 * 同じ判定をそのまま使えるよう、判定と移動をはっきり分けている。
 *
 * 判定順序:
 *   1. 無効なルール・条件が 0 件のルールは対象外
 *   2. 優先順位 (priority) の小さい順に評価する
 *   3. 条件は「すべて一致 (all)」か「いずれか一致 (any)」で束ねる
 *   4. 複数一致したときの扱いは設定 (MultiMatchStrategy) による
 *
 * PDF 本文の読み取りは重いので、本文条件を含むルールに当たったときだけ、
 * 1 ファイルにつき 1 回だけ行い、結果を使い回す。
 */
import {
  ORIGIN_LABELS,
  RULE_FIELD_LABELS,
  type ClassifyRule,
  type MultiMatchStrategy,
  type PdfFileMeta,
  type PdfOrigin,
  type RuleCondition,
} from './types';

/** 判定の対象。本文は必要になったときだけ読む。 */
export type ClassifyTarget = {
  file: PdfFileMeta;
  /**
   * PDF 本文を取り出す関数。
   * 本文条件を持つルールを評価するときだけ呼ばれる。渡さなければ本文条件は不一致。
   */
  readText?: () => Promise<string>;
};

/** 1 ファイル分の判定中に使う一時キャッシュ (本文を 2 回読まないため)。 */
type TextCache = { text?: string; loaded: boolean };

function newCache(): TextCache {
  return { loaded: false };
}

/* ------------------------------------------------------------------ */
/* 文字列の比較                                                        */
/* ------------------------------------------------------------------ */

/**
 * 比較用に文字を揃える。
 * 検索 (search.ts) と同じ方針で、大文字小文字・全角半角・ひらがなカタカナの
 * 違いを無視する。「領収書」と「領収書」のような表記ゆれで取りこぼさないため。
 */
export function normalizeText(value: string): string {
  return value
    .toLowerCase()
    .normalize('NFKC')
    .replace(/[ぁ-ゖ]/g, (char) => String.fromCharCode(char.charCodeAt(0) + 0x60));
}

function includes(haystack: string, needle: string): boolean {
  return normalizeText(haystack).includes(normalizeText(needle));
}

function startsWith(haystack: string, needle: string): boolean {
  return normalizeText(haystack).startsWith(normalizeText(needle));
}

function endsWith(haystack: string, needle: string): boolean {
  return normalizeText(haystack).endsWith(normalizeText(needle));
}

/** 「ファイル名が指定文字で終わる」は拡張子を除いた部分で判定する。 */
function baseName(name: string): string {
  return name.replace(/\.pdf$/i, '');
}

/** ファイル形式の候補 (`pdf` と、画像から作った場合は元の画像形式)。 */
function formatsOf(file: PdfFileMeta): string[] {
  const extension = file.name.includes('.') ? file.name.split('.').pop() ?? '' : '';
  return [extension || 'pdf', ...(file.sourceFormats ?? [])].filter(Boolean);
}

function originOf(file: PdfFileMeta): PdfOrigin {
  return file.origin ?? 'unknown';
}

/* ------------------------------------------------------------------ */
/* 数値・日付の比較                                                    */
/* ------------------------------------------------------------------ */

function matchNumber(value: number, condition: RuleCondition): boolean {
  const { compare = 'atLeast', min, max } = condition;
  if (compare === 'atMost') return max !== undefined ? value <= max : min !== undefined && value <= min;
  if (compare === 'between') {
    if (min !== undefined && value < min) return false;
    if (max !== undefined && value > max) return false;
    return min !== undefined || max !== undefined;
  }
  return min !== undefined && value >= min;
}

function matchDate(iso: string | undefined, condition: RuleCondition): boolean {
  if (!iso) return false;
  const day = iso.slice(0, 10);
  const { compare = 'atLeast', from, to, days } = condition;

  if (compare === 'withinDays') {
    if (days === undefined || days <= 0) return false;
    const limit = Date.now() - days * 86_400_000;
    const time = new Date(iso).getTime();
    return Number.isFinite(time) && time >= limit;
  }
  if (compare === 'atMost') return to ? day <= to : Boolean(from) && day <= (from as string);
  if (compare === 'between') {
    if (from && day < from) return false;
    if (to && day > to) return false;
    return Boolean(from || to);
  }
  return Boolean(from) && day >= (from as string);
}

/* ------------------------------------------------------------------ */
/* 条件 1 つの判定                                                      */
/* ------------------------------------------------------------------ */

async function matchCondition(
  condition: RuleCondition,
  target: ClassifyTarget,
  cache: TextCache,
): Promise<boolean> {
  const { file } = target;
  const text = condition.text ?? '';

  switch (condition.field) {
    case 'nameContains':
      return text !== '' && includes(file.name, text);
    case 'nameStartsWith':
      return text !== '' && startsWith(file.name, text);
    case 'nameEndsWith':
      return text !== '' && endsWith(baseName(file.name), text);
    case 'contentContains': {
      if (text === '' || !target.readText) return false;
      if (!cache.loaded) {
        cache.loaded = true;
        try {
          cache.text = await target.readText();
        } catch {
          // 本文を読めない PDF (壊れている・暗号化されているなど) は不一致として扱い、
          // 他の条件やルールの判定は止めない
          cache.text = '';
        }
      }
      return Boolean(cache.text) && includes(cache.text as string, text);
    }
    case 'origin':
      return text !== '' && originOf(file) === text;
    case 'sharedFrom':
      return text !== '' && Boolean(file.sharedFrom) && includes(file.sharedFrom as string, text);
    case 'fileType':
      return (
        text !== '' &&
        formatsOf(file).some(
          (format) => normalizeText(format) === normalizeText(text.replace(/^\./, '')),
        )
      );
    case 'size':
      // 条件は MB で持つ (入力しやすいため)。1MB = 1024 * 1024 バイト。
      return matchNumber(file.size / (1024 * 1024), condition);
    case 'pageCount':
      return file.pageCount !== undefined && matchNumber(file.pageCount, condition);
    case 'createdAt':
      return matchDate(file.createdAt, condition);
    case 'addedAt':
      // このアプリでは「アプリへ追加した日時」も createdAt に記録している。
      // 将来 PDF 自体の作成日を取り込んだときに、両者が分かれる。
      return matchDate(file.createdAt, condition);
    case 'tag':
      return text !== '' && file.tags.some((tag) => includes(tag, text));
    default:
      return false;
  }
}

/* ------------------------------------------------------------------ */
/* ルールの判定                                                        */
/* ------------------------------------------------------------------ */

/** ルールとして成立しているか (条件が 1 つ以上あり、移動先がある)。 */
export function isUsableRule(rule: ClassifyRule): boolean {
  return rule.conditions.length > 0 && Boolean(rule.destFolderId);
}

/** 1 つのルールが対象に一致するか。 */
export async function matchRule(
  rule: ClassifyRule,
  target: ClassifyTarget,
  cache: TextCache = newCache(),
): Promise<boolean> {
  if (!isUsableRule(rule)) return false;
  if (rule.match === 'any') {
    for (const condition of rule.conditions) {
      if (await matchCondition(condition, target, cache)) return true;
    }
    return false;
  }
  for (const condition of rule.conditions) {
    if (!(await matchCondition(condition, target, cache))) return false;
  }
  return true;
}

/**
 * 一致したルールを優先順位順に返す。
 *
 * @param strategy `first` のときは最初の一致で判定を打ち切る
 *                 (残りのルールを評価しないので、本文の読み取りも起きない)。
 */
export async function findMatchingRules(
  rules: ClassifyRule[],
  target: ClassifyTarget,
  strategy: MultiMatchStrategy = 'highest',
): Promise<ClassifyRule[]> {
  const cache = newCache();
  const matched: ClassifyRule[] = [];
  // listRules が優先順位順で返すので、ここでは並べ替え直さない
  for (const rule of rules) {
    if (!rule.enabled) continue;
    if (await matchRule(rule, target, cache)) {
      matched.push(rule);
      if (strategy === 'first') break;
    }
  }
  return matched;
}

/* ------------------------------------------------------------------ */
/* 表示用の文言                                                        */
/* ------------------------------------------------------------------ */

function numberSummary(condition: RuleCondition, unit: string): string {
  const { compare = 'atLeast', min, max } = condition;
  if (compare === 'atMost') return `${max ?? min ?? 0}${unit}以下`;
  if (compare === 'between') return `${min ?? 0}${unit}〜${max ?? 0}${unit}`;
  return `${min ?? 0}${unit}以上`;
}

function dateSummary(condition: RuleCondition): string {
  const { compare = 'atLeast', from, to, days } = condition;
  if (compare === 'withinDays') return `最近${days ?? 0}日以内`;
  if (compare === 'atMost') return `${to ?? from ?? ''} 以前`;
  if (compare === 'between') return `${from ?? ''} 〜 ${to ?? ''}`;
  return `${from ?? ''} 以降`;
}

/** 条件を 1 行の日本語にする (一覧・確認画面で使う)。 */
export function describeCondition(condition: RuleCondition): string {
  const label = RULE_FIELD_LABELS[condition.field];
  switch (condition.field) {
    case 'nameContains':
      return `ファイル名に「${condition.text ?? ''}」を含む`;
    case 'nameStartsWith':
      return `ファイル名が「${condition.text ?? ''}」から始まる`;
    case 'nameEndsWith':
      return `ファイル名が「${condition.text ?? ''}」で終わる`;
    case 'contentContains':
      return `PDF内に「${condition.text ?? ''}」を含む`;
    case 'origin':
      return `登録元が「${ORIGIN_LABELS[(condition.text ?? 'unknown') as PdfOrigin] ?? condition.text}」`;
    case 'sharedFrom':
      return `共有元に「${condition.text ?? ''}」を含む`;
    case 'fileType':
      return `ファイル形式が「${condition.text ?? ''}」`;
    case 'size':
      return `ファイル容量が ${numberSummary(condition, 'MB')}`;
    case 'pageCount':
      return `ページ数が ${numberSummary(condition, 'ページ')}`;
    case 'createdAt':
      return `作成日が ${dateSummary(condition)}`;
    case 'addedAt':
      return `追加日が ${dateSummary(condition)}`;
    case 'tag':
      return `タグに「${condition.text ?? ''}」を含む`;
    default:
      return label;
  }
}

/** ルール全体を 1 行の日本語にする。 */
export function describeRule(rule: ClassifyRule): string {
  if (rule.conditions.length === 0) return '条件が設定されていません';
  const joiner = rule.match === 'all' ? ' かつ ' : ' または ';
  return rule.conditions.map(describeCondition).join(joiner);
}

/** ルールが本文の読み取りを必要とするか (重い処理を避ける判断に使う)。 */
export function needsText(rule: ClassifyRule): boolean {
  return rule.conditions.some((condition) => condition.field === 'contentContains');
}
