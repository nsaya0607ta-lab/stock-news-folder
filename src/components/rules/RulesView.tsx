'use client';

/**
 * フォルダー単位の自動分類ルール管理画面。
 *
 * 画面上部で「ルールを管理するフォルダー」を選び、そのフォルダー専用の
 * ルールだけを追加・編集・並べ替え・テスト・一括適用する。
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ArrowDown,
  ArrowLeft,
  ArrowUp,
  Copy,
  FlaskConical,
  FolderTree,
  MoreVertical,
  Pencil,
  Play,
  Plus,
  Trash2,
} from 'lucide-react';
import { describeRule } from '@/lib/classify';
import {
  applyPlans,
  planFiles,
  type ClassifyPlan,
  type PlanFailure,
} from '@/lib/classifyRun';
import {
  deleteRule,
  duplicateRule,
  moveRulePriority,
  saveRule,
  setRuleEnabled,
  sourceFolderIdOf,
} from '@/lib/classifyRules';
import { toMessage } from '@/lib/errors';
import { middleEllipsis } from '@/lib/format';
import {
  ROOT_NAME,
  activeFiles,
  pathString,
  toParentKey,
} from '@/lib/tree';
import {
  MULTI_MATCH_LABELS,
  ROOT_ID,
  UNSORTED_ID,
  type ClassifyRule,
  type MultiMatchStrategy,
} from '@/lib/types';
import { useApp } from '@/store/AppStore';
import {
  Button,
  IconButton,
  SectionTitle,
  Spinner,
  Switch,
  cx,
} from '@/components/ui/Primitives';
import { BottomSheet, MenuRow } from '@/components/ui/Sheet';
import { ConfirmDialog } from '@/components/dialogs/CommonDialogs';
import { Header } from '@/components/views/Header';
import { RuleEditor, emptyDraft, toDraft, type RuleDraft } from './RuleEditor';

type RunState = {
  /** test: 移動しない / apply: 実際に移動する */
  mode: 'test' | 'apply';
  /** 対象を 1 つのルールに絞る場合。 */
  rule?: ClassifyRule;
  plans: ClassifyPlan[];
  failures: PlanFailure[];
  targetCount: number;
  sourceFolderId: string;
};

export function RulesView() {
  const {
    files,
    folders,
    rules,
    settings,
    goBack,
    canGoBack,
    notify,
    reload,
    reloadRules,
    updateSettings,
  } = useApp();

  const [sourceFolderId, setSourceFolderId] = useState(UNSORTED_ID);
  const [editor, setEditor] = useState<RuleDraft | null>(null);
  const [menuRule, setMenuRule] = useState<ClassifyRule | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<ClassifyRule | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [runState, setRunState] = useState<RunState | null>(null);
  const [strategySheet, setStrategySheet] = useState(false);

  const activeFolderList = useMemo(
    () => folders.filter((folder) => !folder.deletedAt),
    [folders],
  );

  const folderLabel = useCallback(
    (folderId: string) =>
      folderId === ROOT_ID ? ROOT_NAME : pathString(activeFolderList, folderId),
    [activeFolderList],
  );

  const sourceOptions = useMemo(
    () => [
      { id: ROOT_ID, label: ROOT_NAME },
      ...activeFolderList
        .map((folder) => ({ id: folder.id, label: pathString(activeFolderList, folder.id) }))
        .sort((a, b) => a.label.localeCompare(b.label, 'ja')),
    ],
    [activeFolderList],
  );

  useEffect(() => {
    const exists =
      sourceFolderId === ROOT_ID ||
      activeFolderList.some((folder) => folder.id === sourceFolderId);
    if (exists) return;

    const fallback = activeFolderList.some((folder) => folder.id === UNSORTED_ID)
      ? UNSORTED_ID
      : ROOT_ID;
    setSourceFolderId(fallback);
  }, [activeFolderList, sourceFolderId]);

  const folderRules = useMemo(
    () =>
      rules
        .filter((rule) => sourceFolderIdOf(rule) === sourceFolderId)
        .sort(
          (a, b) =>
            a.priority - b.priority || a.createdAt.localeCompare(b.createdAt),
        ),
    [rules, sourceFolderId],
  );

  const folderTargets = useMemo(
    () =>
      activeFiles(files).filter(
        (file) => toParentKey(file.parentId) === sourceFolderId,
      ),
    [files, sourceFolderId],
  );

  /** 判定だけを行い、結果シートを開く。 */
  const startRun = useCallback(
    async (mode: 'test' | 'apply', rule?: ClassifyRule) => {
      const scope = rule ? sourceFolderIdOf(rule) : sourceFolderId;
      const usable = rule
        ? [rule]
        : rules
            .filter((entry) => sourceFolderIdOf(entry) === scope)
            .sort(
              (a, b) =>
                a.priority - b.priority || a.createdAt.localeCompare(b.createdAt),
            );

      if (usable.length === 0) {
        notify('このフォルダーにはルールがありません。', 'info');
        return;
      }

      const targets = activeFiles(files).filter(
        (file) => toParentKey(file.parentId) === scope,
      );

      setBusy(mode === 'test' ? 'テスト実行しています…' : '対象のPDFを確認しています…');
      try {
        const result = await planFiles(targets, {
          // 個別テストでは、無効なルールも「有効ならどうなるか」を確認する
          rules: usable.map((entry) =>
            rule ? { ...entry, enabled: true } : entry,
          ),
          strategy: settings.classifyMultiMatch,
          textPages: settings.classifyTextPages,
        });

        setRunState({
          mode,
          rule,
          plans: result.plans,
          failures: result.failures,
          targetCount: targets.length,
          sourceFolderId: scope,
        });
      } catch (error) {
        notify(toMessage(error), 'error');
      } finally {
        setBusy(null);
      }
    },
    [
      files,
      notify,
      rules,
      settings.classifyMultiMatch,
      settings.classifyTextPages,
      sourceFolderId,
    ],
  );

  /** 確認後に一括で移動する。 */
  const executeRun = useCallback(async () => {
    if (!runState) return;
    const plans = runState.plans;
    const scope = runState.sourceFolderId;
    setRunState(null);
    setBusy(`PDFを移動しています…（0 / ${plans.length}）`);

    try {
      const result = await applyPlans(plans, (done, total) =>
        setBusy(`PDFを移動しています…（${done} / ${total}）`),
      );
      await reload();

      if (result.failures.length > 0) {
        setRunState({
          mode: 'apply',
          plans: [],
          failures: result.failures,
          targetCount: plans.length,
          sourceFolderId: scope,
        });
      }

      notify(
        `${result.moved.length} 件のPDFを移動しました${
          result.failures.length > 0
            ? `（${result.failures.length} 件は移動できませんでした）`
            : ''
        }`,
        result.failures.length > 0 ? 'info' : 'success',
      );
    } catch (error) {
      notify(toMessage(error), 'error');
    } finally {
      setBusy(null);
    }
  }, [notify, reload, runState]);

  const saveDraft = useCallback(
    async (draft: RuleDraft) => {
      try {
        await saveRule(draft);
        await reloadRules();
        setSourceFolderId(draft.sourceFolderId);
        setEditor(null);
        notify('フォルダーのルールを保存しました。', 'success');
      } catch (error) {
        notify(toMessage(error), 'error');
      }
    },
    [notify, reloadRules],
  );

  return (
    <>
      <Header
        title="フォルダー別の自動分類"
        subtitle={`${folderLabel(sourceFolderId)}・${folderRules.length} 件`}
        left={
          canGoBack ? (
            <IconButton label="戻る" onClick={goBack}>
              <ArrowLeft size={22} />
            </IconButton>
          ) : undefined
        }
        right={
          <IconButton
            label="このフォルダーにルールを追加"
            onClick={() => setEditor(emptyDraft(sourceFolderId))}
          >
            <Plus size={22} />
          </IconButton>
        }
      />

      <div className="bg-surface dark:bg-[#181e26]">
        <div className="border-b divider px-4 py-3">
          <label
            htmlFor="classify-source-folder"
            className="mb-1.5 flex items-center gap-2 text-sm text-ink-sub dark:text-[#98a3b0]"
          >
            <FolderTree size={17} />
            ルールを管理するフォルダー
          </label>
          <select
            id="classify-source-folder"
            className="field"
            value={sourceFolderId}
            onChange={(event) => setSourceFolderId(event.target.value)}
          >
            {sourceOptions.map((option) => (
              <option key={option.id} value={option.id}>
                {option.label}
              </option>
            ))}
          </select>
          <p className="mt-1.5 text-xs leading-relaxed text-ink-sub dark:text-[#98a3b0]">
            選択したフォルダー直下に追加されたPDFだけへ、このフォルダーのルールを適用します。
            他のフォルダーのルールとは完全に分けて管理します。
          </p>
        </div>

        <div className="flex min-h-tap items-center justify-between gap-3 border-b divider px-4 py-3">
          <div className="min-w-0 flex-1">
            <p className="text-base text-ink dark:text-[#e6eaef]">PDF追加時に自動分類する</p>
            <p className="mt-0.5 text-xs text-ink-sub dark:text-[#98a3b0]">
              OFFにすると、すべてのフォルダーで自動判定を停止します
            </p>
          </div>
          <Switch
            checked={settings.classifyEnabled}
            onChange={(value) => void updateSettings({ classifyEnabled: value })}
            label="PDF追加時に自動分類する"
          />
        </div>

        <button
          type="button"
          className="flex min-h-tap w-full items-center justify-between gap-3 border-b divider px-4 py-3 text-left"
          onClick={() => setStrategySheet(true)}
        >
          <div className="min-w-0 flex-1">
            <p className="text-base text-ink dark:text-[#e6eaef]">複数のルールに一致したとき</p>
            <p className="mt-0.5 text-xs text-ink-sub dark:text-[#98a3b0]">
              {MULTI_MATCH_LABELS[settings.classifyMultiMatch]}
            </p>
          </div>
        </button>
      </div>

      <SectionTitle>
        {folderLabel(sourceFolderId)} のルール（上にあるものが優先）
      </SectionTitle>

      {folderRules.length === 0 ? (
        <div className="px-6 py-10 text-center">
          <p className="text-base text-ink dark:text-[#e6eaef]">
            このフォルダーにはルールがありません
          </p>
          <p className="mt-2 text-sm leading-relaxed text-ink-sub dark:text-[#98a3b0]">
            例：このフォルダーに追加された「領収書」という名前のPDFを、
            このフォルダー内の「領収書」サブフォルダーへ保存できます。
          </p>
          <Button
            variant="primary"
            className="mt-4"
            onClick={() => setEditor(emptyDraft(sourceFolderId))}
          >
            <Plus size={18} />
            このフォルダーにルールを作成
          </Button>
        </div>
      ) : (
        <div className="bg-surface dark:bg-[#181e26]">
          {folderRules.map((rule, index) => (
            <div key={rule.id} className="border-b divider px-4 py-3">
              <div className="flex items-start gap-2">
                <span className="mt-1 shrink-0 rounded-[4px] bg-surface-sub px-1.5 py-0.5 text-xs text-ink-sub dark:bg-[#232b35] dark:text-[#aab4c0]">
                  {index + 1}
                </span>
                <div className="min-w-0 flex-1">
                  <p
                    className={cx(
                      'break-words text-base font-medium',
                      rule.enabled
                        ? 'text-ink dark:text-[#e6eaef]'
                        : 'text-ink-faint',
                    )}
                  >
                    {rule.name}
                  </p>
                  <p className="mt-0.5 break-words text-xs leading-relaxed text-ink-sub dark:text-[#98a3b0]">
                    {describeRule(rule)}
                  </p>
                  <p className="mt-0.5 break-words text-xs text-ink-sub dark:text-[#98a3b0]">
                    保存先：{folderLabel(rule.destFolderId)}
                    {rule.autoMove ? '' : '（自動移動しない）'}
                    {rule.confirmBeforeMove ? '（移動前に確認）' : ''}
                  </p>
                </div>
                <Switch
                  checked={rule.enabled}
                  onChange={(value) =>
                    void setRuleEnabled(rule.id, value)
                      .then(() => reloadRules())
                      .catch((error) => notify(toMessage(error), 'error'))
                  }
                  label={`${rule.name} を使う`}
                />
              </div>

              <div className="mt-2 flex items-center gap-1">
                <IconButton
                  label="優先順位を上げる"
                  className="h-9 w-9"
                  disabled={index === 0}
                  onClick={() =>
                    void moveRulePriority(rule.id, 'up')
                      .then(() => reloadRules())
                      .catch((error) => notify(toMessage(error), 'error'))
                  }
                >
                  <ArrowUp size={18} />
                </IconButton>
                <IconButton
                  label="優先順位を下げる"
                  className="h-9 w-9"
                  disabled={index === folderRules.length - 1}
                  onClick={() =>
                    void moveRulePriority(rule.id, 'down')
                      .then(() => reloadRules())
                      .catch((error) => notify(toMessage(error), 'error'))
                  }
                >
                  <ArrowDown size={18} />
                </IconButton>
                <span className="flex-1" />
                <Button
                  variant="ghost"
                  className="h-9 min-h-0 px-2 text-sm"
                  onClick={() => void startRun('test', rule)}
                >
                  <FlaskConical size={16} />
                  テスト
                </Button>
                <IconButton
                  label="このルールの操作"
                  className="h-9 w-9"
                  onClick={() => setMenuRule(rule)}
                >
                  <MoreVertical size={18} />
                </IconButton>
              </div>
            </div>
          ))}
        </div>
      )}

      <div className="space-y-2 px-4 py-4">
        <Button
          variant="secondary"
          className="w-full"
          disabled={folderRules.length === 0}
          onClick={() => void startRun('test')}
        >
          <FlaskConical size={18} />
          このフォルダーのルールでテスト
        </Button>
        <Button
          variant="primary"
          className="w-full"
          disabled={folderRules.length === 0}
          onClick={() => void startRun('apply')}
        >
          <Play size={18} />
          このフォルダー内の既存PDFへ適用
        </Button>
        <p className="text-xs leading-relaxed text-ink-sub dark:text-[#98a3b0]">
          対象は「{folderLabel(sourceFolderId)}」直下のPDF {folderTargets.length} 件です。
          サブフォルダー内や別フォルダーのPDFには適用しません。
        </p>
      </div>

      {/* ルールごとの操作 */}
      <BottomSheet
        open={menuRule !== null}
        title={menuRule?.name}
        onClose={() => setMenuRule(null)}
      >
        <MenuRow
          icon={<Pencil size={22} />}
          label="編集"
          onClick={() => {
            const target = menuRule;
            setMenuRule(null);
            if (target) setEditor(toDraft(target));
          }}
        />
        <MenuRow
          icon={<Copy size={22} />}
          label="複製"
          onClick={() => {
            const target = menuRule;
            setMenuRule(null);
            if (!target) return;
            void duplicateRule(target.id)
              .then(() => reloadRules())
              .then(() => notify('ルールを複製しました。', 'success'))
              .catch((error) => notify(toMessage(error), 'error'));
          }}
        />
        <MenuRow
          icon={<FlaskConical size={22} />}
          label="テスト実行"
          description="このフォルダー内で、移動せずに分類先だけ確認します"
          onClick={() => {
            const target = menuRule;
            setMenuRule(null);
            if (target) void startRun('test', target);
          }}
        />
        <MenuRow
          icon={<Play size={22} />}
          label="このルールを既存のPDFへ適用"
          onClick={() => {
            const target = menuRule;
            setMenuRule(null);
            if (target) void startRun('apply', target);
          }}
        />
        <MenuRow
          icon={<Trash2 size={22} />}
          label="削除"
          tone="danger"
          onClick={() => {
            const target = menuRule;
            setMenuRule(null);
            setDeleteTarget(target);
          }}
        />
      </BottomSheet>

      {/* 複数一致したときの扱い */}
      <BottomSheet
        open={strategySheet}
        title="複数のルールに一致したとき"
        onClose={() => setStrategySheet(false)}
      >
        {(Object.keys(MULTI_MATCH_LABELS) as MultiMatchStrategy[]).map((key) => (
          <MenuRow
            key={key}
            icon={
              <span
                className={cx(
                  'h-2.5 w-2.5 rounded-full',
                  settings.classifyMultiMatch === key ? 'bg-brand-500' : 'bg-line',
                )}
              />
            }
            label={MULTI_MATCH_LABELS[key]}
            onClick={() => {
              void updateSettings({ classifyMultiMatch: key });
              setStrategySheet(false);
            }}
          />
        ))}
      </BottomSheet>

      {/* テスト実行 / 一括適用の確認 */}
      <BottomSheet
        open={runState !== null}
        title={runState?.mode === 'test' ? 'テスト実行の結果' : '一括適用の確認'}
        description={
          runState
            ? `「${folderLabel(runState.sourceFolderId)}」直下のPDF ${runState.targetCount} 件のうち、${runState.plans.length} 件が移動対象です`
            : undefined
        }
        onClose={() => setRunState(null)}
        footer={
          runState?.mode === 'apply' && runState.plans.length > 0 ? (
            <div className="flex gap-2">
              <Button variant="secondary" className="flex-1" onClick={() => setRunState(null)}>
                キャンセル
              </Button>
              <Button variant="primary" className="flex-1" onClick={() => void executeRun()}>
                {runState.plans.length} 件を移動
              </Button>
            </div>
          ) : (
            <Button variant="secondary" className="w-full" onClick={() => setRunState(null)}>
              閉じる
            </Button>
          )
        }
      >
        {runState && runState.plans.length === 0 && runState.failures.length === 0 ? (
          <p className="px-4 py-6 text-center text-sm text-ink-sub dark:text-[#98a3b0]">
            移動対象のPDFはありませんでした。
          </p>
        ) : null}

        {runState?.plans.map((plan) => (
          <div key={plan.file.id} className="border-b divider px-4 py-2.5">
            <p className="break-words text-sm text-ink dark:text-[#e6eaef]">
              {middleEllipsis(plan.file.name, 40)}
            </p>
            <p className="mt-0.5 break-words text-xs text-ink-sub dark:text-[#98a3b0]">
              {folderLabel(plan.fromParentId)} → {folderLabel(plan.toParentId)}
            </p>
            <p className="mt-0.5 break-words text-xs text-brand-600 dark:text-brand-300">
              {plan.rule.name}
              {plan.matches.length > 1
                ? `（ほか ${plan.matches.length - 1} 件のルールにも一致）`
                : ''}
            </p>
          </div>
        ))}

        {runState && runState.failures.length > 0 ? (
          <div className="px-4 py-3">
            <p className="text-sm font-medium text-pdf">
              処理できなかったPDF（{runState.failures.length} 件）
            </p>
            {runState.failures.map((failure) => (
              <p
                key={failure.fileId}
                className="mt-1 break-words text-xs text-ink-sub dark:text-[#98a3b0]"
              >
                {middleEllipsis(failure.fileName, 36)}：{failure.reason}
              </p>
            ))}
          </div>
        ) : null}
      </BottomSheet>

      <RuleEditor
        open={editor !== null}
        draft={editor}
        folders={folders}
        onClose={() => setEditor(null)}
        onSave={(draft) => void saveDraft(draft)}
      />

      <ConfirmDialog
        open={deleteTarget !== null}
        title="ルールを削除しますか？"
        description={
          deleteTarget
            ? `「${deleteTarget.name}」を削除します。すでに分類されたPDFはそのままです。`
            : undefined
        }
        confirmLabel="削除"
        tone="danger"
        onClose={() => setDeleteTarget(null)}
        onConfirm={() => {
          const target = deleteTarget;
          setDeleteTarget(null);
          if (!target) return;
          void deleteRule(target.id)
            .then(() => reloadRules())
            .then(() => notify('ルールを削除しました。', 'success'))
            .catch((error) => notify(toMessage(error), 'error'));
        }}
      />

      {busy ? (
        <div className="fixed inset-0 z-[80] flex items-center justify-center bg-[rgba(15,23,32,0.35)]">
          <div className="flex items-center gap-3 rounded-sheet bg-surface px-5 py-4 shadow-pop dark:bg-[#181e26]">
            <Spinner />
            <p className="text-base text-ink dark:text-[#e6eaef]">{busy}</p>
          </div>
        </div>
      ) : null}
    </>
  );
}
