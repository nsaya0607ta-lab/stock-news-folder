'use client';

import { useEffect, useRef } from 'react';
import { planFiles } from '@/lib/classifyRun';
import { listRules } from '@/lib/classifyRules';
import * as repo from '@/lib/repository';
import { activeFiles, toParentKey } from '@/lib/tree';
import { ROOT_ID } from '@/lib/types';
import type { Route } from '@/store/AppStore';
import { useApp } from '@/store/AppStore';

function routeFolderId(route: Route): string | null {
  if (route.view === 'home') return ROOT_ID;
  if (route.view === 'folder') return route.folderId;
  return null;
}

/**
 * 表示したフォルダーに設定されたルールを、そのフォルダー直下のPDFへ1回だけ適用する。
 *
 * - アプリ起動時はルート直下を1階層だけ分類する
 * - ユーザーがフォルダーへ移動するたび、そのフォルダー直下を1階層だけ分類する
 * - 移動先フォルダーのルールは、そのフォルダーを表示したときに初めて実行する
 */
export function FolderRuleRunner() {
  const { ready, fatalError, route, settings, reload } = useApp();
  const handledRoute = useRef<Route | null>(null);
  const queue = useRef<Promise<void>>(Promise.resolve());

  useEffect(() => {
    if (!ready || fatalError || !settings.classifyEnabled) return;

    const folderId = routeFolderId(route);
    if (!folderId || handledRoute.current === route) return;
    handledRoute.current = route;

    const strategy = settings.classifyMultiMatch;
    const textPages = settings.classifyTextPages;

    // 素早く複数フォルダーへ移動しても、訪れた順番どおりに処理する。
    queue.current = queue.current
      .catch(() => undefined)
      .then(async () => {
        const [snapshot, rules] = await Promise.all([repo.refresh(), listRules()]);
        if (rules.length === 0) return;

        const files = activeFiles(snapshot.files).filter(
          (file) => toParentKey(file.parentId) === folderId,
        );
        if (files.length === 0) return;

        const result = await planFiles(files, { rules, strategy, textPages });
        const autoPlans = result.plans.filter((plan) => !plan.needsConfirm);
        let moved = 0;

        for (const plan of autoPlans) {
          // 待機中に別処理で移動・削除されたPDFへ、古い予定を適用しない。
          const current = await repo.readFileMeta(plan.file.id);
          if (!current || current.deletedAt || toParentKey(current.parentId) !== folderId) continue;

          await repo.moveFile(current.id, plan.toParentId, { ruleId: plan.rule.id });
          moved += 1;
        }

        if (moved > 0) await reload();
      });
  }, [
    fatalError,
    ready,
    reload,
    route,
    settings.classifyEnabled,
    settings.classifyMultiMatch,
    settings.classifyTextPages,
  ]);

  return null;
}
