'use client';

import { useState } from 'react';
import { Archive, ArrowLeft, Bell, Clock, History, Moon } from 'lucide-react';
import { useApp } from '@/store/AppStore';
import { useStock } from '@/store/StockStore';
import type { ThemeMode } from '@/lib/types';
import { ARCHIVE_FOLDER_NAME, findRootFolder } from '@/lib/stock/folders';
import { Button, IconButton, SectionTitle, Switch } from '@/components/ui/Primitives';
import { BottomSheet } from '@/components/ui/Sheet';
import { CloudSettings } from '@/components/cloud/CloudSettings';
import { Header } from '@/components/views/Header';

const THEME_LABELS: Record<ThemeMode, string> = {
  system: '端末の設定に合わせる',
  light: 'ライト',
  dark: 'ダーク',
};

function Row({
  label,
  description,
  children,
}: {
  label: string;
  description?: string;
  children?: React.ReactNode;
}) {
  return (
    <div className="flex min-h-tap items-center justify-between gap-3 border-b divider px-4 py-3 last:border-b-0">
      <div className="min-w-0 flex-1">
        <p className="text-base text-ink dark:text-[#e6eaef]">{label}</p>
        {description ? (
          <p className="mt-0.5 break-words text-xs leading-relaxed text-ink-sub dark:text-[#98a3b0]">
            {description}
          </p>
        ) : null}
      </div>
      {children}
    </div>
  );
}

export function StockSettingsView({
  onOpenNotifications,
}: {
  onOpenNotifications: () => void;
}) {
  const {
    settings,
    updateSettings,
    folders,
    navigate,
    notify,
    goBack,
    canGoBack,
  } = useApp();
  const stock = useStock();
  const [sheet, setSheet] = useState<'time' | 'theme' | null>(null);

  const unreadNotices = stock.notifications.filter((entry) => !entry.isRead).length;
  const archive = findRootFolder(folders, ARCHIVE_FOLDER_NAME);

  return (
    <>
      <Header
        title="設定"
        left={
          canGoBack ? (
            <IconButton label="戻る" onClick={goBack}>
              <ArrowLeft size={22} />
            </IconButton>
          ) : undefined
        }
      />

      <SectionTitle>株式ニュース</SectionTitle>
      <div className="bg-surface dark:bg-[#181e26]">
        <Row
          label="追跡中の銘柄"
          description={
            stock.subscriptions.length === 0
              ? 'まだ登録されていません。ホーム画面の「銘柄追加」から登録できます。'
              : stock.subscriptions.map((entry) => entry.ticker).join('、')
          }
        />

        <button type="button" className="w-full text-left" onClick={() => setSheet('time')}>
          <Row label="銘柄追加時の既定取得時刻" description={`${settings.stockDefaultTime}（Asia/Tokyo）`}>
            <Clock size={20} className="text-ink-sub" />
          </Row>
        </button>

        <Row
          label="レポート完成時に通知する"
          description={
            settings.stockPushEnabled
              ? '端末通知が有効です。'
              : '無効でも、アプリ内の通知履歴には結果が残ります。'
          }
        >
          <Switch
            checked={settings.stockPushEnabled}
            onChange={(enabled) => {
              if (enabled) void stock.enablePushNotifications();
              else void updateSettings({ stockPushEnabled: false });
            }}
            label="レポート完成時の通知"
          />
        </Row>

        <button type="button" className="w-full text-left" onClick={onOpenNotifications}>
          <Row
            label="通知履歴"
            description={unreadNotices > 0 ? `未読 ${unreadNotices} 件` : `${stock.notifications.length} 件`}
          >
            <Bell size={20} className="text-ink-sub" />
          </Row>
        </button>

        <button type="button" className="w-full text-left" onClick={() => navigate({ view: 'history' })}>
          <Row label="実行履歴" description="成功・ニュースなし・失敗・エラー内容を確認します。">
            <History size={20} className="text-ink-sub" />
          </Row>
        </button>
      </div>

      <CloudSettings />

      <SectionTitle>表示</SectionTitle>
      <div className="bg-surface dark:bg-[#181e26]">
        <button type="button" className="w-full text-left" onClick={() => setSheet('theme')}>
          <Row label="外観" description={THEME_LABELS[settings.theme]}>
            <Moon size={20} className="text-ink-sub" />
          </Row>
        </button>
      </div>

      <SectionTitle>旧PDF</SectionTitle>
      <div className="bg-surface dark:bg-[#181e26]">
        <button
          type="button"
          className="w-full text-left"
          onClick={() => {
            if (!archive) {
              notify('旧PDFアーカイブはありません。', 'info');
              return;
            }
            navigate({ view: 'folder', folderId: archive.id });
          }}
        >
          <Row
            label="旧PDFアーカイブ"
            description="以前のPDFは読み取り専用です。新規追加・編集・自動分類は行いません。"
          >
            <Archive size={20} className="text-ink-sub" />
          </Row>
        </button>
      </div>

      <p className="px-4 py-5 text-xs leading-relaxed text-ink-sub dark:text-[#98a3b0]">
        このアプリの主機能は、登録銘柄のニュース取得・レポート保存・閲覧です。画像からのPDF作成、カメラスキャン、PDF編集、学習PDFの自動取込、自動分類は通常画面から無効化されています。
      </p>

      <BottomSheet
        open={sheet === 'time'}
        title="既定の取得時刻"
        description="新しく銘柄を追加するときの初期値です。登録後は銘柄ごとに変更できます。"
        onClose={() => setSheet(null)}
      >
        <label className="block px-4 py-4">
          <span className="mb-1 block text-sm text-ink dark:text-[#e6eaef]">取得時刻</span>
          <input
            type="time"
            value={settings.stockDefaultTime}
            onChange={(event) => void updateSettings({ stockDefaultTime: event.target.value })}
            className="w-full rounded-card border border-line bg-surface px-3 py-2 text-base text-ink dark:border-[#333d49] dark:bg-[#1b222a] dark:text-[#e6eaef]"
          />
        </label>
        <div className="px-4 pb-4">
          <Button variant="primary" className="w-full" onClick={() => setSheet(null)}>
            完了
          </Button>
        </div>
      </BottomSheet>

      <BottomSheet
        open={sheet === 'theme'}
        title="外観"
        onClose={() => setSheet(null)}
      >
        {(Object.keys(THEME_LABELS) as ThemeMode[]).map((theme) => (
          <button
            key={theme}
            type="button"
            className="flex min-h-tap w-full items-center justify-between border-b divider px-4 py-3 text-left last:border-b-0"
            onClick={() => {
              void updateSettings({ theme });
              setSheet(null);
            }}
          >
            <span className="text-base text-ink dark:text-[#e6eaef]">{THEME_LABELS[theme]}</span>
            <span className="text-sm text-brand-500 dark:text-brand-300">
              {settings.theme === theme ? '選択中' : ''}
            </span>
          </button>
        ))}
      </BottomSheet>
    </>
  );
}
