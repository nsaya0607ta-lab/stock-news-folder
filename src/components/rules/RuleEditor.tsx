'use client';

/**
 * フォルダー単位の自動分類ルール作成・編集。
 *
 * ルールごとに「適用元フォルダー」を必須で持たせる。
 * そのフォルダー直下に追加・保存された PDF だけが判定対象となり、
 * 移動先は適用元フォルダー自身またはその配下に限定する。
 */
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { FolderInput, FolderTree, Plus, Trash2 } from 'lucide-react';
import { describeRule } from '@/lib/classify';
import {
  MAX_CONDITIONS,
  sourceFolderIdOf,
  type RuleInput,
} from '@/lib/classifyRules';
import { createId } from '@/lib/naming';
import { ROOT_NAME, descendantFolderIds, pathString } from '@/lib/tree';
import {
  ORIGIN_LABELS,
  ROOT_ID,
  RULE_FIELD_LABELS,
  RULE_MATCH_LABELS,
  UNSORTED_ID,
  type ClassifyRule,
  type Folder,
  type PdfOrigin,
  type RuleCompare,
  type RuleCondition,
  type RuleField,
  type RuleMatchMode,
} from '@/lib/types';
import { Button, Switch, cx } from '@/components/ui/Primitives';
import { BottomSheet } from '@/components/ui/Sheet';
import { FolderPicker } from '@/components/dialogs/FolderPicker';

export type RuleDraft = RuleInput;

export function emptyDraft(
  sourceFolderId = UNSORTED_ID,
  destFolderId = sourceFolderId,
): RuleDraft {
  return {
    name: '',
    match: 'any',
    conditions: [{ id: createId('cond'), field: 'nameContains', text: '' }],
    sourceFolderId,
    destFolderId,
    autoMove: true,
    confirmBeforeMove: false,
    enabled: true,
  };
}

export function toDraft(rule: ClassifyRule): RuleDraft {
  return {
    id: rule.id,
    name: rule.name,
    match: rule.match,
    conditions: rule.conditions.map((condition) => ({ ...condition })),
    sourceFolderId: sourceFolderIdOf(rule),
    destFolderId: rule.destFolderId,
    autoMove: rule.autoMove,
    confirmBeforeMove: rule.confirmBeforeMove,
    enabled: rule.enabled,
  };
}

const TEXT_FIELDS: RuleField[] = [
  'nameContains',
  'nameStartsWith',
  'nameEndsWith',
  'contentContains',
  'sharedFrom',
  'tag',
];
const NUMBER_FIELDS: RuleField[] = ['size', 'pageCount'];
const DATE_FIELDS: RuleField[] = ['createdAt', 'addedAt'];

const NUMBER_COMPARE_LABELS: Record<RuleCompare, string> = {
  atLeast: '以上',
  atMost: '以下',
  between: '範囲',
  withinDays: '最近',
};

const DATE_COMPARE_LABELS: Record<RuleCompare, string> = {
  atLeast: 'この日以降',
  atMost: 'この日以前',
  between: '期間',
  withinDays: '最近N日以内',
};

const FILE_TYPE_OPTIONS = ['pdf', 'jpeg', 'png', 'webp', 'heic', 'heif'];

const PLACEHOLDERS: Partial<Record<RuleField, string>> = {
  nameContains: '例：領収書',
  nameStartsWith: '例：2026',
  nameEndsWith: '例：請求',
  contentContains: '例：領収金額',
  sharedFrom: '例：メール',
  tag: '例：経費',
};

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="px-4 py-3">
      <p className="mb-1.5 text-sm text-ink-sub dark:text-[#98a3b0]">{label}</p>
      {children}
    </div>
  );
}

function ConditionRow({
  condition,
  index,
  canDelete,
  onChange,
  onDelete,
}: {
  condition: RuleCondition;
  index: number;
  canDelete: boolean;
  onChange: (next: RuleCondition) => void;
  onDelete: () => void;
}) {
  const patch = (next: Partial<RuleCondition>) => onChange({ ...condition, ...next });
  const isText = TEXT_FIELDS.includes(condition.field);
  const isNumber = NUMBER_FIELDS.includes(condition.field);
  const isDate = DATE_FIELDS.includes(condition.field);
  const compare: RuleCompare = condition.compare ?? 'atLeast';

  return (
    <div className="border-b divider px-4 py-3">
      <div className="flex items-center gap-2">
        <span className="text-xs text-ink-sub dark:text-[#98a3b0]">条件 {index + 1}</span>
        <span className="flex-1" />
        <button
          type="button"
          aria-label={`条件 ${index + 1} を削除`}
          disabled={!canDelete}
          onClick={onDelete}
          className="flex h-9 w-9 items-center justify-center rounded-card text-pdf disabled:opacity-30"
        >
          <Trash2 size={18} />
        </button>
      </div>

      <select
        className="field mt-1"
        aria-label="条件の種類"
        value={condition.field}
        onChange={(event) => {
          const field = event.target.value as RuleField;
          onChange({
            id: condition.id,
            field,
            text: TEXT_FIELDS.includes(field)
              ? (condition.text ?? '')
              : field === 'origin'
                ? 'file'
                : field === 'fileType'
                  ? 'pdf'
                  : undefined,
            compare:
              NUMBER_FIELDS.includes(field) || DATE_FIELDS.includes(field)
                ? 'atLeast'
                : undefined,
          });
        }}
      >
        {(Object.keys(RULE_FIELD_LABELS) as RuleField[]).map((field) => (
          <option key={field} value={field}>
            {RULE_FIELD_LABELS[field]}
          </option>
        ))}
      </select>

      {isText ? (
        <input
          className="field mt-2"
          aria-label="条件の値"
          placeholder={PLACEHOLDERS[condition.field] ?? '文字を入力'}
          value={condition.text ?? ''}
          onChange={(event) => patch({ text: event.target.value })}
        />
      ) : null}

      {condition.field === 'origin' ? (
        <select
          className="field mt-2"
          aria-label="登録元"
          value={condition.text ?? 'file'}
          onChange={(event) => patch({ text: event.target.value })}
        >
          {(Object.keys(ORIGIN_LABELS) as PdfOrigin[])
            .filter((origin) => origin !== 'unknown')
            .map((origin) => (
              <option key={origin} value={origin}>
                {ORIGIN_LABELS[origin]}
              </option>
            ))}
        </select>
      ) : null}

      {condition.field === 'fileType' ? (
        <select
          className="field mt-2"
          aria-label="ファイル形式"
          value={condition.text ?? 'pdf'}
          onChange={(event) => patch({ text: event.target.value })}
        >
          {FILE_TYPE_OPTIONS.map((type) => (
            <option key={type} value={type}>
              {type.toUpperCase()}
            </option>
          ))}
        </select>
      ) : null}

      {isNumber ? (
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <select
            className="field w-auto flex-none"
            aria-label="比較方法"
            value={compare === 'withinDays' ? 'atLeast' : compare}
            onChange={(event) => patch({ compare: event.target.value as RuleCompare })}
          >
            <option value="atLeast">{NUMBER_COMPARE_LABELS.atLeast}</option>
            <option value="atMost">{NUMBER_COMPARE_LABELS.atMost}</option>
            <option value="between">{NUMBER_COMPARE_LABELS.between}</option>
          </select>
          <input
            className="field w-24 flex-none"
            type="number"
            inputMode="numeric"
            min={0}
            aria-label={compare === 'atMost' ? '上限' : '下限'}
            value={compare === 'atMost' ? (condition.max ?? '') : (condition.min ?? '')}
            onChange={(event) => {
              const number = event.target.value === '' ? undefined : Number(event.target.value);
              patch(compare === 'atMost' ? { max: number } : { min: number });
            }}
          />
          {compare === 'between' ? (
            <>
              <span className="text-sm text-ink-sub">〜</span>
              <input
                className="field w-24 flex-none"
                type="number"
                inputMode="numeric"
                min={0}
                aria-label="上限"
                value={condition.max ?? ''}
                onChange={(event) =>
                  patch({
                    max: event.target.value === '' ? undefined : Number(event.target.value),
                  })
                }
              />
            </>
          ) : null}
          <span className="text-sm text-ink-sub dark:text-[#98a3b0]">
            {condition.field === 'size' ? 'MB' : 'ページ'}
          </span>
        </div>
      ) : null}

      {isDate ? (
        <div className="mt-2 space-y-2">
          <select
            className="field"
            aria-label="比較方法"
            value={compare}
            onChange={(event) => patch({ compare: event.target.value as RuleCompare })}
          >
            {(Object.keys(DATE_COMPARE_LABELS) as RuleCompare[]).map((key) => (
              <option key={key} value={key}>
                {DATE_COMPARE_LABELS[key]}
              </option>
            ))}
          </select>
          {compare === 'withinDays' ? (
            <div className="flex items-center gap-2">
              <input
                className="field w-24 flex-none"
                type="number"
                inputMode="numeric"
                min={1}
                aria-label="日数"
                value={condition.days ?? ''}
                onChange={(event) =>
                  patch({
                    days: event.target.value === '' ? undefined : Number(event.target.value),
                  })
                }
              />
              <span className="text-sm text-ink-sub dark:text-[#98a3b0]">日以内</span>
            </div>
          ) : (
            <div className="flex flex-wrap items-center gap-2">
              {compare !== 'atMost' ? (
                <input
                  className="field w-auto flex-1"
                  type="date"
                  aria-label="開始日"
                  value={condition.from ?? ''}
                  onChange={(event) => patch({ from: event.target.value || undefined })}
                />
              ) : null}
              {compare !== 'atLeast' ? (
                <input
                  className="field w-auto flex-1"
                  type="date"
                  aria-label="終了日"
                  value={condition.to ?? ''}
                  onChange={(event) => patch({ to: event.target.value || undefined })}
                />
              ) : null}
            </div>
          )}
        </div>
      ) : null}
    </div>
  );
}

export function RuleEditor({
  open,
  draft,
  folders,
  onClose,
  onSave,
}: {
  open: boolean;
  draft: RuleDraft | null;
  folders: Folder[];
  onClose: () => void;
  onSave: (draft: RuleDraft) => void;
}) {
  const [value, setValue] = useState<RuleDraft>(draft ?? emptyDraft());
  const [picker, setPicker] = useState<'source' | 'destination' | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    if (open && draft) {
      setValue(draft);
      setError('');
      setPicker(null);
    }
  }, [draft, open]);

  const activeFolders = useMemo(
    () => folders.filter((folder) => !folder.deletedAt),
    [folders],
  );

  const folderLabel = (folderId: string) =>
    folderId === ROOT_ID ? ROOT_NAME : pathString(activeFolders, folderId);

  const sourceLabel = useMemo(
    () => folderLabel(value.sourceFolderId),
    [activeFolders, value.sourceFolderId],
  );

  const destLabel = useMemo(
    () => folderLabel(value.destFolderId),
    [activeFolders, value.destFolderId],
  );

  const allowedDestinations = useMemo(
    () => descendantFolderIds(activeFolders, value.sourceFolderId),
    [activeFolders, value.sourceFolderId],
  );

  const destinationAllowed = allowedDestinations.has(value.destFolderId);

  const summary = useMemo(
    () =>
      describeRule({
        ...value,
        id: 'preview',
        userId: 'preview',
        priority: 1,
        createdAt: '',
        updatedAt: '',
      } as ClassifyRule),
    [value],
  );

  const submit = () => {
    if (!value.name.trim()) {
      setError('ルール名を入力してください。');
      return;
    }
    if (!value.sourceFolderId) {
      setError('ルールを適用するフォルダーを選択してください。');
      return;
    }
    if (!destinationAllowed) {
      setError('移動先は、適用元フォルダー自身またはそのサブフォルダーを選択してください。');
      return;
    }
    if (value.conditions.length === 0) {
      setError('条件を1つ以上追加してください。');
      return;
    }

    const empty = value.conditions.some((condition) => {
      if (TEXT_FIELDS.includes(condition.field)) return !condition.text?.trim();
      if (NUMBER_FIELDS.includes(condition.field)) {
        return condition.min === undefined && condition.max === undefined;
      }
      if (DATE_FIELDS.includes(condition.field)) {
        return condition.compare === 'withinDays'
          ? !condition.days
          : !condition.from && !condition.to;
      }
      return !condition.text;
    });

    if (empty) {
      setError('入力していない条件があります。値を入力するか、その条件を削除してください。');
      return;
    }

    onSave(value);
  };

  return (
    <>
      <BottomSheet
        open={open}
        title={value.id ? 'フォルダーのルールを編集' : 'フォルダーのルールを作成'}
        description="ルールは選択したフォルダー直下のPDFだけに適用されます"
        onClose={onClose}
        maxHeight="78vh"
        footer={
          <div className="flex gap-2">
            <Button variant="secondary" className="flex-1" onClick={onClose}>
              キャンセル
            </Button>
            <Button variant="primary" className="flex-1" onClick={submit}>
              保存
            </Button>
          </div>
        }
      >
        <Field label="ルールを適用するフォルダー">
          <button
            type="button"
            onClick={() => setPicker('source')}
            className="flex min-h-tap w-full items-center gap-2 rounded-card border border-line px-3 text-left dark:border-[#333d49]"
          >
            <FolderTree size={18} className="shrink-0 text-brand-500" />
            <span className="min-w-0 flex-1 truncate text-base text-ink dark:text-[#e6eaef]">
              {sourceLabel}
            </span>
          </button>
          <p className="mt-1.5 text-xs leading-relaxed text-ink-sub dark:text-[#98a3b0]">
            このフォルダー直下へ追加・保存されたPDFだけを判定します。別のフォルダーには適用しません。
          </p>
        </Field>

        <Field label="ルール名">
          <input
            className="field"
            placeholder="例：領収書を領収書フォルダーへ保存"
            value={value.name}
            onChange={(event) =>
              setValue((current) => ({ ...current, name: event.target.value }))
            }
          />
        </Field>

        <Field label="条件の組み合わせ">
          <div className="flex gap-2">
            {(Object.keys(RULE_MATCH_LABELS) as RuleMatchMode[]).map((mode) => (
              <button
                key={mode}
                type="button"
                onClick={() => setValue((current) => ({ ...current, match: mode }))}
                className={cx(
                  'min-h-tap flex-1 rounded-card border px-3 text-sm',
                  value.match === mode
                    ? 'border-brand-500 bg-brand-50 text-brand-600 dark:bg-[#16233a] dark:text-brand-200'
                    : 'border-line text-ink-sub dark:border-[#333d49] dark:text-[#98a3b0]',
                )}
              >
                {RULE_MATCH_LABELS[mode]}
              </button>
            ))}
          </div>
        </Field>

        <div className="border-t divider">
          {value.conditions.map((condition, index) => (
            <ConditionRow
              key={condition.id}
              condition={condition}
              index={index}
              canDelete={value.conditions.length > 1}
              onChange={(next) =>
                setValue((current) => ({
                  ...current,
                  conditions: current.conditions.map((entry) =>
                    entry.id === condition.id ? next : entry,
                  ),
                }))
              }
              onDelete={() =>
                setValue((current) => ({
                  ...current,
                  conditions: current.conditions.filter((entry) => entry.id !== condition.id),
                }))
              }
            />
          ))}
        </div>

        <div className="px-4 py-3">
          <Button
            variant="secondary"
            className="w-full"
            disabled={value.conditions.length >= MAX_CONDITIONS}
            onClick={() =>
              setValue((current) => ({
                ...current,
                conditions: [
                  ...current.conditions,
                  { id: createId('cond'), field: 'nameContains', text: '' },
                ],
              }))
            }
          >
            <Plus size={18} />
            条件を追加
          </Button>
        </div>

        <Field label="一致した場合の保存先">
          <button
            type="button"
            onClick={() => setPicker('destination')}
            className={cx(
              'flex min-h-tap w-full items-center gap-2 rounded-card border px-3 text-left',
              destinationAllowed
                ? 'border-line dark:border-[#333d49]'
                : 'border-pdf bg-red-50 dark:bg-[#351d23]',
            )}
          >
            <FolderInput size={18} className="shrink-0 text-ink-sub" />
            <span className="min-w-0 flex-1 truncate text-base text-ink dark:text-[#e6eaef]">
              {destLabel}
            </span>
          </button>
          <p className="mt-1.5 text-xs leading-relaxed text-ink-sub dark:text-[#98a3b0]">
            適用元フォルダー自身、またはその配下のサブフォルダーだけを選択できます。
          </p>
        </Field>

        <div className="border-t divider">
          <div className="flex min-h-tap items-center justify-between gap-3 border-b divider px-4 py-3">
            <div className="min-w-0 flex-1">
              <p className="text-base text-ink dark:text-[#e6eaef]">自動で移動する</p>
              <p className="mt-0.5 text-xs text-ink-sub dark:text-[#98a3b0]">
                OFFにすると、一致したことをお知らせするだけで移動しません
              </p>
            </div>
            <Switch
              checked={value.autoMove}
              onChange={(next) => setValue((current) => ({ ...current, autoMove: next }))}
              label="自動で移動する"
            />
          </div>
          <div className="flex min-h-tap items-center justify-between gap-3 border-b divider px-4 py-3">
            <div className="min-w-0 flex-1">
              <p className="text-base text-ink dark:text-[#e6eaef]">移動前に確認する</p>
              <p className="mt-0.5 text-xs text-ink-sub dark:text-[#98a3b0]">
                移動してよいかを毎回たずねます
              </p>
            </div>
            <Switch
              checked={value.confirmBeforeMove}
              onChange={(next) =>
                setValue((current) => ({ ...current, confirmBeforeMove: next }))
              }
              label="移動前に確認する"
            />
          </div>
          <div className="flex min-h-tap items-center justify-between gap-3 border-b divider px-4 py-3">
            <p className="min-w-0 flex-1 text-base text-ink dark:text-[#e6eaef]">
              このルールを使う
            </p>
            <Switch
              checked={value.enabled}
              onChange={(next) => setValue((current) => ({ ...current, enabled: next }))}
              label="このルールを使う"
            />
          </div>
        </div>

        <div className="px-4 py-3">
          <p className="text-xs leading-relaxed text-ink-sub dark:text-[#98a3b0]">
            対象：{sourceLabel}
            <br />
            判定内容：{summary}
            <br />
            保存先：{destLabel}
          </p>
          {error ? <p className="mt-2 text-sm text-pdf">{error}</p> : null}
        </div>
      </BottomSheet>

      <FolderPicker
        open={picker === 'source'}
        title="ルールを適用するフォルダー"
        description="選択したフォルダー直下のPDFだけが対象になります"
        confirmLabel="このフォルダーに設定"
        folders={activeFolders}
        initialFolderId={value.sourceFolderId}
        onClose={() => setPicker(null)}
        onConfirm={(folderId) => {
          const allowed = descendantFolderIds(activeFolders, folderId);
          setValue((current) => ({
            ...current,
            sourceFolderId: folderId,
            destFolderId: allowed.has(current.destFolderId)
              ? current.destFolderId
              : folderId,
          }));
          setError('');
          setPicker(null);
        }}
      />

      <FolderPicker
        open={picker === 'destination'}
        title="保存先のサブフォルダーを選択"
        description={`「${sourceLabel}」または、その配下のフォルダーを選択してください`}
        confirmLabel="ここへ保存する"
        folders={activeFolders}
        initialFolderId={value.destFolderId}
        onClose={() => setPicker(null)}
        onConfirm={(folderId) => {
          if (!allowedDestinations.has(folderId)) {
            setError('移動先は、適用元フォルダー自身またはそのサブフォルダーを選択してください。');
            setPicker(null);
            return;
          }
          setValue((current) => ({ ...current, destFolderId: folderId }));
          setError('');
          setPicker(null);
        }}
      />
    </>
  );
}
