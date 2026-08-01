'use client';

/** 銘柄購読設定の入力フォーム（追加画面と設定画面で共用）。 */
import { useMemo } from 'react';
import { Switch } from '@/components/ui/Primitives';
import { pathString } from '@/lib/tree';
import { activeFolders } from '@/lib/tree';
import { FREQUENCY_LABELS, TIME_ZONES, WEEKDAY_LABELS } from '@/lib/stock/core/schedule.mjs';
import type { Folder } from '@/lib/types';
import {
  DETAIL_LABELS,
  EMPTY_DAY_LABELS,
  LANGUAGE_LABELS,
  type Frequency,
  type StockSubscription,
} from '@/lib/stock/types';

export type SubscriptionDraft = Omit<StockSubscription, 'createdAt' | 'updatedAt'>;

const fieldClass =
  'w-full rounded-card border border-line bg-surface px-3 py-2 text-base text-ink dark:border-[#333d49] dark:bg-[#1b222a] dark:text-[#e6eaef]';

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <label className="block px-4 py-2">
      <span className="mb-1 block text-sm font-medium text-ink dark:text-[#e6eaef]">{label}</span>
      {children}
      {hint ? <span className="mt-1 block text-xs text-ink-sub dark:text-[#98a3b0]">{hint}</span> : null}
    </label>
  );
}

export function SubscriptionForm({
  draft,
  folders,
  onChange,
}: {
  draft: SubscriptionDraft;
  folders: Folder[];
  onChange: (patch: Partial<SubscriptionDraft>) => void;
}) {
  const folderOptions = useMemo(
    () =>
      activeFolders(folders)
        .map((folder) => ({ id: folder.id, label: pathString(folders, folder.id) }))
        .sort((a, b) => a.label.localeCompare(b.label, 'ja')),
    [folders],
  );

  return (
    <div className="pb-2">
      <Field label="ティッカーシンボル">
        <input className={fieldClass} value={draft.ticker} readOnly aria-readonly />
      </Field>

      <Field label="企業名" hint="ニュース検索の精度を上げるため、正式な企業名を推奨します。">
        <input
          className={fieldClass}
          value={draft.companyName}
          maxLength={120}
          onChange={(event) => onChange({ companyName: event.target.value })}
        />
      </Field>

      <Field label="保存先フォルダー" hint="既定では銘柄と同じ名前のフォルダーへ保存します。">
        <select
          className={fieldClass}
          value={draft.folderId}
          onChange={(event) => {
            const folder = folderOptions.find((entry) => entry.id === event.target.value);
            onChange({ folderId: event.target.value, folderName: folder?.label ?? draft.folderName });
          }}
        >
          {folderOptions.length === 0 ? <option value="">（銘柄フォルダーを自動作成）</option> : null}
          {folderOptions.map((option) => (
            <option key={option.id} value={option.id}>
              {option.label}
            </option>
          ))}
        </select>
      </Field>

      <Field label="取得頻度">
        <select
          className={fieldClass}
          value={draft.frequency}
          onChange={(event) => onChange({ frequency: event.target.value as Frequency })}
        >
          {(Object.keys(FREQUENCY_LABELS) as Frequency[]).map((key) => (
            <option key={key} value={key}>
              {FREQUENCY_LABELS[key]}
            </option>
          ))}
        </select>
      </Field>

      {draft.frequency === 'weekly' ? (
        <div className="px-4 py-2">
          <span className="mb-1 block text-sm font-medium text-ink dark:text-[#e6eaef]">取得する曜日</span>
          <div className="flex flex-wrap gap-1.5">
            {WEEKDAY_LABELS.map((label, index) => {
              const selected = draft.weekdays.includes(index);
              return (
                <button
                  key={label}
                  type="button"
                  aria-pressed={selected}
                  onClick={() =>
                    onChange({
                      weekdays: selected
                        ? draft.weekdays.filter((day) => day !== index)
                        : [...draft.weekdays, index].sort(),
                    })
                  }
                  className={
                    selected
                      ? 'h-10 w-10 rounded-card bg-brand-500 text-base font-semibold text-white'
                      : 'h-10 w-10 rounded-card border border-line text-base text-ink dark:border-[#333d49] dark:text-[#e6eaef]'
                  }
                >
                  {label}
                </button>
              );
            })}
          </div>
          {draft.weekdays.length === 0 ? (
            <p className="mt-1 text-xs text-pdf">1つ以上の曜日を選んでください。</p>
          ) : null}
        </div>
      ) : null}

      <Field
        label="取得時刻"
        hint={draft.frequency === 'manual' ? '「手動のみ」では自動取得は行いません。' : undefined}
      >
        <input
          type="time"
          className={fieldClass}
          value={draft.time}
          onChange={(event) => onChange({ time: event.target.value })}
        />
      </Field>

      <Field label="タイムゾーン">
        <select
          className={fieldClass}
          value={draft.timeZone}
          onChange={(event) => onChange({ timeZone: event.target.value })}
        >
          {TIME_ZONES.map((zone) => (
            <option key={zone} value={zone}>
              {zone === 'Asia/Tokyo' ? 'Asia/Tokyo（日本時間）' : zone}
            </option>
          ))}
        </select>
      </Field>

      <Field label="ニュースの言語">
        <select
          className={fieldClass}
          value={draft.language}
          onChange={(event) => onChange({ language: event.target.value as 'ja' | 'en' })}
        >
          {(Object.keys(LANGUAGE_LABELS) as ('ja' | 'en')[]).map((key) => (
            <option key={key} value={key}>
              {LANGUAGE_LABELS[key]}
            </option>
          ))}
        </select>
      </Field>

      <Field label="レポートの詳しさ">
        <select
          className={fieldClass}
          value={draft.detail}
          onChange={(event) =>
            onChange({ detail: event.target.value as 'brief' | 'standard' | 'detailed' })
          }
        >
          {(Object.keys(DETAIL_LABELS) as ('brief' | 'standard' | 'detailed')[]).map((key) => (
            <option key={key} value={key}>
              {DETAIL_LABELS[key]}
            </option>
          ))}
        </select>
      </Field>

      <Field label="1レポートあたりの最大ニュース件数">
        <input
          type="number"
          min={1}
          max={20}
          className={fieldClass}
          value={draft.maxArticles}
          onChange={(event) => onChange({ maxArticles: Number(event.target.value) })}
        />
      </Field>

      <Field label="ニュースがない日の処理">
        <select
          className={fieldClass}
          value={draft.emptyDayPolicy}
          onChange={(event) => onChange({ emptyDayPolicy: event.target.value as 'skip' | 'report' })}
        >
          {(Object.keys(EMPTY_DAY_LABELS) as ('skip' | 'report')[]).map((key) => (
            <option key={key} value={key}>
              {EMPTY_DAY_LABELS[key]}
            </option>
          ))}
        </select>
      </Field>

      <div className="flex items-center justify-between gap-3 px-4 py-3">
        <span className="min-w-0">
          <span className="block text-sm font-medium text-ink dark:text-[#e6eaef]">株価データを併記</span>
          <span className="block text-xs text-ink-sub dark:text-[#98a3b0]">
            取得できた場合のみ、終値や出来高をレポートへ載せます。
          </span>
        </span>
        <Switch
          checked={draft.includeQuote}
          onChange={(value) => onChange({ includeQuote: value })}
          label="株価データを併記"
        />
      </div>

      <div className="flex items-center justify-between gap-3 px-4 py-3">
        <span className="min-w-0">
          <span className="block text-sm font-medium text-ink dark:text-[#e6eaef]">自動取得を有効にする</span>
          <span className="block text-xs text-ink-sub dark:text-[#98a3b0]">
            停止中は定期処理の対象になりません。
          </span>
        </span>
        <Switch
          checked={draft.enabled}
          onChange={(value) => onChange({ enabled: value })}
          label="自動取得を有効にする"
        />
      </div>
    </div>
  );
}
