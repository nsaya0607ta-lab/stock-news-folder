'use client';

/**
 * 自動分類の「移動前の確認」と「移動後のお知らせ」。
 *
 * 移動前 … どのルールを適用するかを選び、今回だけ適用しないこともできる
 * 移動後 … どのルールでどこへ移動したかを表示し、元に戻す / 別フォルダーへ移動 / ルールを編集 ができる
 */
import { describeRule } from '@/lib/classify';
import type { ClassifyPlan, ClassifyRecord } from '@/lib/classifyRun';
import { middleEllipsis } from '@/lib/format';
import { ROOT_NAME, pathString } from '@/lib/tree';
import { ROOT_ID, type ClassifyRule, type Folder } from '@/lib/types';
import { Button, cx } from '@/components/ui/Primitives';
import { BottomSheet } from '@/components/ui/Sheet';

function folderLabel(folders: Folder[], folderId: string): string {
  return folderId === ROOT_ID ? ROOT_NAME : pathString(folders, folderId);
}

/** お知らせ文に使う短い名前 (階層は付けない)。 */
function folderName(folders: Folder[], folderId: string): string {
  if (folderId === ROOT_ID) return ROOT_NAME;
  return folders.find((folder) => folder.id === folderId)?.name ?? ROOT_NAME;
}

/** 移動前の確認。1 件ずつ順番に確認する。 */
export function ClassifyConfirmSheet({
  plan,
  remaining,
  folders,
  selectedRuleId,
  onSelectRule,
  onApply,
  onSkip,
  onEditRule,
}: {
  plan: ClassifyPlan | null;
  /** このあと確認するPDFの残り件数。 */
  remaining: number;
  folders: Folder[];
  selectedRuleId: string | null;
  onSelectRule: (ruleId: string) => void;
  onApply: () => void;
  onSkip: () => void;
  onEditRule: (rule: ClassifyRule) => void;
}) {
  const active = plan?.matches.find((rule) => rule.id === selectedRuleId) ?? plan?.rule ?? null;

  return (
    <BottomSheet
      open={plan !== null}
      title="このPDFを移動しますか？"
      description={remaining > 0 ? `ほかに ${remaining} 件の確認があります` : undefined}
      onClose={onSkip}
      footer={
        <div className="flex gap-2">
          <Button variant="secondary" className="flex-1" onClick={onSkip}>
            今回は移動しない
          </Button>
          <Button variant="primary" className="flex-1" onClick={onApply}>
            移動する
          </Button>
        </div>
      }
    >
      {plan ? (
        <div className="px-4 py-3">
          <p className="break-words text-base font-medium text-ink dark:text-[#e6eaef]">
            {middleEllipsis(plan.file.name, 44)}
          </p>
          <p className="mt-1 break-words text-sm text-ink-sub dark:text-[#98a3b0]">
            {folderLabel(folders, plan.fromParentId)} →{' '}
            {active ? folderLabel(folders, active.destFolderId) : ''}
          </p>
        </div>
      ) : null}

      {plan && plan.matches.length > 1 ? (
        <div className="border-t divider px-4 py-3">
          <p className="mb-2 text-sm text-ink-sub dark:text-[#98a3b0]">
            {plan.matches.length} 件のルールに一致しました。適用するルールを選んでください。
          </p>
          <div className="space-y-2">
            {plan.matches.map((rule) => (
              <button
                key={rule.id}
                type="button"
                onClick={() => onSelectRule(rule.id)}
                className={cx(
                  'block w-full rounded-card border px-3 py-2.5 text-left',
                  active?.id === rule.id
                    ? 'border-brand-500 bg-brand-50 dark:bg-[#16233a]'
                    : 'border-line dark:border-[#333d49]',
                )}
              >
                <span className="block break-words text-base text-ink dark:text-[#e6eaef]">
                  {rule.name}
                </span>
                <span className="mt-0.5 block break-words text-xs text-ink-sub dark:text-[#98a3b0]">
                  {folderLabel(folders, rule.destFolderId)}へ移動
                </span>
              </button>
            ))}
          </div>
        </div>
      ) : plan ? (
        <div className="border-t divider px-4 py-3">
          <p className="break-words text-sm text-ink dark:text-[#e6eaef]">{plan.rule.name}</p>
          <p className="mt-0.5 break-words text-xs text-ink-sub dark:text-[#98a3b0]">
            {describeRule(plan.rule)}
          </p>
        </div>
      ) : null}

      {active ? (
        <div className="px-4 pb-3">
          <Button variant="ghost" className="px-0" onClick={() => onEditRule(active)}>
            このルールを編集
          </Button>
        </div>
      ) : null}
    </BottomSheet>
  );
}

/** 移動後のお知らせ。 */
export function ClassifyResultSheet({
  records,
  folders,
  rules,
  onClose,
  onUndo,
  onMove,
  onEditRule,
}: {
  records: ClassifyRecord[];
  folders: Folder[];
  rules: ClassifyRule[];
  onClose: () => void;
  onUndo: (record: ClassifyRecord) => void;
  onMove: (record: ClassifyRecord) => void;
  onEditRule: (rule: ClassifyRule) => void;
}) {
  return (
    <BottomSheet
      open={records.length > 0}
      title="自動分類しました"
      description={records.length > 1 ? `${records.length} 件のPDFを移動しました` : undefined}
      onClose={onClose}
      footer={
        <Button variant="secondary" className="w-full" onClick={onClose}>
          閉じる
        </Button>
      }
    >
      {records.map((record) => {
        const rule = rules.find((entry) => entry.id === record.ruleId);
        return (
          <div key={record.fileId} className="border-b divider px-4 py-3">
            <p className="break-words text-base text-ink dark:text-[#e6eaef]">
              {record.ruleName}ルールにより、{folderName(folders, record.toParentId)}フォルダーへ移動しました
            </p>
            <p className="mt-0.5 break-words text-xs text-ink-sub dark:text-[#98a3b0]">
              {middleEllipsis(record.fileName, 40)}
            </p>
            <p className="mt-0.5 break-words text-xs text-ink-sub dark:text-[#98a3b0]">
              {folderLabel(folders, record.toParentId)}
            </p>
            <div className="mt-2 flex flex-wrap gap-2">
              <Button
                variant="secondary"
                className="h-9 min-h-0 px-3 text-sm"
                onClick={() => onUndo(record)}
              >
                元に戻す
              </Button>
              <Button
                variant="secondary"
                className="h-9 min-h-0 px-3 text-sm"
                onClick={() => onMove(record)}
              >
                別フォルダーへ移動
              </Button>
              {rule ? (
                <Button
                  variant="secondary"
                  className="h-9 min-h-0 px-3 text-sm"
                  onClick={() => onEditRule(rule)}
                >
                  ルールを編集
                </Button>
              ) : null}
            </div>
          </div>
        );
      })}
    </BottomSheet>
  );
}
