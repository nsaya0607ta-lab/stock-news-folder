/**
 * 自動分類ルールの保存と編集。
 *
 * ルールはユーザーごと、かつ「適用元フォルダー」ごとに管理する。
 * PDF が追加されたフォルダーとルールの sourceFolderId が一致するときだけ判定する。
 *
 * 保存先は IndexedDB の設定ストアに相乗りしたキー付きレコード
 * (`classify-rules` → ClassifyRule[])。メモと同じ理由で専用ストアは作らない
 * (DB バージョンを上げると更新前の Service Worker が VersionError で止まるため)。
 */
import { mutateKeyed, readKeyed } from './db';
import { createId, nowIso } from './naming';
import { currentOwnerId, isOwnedBy } from './owner';
import {
  LOCAL_OWNER_ID,
  UNSORTED_ID,
  type ClassifyRule,
  type RuleCondition,
  type RuleField,
  type RuleMatchMode,
} from './types';

const RULES_KEY = 'classify-rules';

/** 1 人あたりのルール数の上限。 */
export const MAX_RULES = 100;
/** 1 ルールあたりの条件数の上限。 */
export const MAX_CONDITIONS = 20;

/**
 * 既存の ClassifyRule に、適用元フォルダーを加えた実データ型。
 *
 * types.ts の既存型との後方互換性を保つため、追加項目はこのモジュールで拡張する。
 * 旧ルールに sourceFolderId が無い場合は「未分類」フォルダーのルールとして移行する。
 */
export type FolderScopedRule = ClassifyRule & {
  /** このフォルダー直下にある PDF だけへ適用する。 */
  sourceFolderId: string;
};

/** 旧データを含め、ルールの適用元フォルダーを安全に取得する。 */
export function sourceFolderIdOf(rule: ClassifyRule): string {
  const value = (rule as Partial<FolderScopedRule>).sourceFolderId;
  return typeof value === 'string' && value ? value : UNSORTED_ID;
}

/* ------------------------------------------------------------------ */
/* 正規化                                                              */
/* ------------------------------------------------------------------ */

const FIELDS: RuleField[] = [
  'nameContains',
  'nameStartsWith',
  'nameEndsWith',
  'contentContains',
  'origin',
  'sharedFrom',
  'fileType',
  'size',
  'pageCount',
  'createdAt',
  'addedAt',
  'tag',
];

function toNumber(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined;
  return value;
}

function toText(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined;
}

function normalizeCondition(value: unknown): RuleCondition | null {
  if (!value || typeof value !== 'object') return null;
  const raw = value as Partial<RuleCondition>;
  if (typeof raw.field !== 'string' || !FIELDS.includes(raw.field as RuleField)) return null;
  return {
    id: typeof raw.id === 'string' && raw.id ? raw.id : createId('cond'),
    field: raw.field as RuleField,
    text: toText(raw.text),
    compare:
      raw.compare === 'atLeast' ||
      raw.compare === 'atMost' ||
      raw.compare === 'between' ||
      raw.compare === 'withinDays'
        ? raw.compare
        : undefined,
    min: toNumber(raw.min),
    max: toNumber(raw.max),
    from: toText(raw.from),
    to: toText(raw.to),
    days: toNumber(raw.days),
  };
}

/** 保存されている値が壊れていても落ちないように整える。 */
function normalizeRule(value: unknown): FolderScopedRule | null {
  if (!value || typeof value !== 'object') return null;
  const raw = value as Partial<FolderScopedRule>;
  if (typeof raw.id !== 'string' || typeof raw.name !== 'string') return null;

  const timestamp = typeof raw.createdAt === 'string' ? raw.createdAt : nowIso();
  const conditions = Array.isArray(raw.conditions)
    ? raw.conditions
        .map(normalizeCondition)
        .filter((entry): entry is RuleCondition => entry !== null)
        .slice(0, MAX_CONDITIONS)
    : [];

  return {
    id: raw.id,
    userId: typeof raw.userId === 'string' && raw.userId ? raw.userId : LOCAL_OWNER_ID,
    name: raw.name,
    match: raw.match === 'any' ? 'any' : 'all',
    conditions,
    sourceFolderId:
      typeof raw.sourceFolderId === 'string' && raw.sourceFolderId
        ? raw.sourceFolderId
        : UNSORTED_ID,
    destFolderId:
      typeof raw.destFolderId === 'string' && raw.destFolderId ? raw.destFolderId : UNSORTED_ID,
    autoMove: raw.autoMove !== false,
    confirmBeforeMove: Boolean(raw.confirmBeforeMove),
    enabled: raw.enabled !== false,
    priority: toNumber(raw.priority) ?? 999,
    createdAt: timestamp,
    updatedAt: typeof raw.updatedAt === 'string' ? raw.updatedAt : timestamp,
  };
}

/**
 * 適用元フォルダー → 優先順位 → 作成日時の順に並べる。
 * 優先順位はフォルダーごとに独立する。
 */
export function sortRules(rules: ClassifyRule[]): FolderScopedRule[] {
  return rules
    .map((rule) => ({ ...rule, sourceFolderId: sourceFolderIdOf(rule) }) as FolderScopedRule)
    .sort(
      (a, b) =>
        a.sourceFolderId.localeCompare(b.sourceFolderId) ||
        a.priority - b.priority ||
        a.createdAt.localeCompare(b.createdAt),
    );
}

/** 各フォルダー内の並び順に合わせて priority を 1 から振り直す。 */
function renumber(rules: FolderScopedRule[]): FolderScopedRule[] {
  const groups = new Map<string, FolderScopedRule[]>();

  for (const rule of rules) {
    const sourceFolderId = sourceFolderIdOf(rule);
    const group = groups.get(sourceFolderId) ?? [];
    group.push({ ...rule, sourceFolderId });
    groups.set(sourceFolderId, group);
  }

  const result: FolderScopedRule[] = [];
  for (const sourceFolderId of [...groups.keys()].sort((a, b) => a.localeCompare(b))) {
    const group = groups
      .get(sourceFolderId)!
      .sort((a, b) => a.priority - b.priority || a.createdAt.localeCompare(b.createdAt));
    result.push(
      ...group.map((rule, index) => ({
        ...rule,
        sourceFolderId,
        priority: index + 1,
      })),
    );
  }
  return result;
}

/* ------------------------------------------------------------------ */
/* 読み書き                                                            */
/* ------------------------------------------------------------------ */

/** 現在の持ち主のルール。フォルダー別・優先順位順で返す。 */
export async function listRules(): Promise<FolderScopedRule[]> {
  const stored = await readKeyed<unknown[]>(RULES_KEY);
  if (!Array.isArray(stored)) return [];
  const mine = stored
    .map(normalizeRule)
    .filter((rule): rule is FolderScopedRule => rule !== null && isOwnedBy(rule.userId));
  return sortRules(mine);
}

/**
 * 自分のルールを読み → 変更 → 書き戻す。
 * 他の持ち主のルールは触らずにそのまま残す。
 */
async function mutateRules(
  change: (mine: FolderScopedRule[]) => FolderScopedRule[],
): Promise<FolderScopedRule[]> {
  let result: FolderScopedRule[] = [];
  await mutateKeyed<unknown[]>(RULES_KEY, (current) => {
    const all = Array.isArray(current)
      ? current.map(normalizeRule).filter((rule): rule is FolderScopedRule => rule !== null)
      : [];
    const others = all.filter((rule) => !isOwnedBy(rule.userId));
    result = renumber(change(sortRules(all.filter((rule) => isOwnedBy(rule.userId)))));
    const next = [...others, ...result];
    return next.length > 0 ? next : undefined;
  });
  return sortRules(result);
}

export type RuleInput = {
  id?: string;
  name: string;
  match: RuleMatchMode;
  conditions: RuleCondition[];
  /** ルールを適用するフォルダー。直下の PDF だけが対象。 */
  sourceFolderId: string;
  /** 一致した PDF の移動先。 */
  destFolderId: string;
  autoMove: boolean;
  confirmBeforeMove: boolean;
  enabled: boolean;
};

/** ルールを保存する（新規作成 / 上書きの両対応）。 */
export async function saveRule(input: RuleInput): Promise<FolderScopedRule> {
  const timestamp = nowIso();
  let saved: FolderScopedRule | null = null;

  await mutateRules((mine) => {
    const existing = input.id ? mine.find((rule) => rule.id === input.id) : undefined;
    if (!existing && mine.length >= MAX_RULES) return mine;

    const sourceFolderId = input.sourceFolderId || UNSORTED_ID;
    const scopedCount = mine.filter(
      (rule) => sourceFolderIdOf(rule) === sourceFolderId && rule.id !== existing?.id,
    ).length;

    const rule: FolderScopedRule = {
      id: existing?.id ?? input.id ?? createId('rule'),
      userId: existing?.userId ?? currentOwnerId(),
      name: input.name.trim() || '名称未設定のルール',
      match: input.match,
      conditions: input.conditions.slice(0, MAX_CONDITIONS),
      sourceFolderId,
      destFolderId: input.destFolderId,
      autoMove: input.autoMove,
      confirmBeforeMove: input.confirmBeforeMove,
      enabled: input.enabled,
      // 適用元フォルダーを変更した場合は、そのフォルダーの末尾へ移す。
      priority:
        existing && sourceFolderIdOf(existing) === sourceFolderId
          ? existing.priority
          : scopedCount + 1,
      createdAt: existing?.createdAt ?? timestamp,
      updatedAt: timestamp,
    };

    saved = rule;
    return existing
      ? mine.map((entry) => (entry.id === rule.id ? rule : entry))
      : [...mine, rule];
  });

  if (!saved) throw new Error(`ルールは ${MAX_RULES} 件までしか作成できません。`);
  return saved;
}

export async function deleteRule(ruleId: string): Promise<FolderScopedRule[]> {
  return mutateRules((mine) => mine.filter((rule) => rule.id !== ruleId));
}

/** ルールを複製し、同じフォルダー内で元のすぐ後ろへ入れる。 */
export async function duplicateRule(ruleId: string): Promise<FolderScopedRule[]> {
  return mutateRules((mine) => {
    const source = mine.find((rule) => rule.id === ruleId);
    if (!source || mine.length >= MAX_RULES) return mine;
    const timestamp = nowIso();
    const copy: FolderScopedRule = {
      ...source,
      id: createId('rule'),
      userId: currentOwnerId(),
      name: `${source.name} のコピー`,
      conditions: source.conditions.map((condition) => ({ ...condition, id: createId('cond') })),
      priority: source.priority + 0.5,
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    return [...mine, copy];
  });
}

export async function setRuleEnabled(
  ruleId: string,
  enabled: boolean,
): Promise<FolderScopedRule[]> {
  return mutateRules((mine) =>
    mine.map((rule) =>
      rule.id === ruleId ? { ...rule, enabled, updatedAt: nowIso() } : rule,
    ),
  );
}

/** 同じ適用元フォルダー内で、優先順位を 1 つ上げる / 下げる。 */
export async function moveRulePriority(
  ruleId: string,
  direction: 'up' | 'down',
): Promise<FolderScopedRule[]> {
  return mutateRules((mine) => {
    const sourceRule = mine.find((rule) => rule.id === ruleId);
    if (!sourceRule) return mine;

    const sourceFolderId = sourceFolderIdOf(sourceRule);
    const scoped = mine
      .filter((rule) => sourceFolderIdOf(rule) === sourceFolderId)
      .sort((a, b) => a.priority - b.priority || a.createdAt.localeCompare(b.createdAt));

    const index = scoped.findIndex((rule) => rule.id === ruleId);
    const target = direction === 'up' ? index - 1 : index + 1;
    if (index < 0 || target < 0 || target >= scoped.length) return mine;

    [scoped[index], scoped[target]] = [scoped[target], scoped[index]];
    const priorities = new Map(scoped.map((rule, position) => [rule.id, position + 1]));

    return mine.map((rule) =>
      sourceFolderIdOf(rule) === sourceFolderId
        ? { ...rule, priority: priorities.get(rule.id) ?? rule.priority, updatedAt: nowIso() }
        : rule,
    );
  });
}

/**
 * ログイン直後に、ログイン前のルールを本人のものとして引き継ぐ。
 */
export async function claimLocalRules(uid: string): Promise<void> {
  if (!uid || uid === LOCAL_OWNER_ID) return;
  await mutateKeyed<unknown[]>(RULES_KEY, (current) => {
    if (!Array.isArray(current)) return current;
    return current.map((entry) => {
      const rule = normalizeRule(entry);
      if (!rule || rule.userId !== LOCAL_OWNER_ID) return entry;
      return { ...rule, userId: uid };
    });
  });
}
