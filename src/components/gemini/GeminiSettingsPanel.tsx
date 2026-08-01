'use client';

import { ArrowLeft, Clock3, Plus, Save, Trash2, X } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import {
  deletePdfGenerationRule,
  saveGeminiPreferences,
  savePdfGenerationRule,
  subscribePdfGenerationRules,
} from '@/lib/geminiCloud';
import {
  GEMINI_TIME_ZONE,
  type GeminiPreferences,
  type PdfDuplicateMode,
  type PdfGenerationRule,
} from '@/lib/geminiTypes';
import { ROOT_ID, type Folder } from '@/lib/types';
import { ROOT_NAME, pathString } from '@/lib/tree';
import { Button, IconButton, Spinner, Switch } from '@/components/ui/Primitives';

type EditableRule = Omit<PdfGenerationRule, 'id' | 'createdAt' | 'updatedAt'> & { id?: string };

const inputClass =
  'min-h-tap w-full rounded-xl border divider bg-surface px-3 py-2.5 text-base text-ink outline-none focus:border-brand-400 dark:bg-[#181e26] dark:text-[#e6eaef]';

function newRule(): EditableRule {
  return {
    name: '毎日の学習まとめ',
    enabled: true,
    time: '23:00',
    timeZone: GEMINI_TIME_ZONE,
    chatTarget: 'sameDay',
    folderId: ROOT_ID,
    folderPath: ROOT_NAME,
    fileNameTemplate: '学習_yyyymmdd.pdf',
    titleTemplate: '学習まとめ yyyy-mm-dd',
    purpose: '復習・試験対策',
    instructions: '質問、勘違い、詰まった点を整理し、Linuxではコマンド例を付ける。',
    keepChat: true,
    notifyOnSuccess: true,
    duplicateMode: 'replaceSameDate',
  };
}

function RuleEditor({
  uid,
  folders,
  initial,
  onClose,
  notify,
}: {
  uid: string;
  folders: Folder[];
  initial: EditableRule;
  onClose: () => void;
  notify: (message: string, tone?: 'info' | 'error' | 'success') => void;
}) {
  const [draft, setDraft] = useState(initial);
  const [saving, setSaving] = useState(false);
  const choices = useMemo(
    () =>
      folders
        .filter((folder) => !folder.deletedAt)
        .sort((a, b) => pathString(folders, a.id).localeCompare(pathString(folders, b.id), 'ja')),
    [folders],
  );

  const save = async () => {
    if (!draft.name.trim() || !draft.time || !draft.fileNameTemplate.trim()) return;
    setSaving(true);
    try {
      await savePdfGenerationRule(uid, draft);
      notify('自動PDFルールを保存しました。', 'success');
      onClose();
    } catch (error) {
      notify(error instanceof Error ? error.message : 'ルールを保存できませんでした。', 'error');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 z-[120] overflow-y-auto bg-app dark:bg-[#11161c]">
      <div className="mx-auto min-h-full max-w-3xl pb-10">
        <header className="sticky top-0 z-10 flex min-h-[58px] items-center gap-2 border-b divider bg-surface/95 px-3 backdrop-blur dark:bg-[#181e26]/95">
          <IconButton label="戻る" onClick={onClose}><ArrowLeft size={22} /></IconButton>
          <h2 className="flex-1 text-lg font-semibold">自動PDFルール</h2>
          <Button variant="primary" onClick={() => void save()} disabled={saving}>
            {saving ? <Spinner /> : <Save size={18} />} 保存
          </Button>
        </header>

        <div className="space-y-5 px-4 py-5">
          <label className="block"><span className="mb-1 block text-sm font-medium">ルール名</span><input className={inputClass} value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} /></label>
          <div className="flex items-center justify-between rounded-card bg-surface px-4 py-3 dark:bg-[#181e26]">
            <div><p className="font-medium">自動作成</p><p className="text-xs text-ink-sub">指定時刻を定期処理が確認します。</p></div>
            <Switch checked={draft.enabled} onChange={(enabled) => setDraft({ ...draft, enabled })} label="自動作成" />
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            <label><span className="mb-1 block text-sm font-medium">作成時刻</span><input type="time" className={inputClass} value={draft.time} onChange={(e) => setDraft({ ...draft, time: e.target.value })} /></label>
            <label><span className="mb-1 block text-sm font-medium">対象チャット</span><select className={inputClass} value={draft.chatTarget} onChange={(e) => setDraft({ ...draft, chatTarget: e.target.value as EditableRule['chatTarget'] })}><option value="sameDay">当日のチャット</option><option value="previousDay">前日のチャット</option></select></label>
          </div>
          <label className="block">
            <span className="mb-1 block text-sm font-medium">保存先</span>
            <select className={inputClass} value={draft.folderId} onChange={(e) => { const folderId = e.target.value; setDraft({ ...draft, folderId, folderPath: folderId === ROOT_ID ? ROOT_NAME : pathString(folders, folderId) }); }}>
              <option value={ROOT_ID}>{ROOT_NAME}</option>
              {choices.map((folder) => <option key={folder.id} value={folder.id}>{pathString(folders, folder.id)}</option>)}
            </select>
          </label>
          <label className="block"><span className="mb-1 block text-sm font-medium">ファイル名</span><input className={inputClass} value={draft.fileNameTemplate} onChange={(e) => setDraft({ ...draft, fileNameTemplate: e.target.value })} /><p className="mt-1 text-xs text-ink-sub">yyyy / mm / dd / yyyymmdd / yyyy-mm-dd / weekday / chat_title / rule_name</p></label>
          <label className="block"><span className="mb-1 block text-sm font-medium">PDFタイトル</span><input className={inputClass} value={draft.titleTemplate} onChange={(e) => setDraft({ ...draft, titleTemplate: e.target.value })} /></label>
          <label className="block"><span className="mb-1 block text-sm font-medium">用途</span><input className={inputClass} value={draft.purpose} onChange={(e) => setDraft({ ...draft, purpose: e.target.value })} /></label>
          <label className="block"><span className="mb-1 block text-sm font-medium">追加指示</span><textarea className={`${inputClass} min-h-32 resize-y`} value={draft.instructions} onChange={(e) => setDraft({ ...draft, instructions: e.target.value })} /></label>
          <label className="block"><span className="mb-1 block text-sm font-medium">同名PDFの扱い</span><select className={inputClass} value={draft.duplicateMode} onChange={(e) => setDraft({ ...draft, duplicateMode: e.target.value as PdfDuplicateMode })}><option value="replaceSameDate">同じ日付を置き換える</option><option value="overwrite">上書き</option><option value="rename">連番を付ける</option><option value="skip">スキップ</option></select></label>
          <div className="rounded-card bg-surface dark:bg-[#181e26]">
            <div className="flex items-center justify-between border-b divider px-4 py-3"><span>PDF作成後もチャットを残す</span><Switch checked={draft.keepChat} onChange={(keepChat) => setDraft({ ...draft, keepChat })} label="チャットを残す" /></div>
            <div className="flex items-center justify-between px-4 py-3"><span>成功時にアプリ内通知</span><Switch checked={draft.notifyOnSuccess} onChange={(notifyOnSuccess) => setDraft({ ...draft, notifyOnSuccess })} label="成功通知" /></div>
          </div>
        </div>
      </div>
    </div>
  );
}

export function GeminiSettingsPanel({ uid, folders, preferences, onPreferencesChange, onClose, notify }: {
  uid: string;
  folders: Folder[];
  preferences: GeminiPreferences;
  onPreferencesChange: (preferences: GeminiPreferences) => void;
  onClose: () => void;
  notify: (message: string, tone?: 'info' | 'error' | 'success') => void;
}) {
  const [rules, setRules] = useState<PdfGenerationRule[]>([]);
  const [editing, setEditing] = useState<EditableRule | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => subscribePdfGenerationRules(uid, setRules, () => notify('自動PDFルールを読み込めませんでした。', 'error')), [notify, uid]);

  const savePreferences = async () => {
    setSaving(true);
    try { await saveGeminiPreferences(uid, preferences); notify('Gemini設定を保存しました。', 'success'); }
    catch { notify('Gemini設定を保存できませんでした。', 'error'); }
    finally { setSaving(false); }
  };

  if (editing) return <RuleEditor uid={uid} folders={folders} initial={editing} onClose={() => setEditing(null)} notify={notify} />;

  const toggles: Array<[keyof GeminiPreferences, string]> = [
    ['emphasizeImportant', '重要語句を強調する'],
    ['includeCommandExamples', 'コマンド例を含める'],
    ['preferTables', '比較では表を使う'],
    ['beginnerFriendly', '初心者向け説明を含める'],
    ['includeExamTips', '試験対策を含める'],
  ];

  return (
    <div className="fixed inset-0 z-[110] overflow-y-auto bg-app dark:bg-[#11161c]">
      <div className="mx-auto min-h-full max-w-3xl pb-10">
        <header className="sticky top-0 z-10 flex min-h-[58px] items-center gap-2 border-b divider bg-surface/95 px-3 backdrop-blur dark:bg-[#181e26]/95">
          <IconButton label="閉じる" onClick={onClose}><X size={22} /></IconButton>
          <h2 className="flex-1 text-lg font-semibold">Gemini設定</h2>
          <Button variant="primary" onClick={() => void savePreferences()} disabled={saving}>{saving ? <Spinner /> : <Save size={18} />} 保存</Button>
        </header>
        <div className="px-4 py-5">
          <h3 className="mb-2 text-sm font-semibold text-ink-sub">回答設定</h3>
          <div className="rounded-card bg-surface dark:bg-[#181e26]">
            <label className="block border-b divider px-4 py-3"><span className="mb-1 block text-sm">用途</span><select className={inputClass} value={preferences.purpose} onChange={(e) => onPreferencesChange({ ...preferences, purpose: e.target.value as GeminiPreferences['purpose'] })}><option value="learning">学習用</option><option value="work">業務用</option><option value="general">一般</option></select></label>
            <label className="block border-b divider px-4 py-3"><span className="mb-1 block text-sm">詳しさ</span><select className={inputClass} value={preferences.detail} onChange={(e) => onPreferencesChange({ ...preferences, detail: e.target.value as GeminiPreferences['detail'] })}><option value="concise">簡潔</option><option value="standard">標準</option><option value="detailed">詳しく</option></select></label>
            <label className="block border-b divider px-4 py-3"><span className="mb-1 block text-sm">回答方針</span><textarea className={`${inputClass} min-h-28 resize-y`} value={preferences.responsePolicy} onChange={(e) => onPreferencesChange({ ...preferences, responsePolicy: e.target.value })} /></label>
            {toggles.map(([key, label]) => <div key={key} className="flex items-center justify-between border-b divider px-4 py-3 last:border-b-0"><span>{label}</span><Switch checked={preferences[key] === true} onChange={(value) => onPreferencesChange({ ...preferences, [key]: value })} label={label} /></div>)}
          </div>

          <div className="mb-2 mt-7 flex items-center justify-between gap-3"><div><h3 className="text-sm font-semibold text-ink-sub">自動PDF作成</h3><p className="text-xs text-ink-sub">ブラウザーを閉じていても実行します。</p></div><Button onClick={() => setEditing(newRule())}><Plus size={18} /> 追加</Button></div>
          <div className="space-y-3">
            {rules.length === 0 ? <div className="rounded-card bg-surface px-4 py-8 text-center text-sm text-ink-sub dark:bg-[#181e26]">自動PDFルールはありません。</div> : rules.map((rule) => (
              <div key={rule.id} className="rounded-card bg-surface px-4 py-3 dark:bg-[#181e26]">
                <button type="button" className="w-full text-left" onClick={() => setEditing({ ...rule })}>
                  <div className="flex justify-between gap-3"><div className="min-w-0"><p className="truncate font-semibold">{rule.name}</p><p className="mt-1 flex items-center gap-1 text-sm text-ink-sub"><Clock3 size={15} /> {rule.time}・{rule.folderPath}</p><p className="truncate text-xs text-ink-sub">{rule.fileNameTemplate}</p></div><span className="text-xs text-ink-sub">{rule.enabled ? 'ON' : 'OFF'}</span></div>
                </button>
                <div className="mt-3 flex justify-end border-t divider pt-2"><button type="button" className="flex min-h-tap items-center gap-1 px-3 text-sm text-pdf" onClick={() => { if (window.confirm(`「${rule.name}」を削除しますか？`)) void deletePdfGenerationRule(uid, rule.id).catch(() => notify('削除できませんでした。', 'error')); }}><Trash2 size={17} /> 削除</button></div>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
