'use client';

/**
 * 設定画面の「クラウド保管」セクション。
 *
 * 既定は OFF。ユーザーが明示的に ON にし、ログインするまで
 * クラウドへのアップロードは一切始まらない。
 */
import { useState } from 'react';
import {
  AlertTriangle,
  Cloud,
  CloudDownload,
  CloudUpload,
  LogIn,
  LogOut,
  RefreshCw,
  Wifi,
} from 'lucide-react';
import { formatBytes, formatDateTime } from '@/lib/format';
import { networkKind } from '@/lib/cloudSync';
import { CLOUD_IDLE_OPTIONS } from '@/lib/types';
import { useApp } from '@/store/AppStore';
import { useCloud } from '@/store/CloudStore';
import { Button, SectionTitle, Spinner, Switch, cx } from '@/components/ui/Primitives';
import { BottomSheet, MenuRow } from '@/components/ui/Sheet';
import { ConfirmDialog } from '@/components/dialogs/CommonDialogs';

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
    <div className="flex min-h-tap items-center justify-between gap-3 border-b divider px-4 py-3">
      <div className="min-w-0 flex-1">
        <p className="text-base text-ink dark:text-[#e6eaef]">{label}</p>
        {description ? (
          <p className="mt-0.5 whitespace-pre-line text-xs text-ink-sub dark:text-[#98a3b0]">
            {description}
          </p>
        ) : null}
      </div>
      {children}
    </div>
  );
}

function idleLabel(days: number): string {
  if (days === 0) return '自動移動しない';
  return `${days}日`;
}

/* ------------------------------------------------------------------ */
/* ログインフォーム                                                    */
/* ------------------------------------------------------------------ */

function SignInForm() {
  const cloud = useCloud();
  const { notify } = useApp();
  const [mode, setMode] = useState<'signIn' | 'signUp'>('signIn');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!cloud) return null;

  const submit = async () => {
    if (busy) return;
    setError(null);
    setBusy(true);
    try {
      if (mode === 'signIn') await cloud.signIn(email, password);
      else await cloud.signUp(email, password);
      setPassword('');
      notify('クラウド保管へログインしました。', 'success');
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'ログインできませんでした。');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-3 border-b divider px-4 py-4">
      <p className="text-sm text-ink-sub dark:text-[#98a3b0]">
        クラウド上のPDFは、ログインした本人だけが読み書きできます。
        {mode === 'signIn' ? '初めての場合は「新規登録」を選んでください。' : ''}
      </p>
      <div className="flex gap-2">
        {(
          [
            ['signIn', 'ログイン'],
            ['signUp', '新規登録'],
          ] as const
        ).map(([key, label]) => (
          <button
            key={key}
            type="button"
            onClick={() => setMode(key)}
            className={cx(
              'min-h-tap flex-1 rounded-card border text-sm font-medium',
              mode === key
                ? 'border-brand-500 bg-brand-50 text-brand-600 dark:bg-[#16233a] dark:text-brand-200'
                : 'border-line text-ink-sub dark:border-[#333d49] dark:text-[#98a3b0]',
            )}
          >
            {label}
          </button>
        ))}
      </div>
      <input
        type="email"
        inputMode="email"
        autoComplete="email"
        placeholder="メールアドレス"
        value={email}
        onChange={(event) => setEmail(event.target.value)}
        className="w-full min-h-tap rounded-card border border-line bg-surface px-3 text-base text-ink dark:border-[#333d49] dark:bg-[#1b222a] dark:text-[#e6eaef]"
      />
      <input
        type="password"
        autoComplete={mode === 'signIn' ? 'current-password' : 'new-password'}
        placeholder="パスワード（6文字以上）"
        value={password}
        onChange={(event) => setPassword(event.target.value)}
        className="w-full min-h-tap rounded-card border border-line bg-surface px-3 text-base text-ink dark:border-[#333d49] dark:bg-[#1b222a] dark:text-[#e6eaef]"
      />
      {error ? <p className="text-sm text-pdf">{error}</p> : null}
      <Button
        variant="primary"
        className="w-full"
        disabled={busy || !email || password.length < 6}
        onClick={() => void submit()}
      >
        {busy ? <Spinner className="border-white/40 border-t-white" /> : <LogIn size={18} />}
        {mode === 'signIn' ? 'ログイン' : '登録してログイン'}
      </Button>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* 本体                                                                */
/* ------------------------------------------------------------------ */

export function CloudSettings() {
  const { settings, updateSettings } = useApp();
  const cloud = useCloud();
  const [sheet, setSheet] = useState<'idle' | null>(null);
  const [confirmRestore, setConfirmRestore] = useState(false);
  const [confirmSignOut, setConfirmSignOut] = useState(false);

  if (!cloud) return null;

  const stats = cloud.stats;
  const kind = networkKind();
  const wifiNote =
    kind === 'unknown'
      ? 'この端末では接続の種類を判別できないため、この設定は適用されません（iPhoneのSafariなど）。'
      : kind === 'wifi'
        ? '現在Wi-Fi接続です。'
        : kind === 'cellular'
          ? '現在モバイル通信のため、アップロードは待機します。'
          : '現在オフラインです。';

  return (
    <>
      <SectionTitle>クラウド保管</SectionTitle>
      <div className="bg-surface dark:bg-[#181e26]">
        <Row
          label="クラウド保管を使う"
          description={
            'しばらく開いていないPDFの本体だけをクラウドへ預け、端末の容量を節約します。\nファイル名・フォルダー・タグ・メモ・サムネイルは端末に残り、一覧からも消えません。'
          }
        >
          <Switch
            checked={settings.cloudEnabled}
            onChange={(value) => void updateSettings({ cloudEnabled: value })}
            label="クラウド保管を使う"
          />
        </Row>

        {settings.cloudEnabled && !cloud.user ? <SignInForm /> : null}

        {settings.cloudEnabled && cloud.user ? (
          <>
            <Row label="ログイン中のアカウント" description={cloud.user.email ?? cloud.user.uid}>
              <Button
                variant="ghost"
                className="h-9 min-h-0 px-2 text-sm"
                onClick={() => setConfirmSignOut(true)}
              >
                <LogOut size={16} />
                ログアウト
              </Button>
            </Row>

            <button type="button" className="w-full text-left" onClick={() => setSheet('idle')}>
              <Row
                label="未使用期間"
                description={`${idleLabel(settings.cloudIdleDays)}${
                  settings.cloudIdleDays > 0
                    ? `以上開いていないPDFをクラウドへ移動します（未閲覧のPDFは追加から${settings.cloudIdleDays}日）`
                    : '（手動での移動だけ行います）'
                }`}
              >
                <Cloud size={20} className="text-ink-sub" />
              </Row>
            </button>

            <Row label="Wi-Fi接続時のみアップロード" description={wifiNote}>
              <Switch
                checked={settings.cloudWifiOnly}
                onChange={(value) => void updateSettings({ cloudWifiOnly: value })}
                label="Wi-Fi接続時のみアップロード"
              />
            </Row>

            <button
              type="button"
              className="w-full text-left"
              disabled={cloud.syncing}
              onClick={() => void cloud.syncNow()}
            >
              <Row
                label="今すぐ対象ファイルをクラウドへ移動"
                description="条件を満たすPDFをすぐに処理します"
              >
                {cloud.syncing ? <Spinner /> : <CloudUpload size={20} className="text-ink-sub" />}
              </Row>
            </button>

            <button
              type="button"
              className="w-full text-left"
              disabled={cloud.syncing || stats.cloudCount + stats.trashedCloudCount === 0}
              onClick={() => setConfirmRestore(true)}
            >
              <Row
                label="すべてのクラウドPDFを端末へ戻す"
                description="端末へ保存できたことを確認してからクラウド側を削除します"
              >
                {cloud.syncing ? <Spinner /> : <CloudDownload size={20} className="text-ink-sub" />}
              </Row>
            </button>

          </>
        ) : null}

        {settings.cloudEnabled ? (
          <Row
            label="クラウドの状況"
            description={[
              `クラウド使用量 ${formatBytes(stats.cloudBytes)}`,
              `クラウド保管中のPDF ${stats.cloudCount} 件${
                stats.trashedCloudCount > 0 ? `（ごみ箱内にさらに ${stats.trashedCloudCount} 件）` : ''
              }`,
              `端末内キャッシュ ${stats.cachedCount} 件`,
              `最後に同期した日時 ${
                settings.cloudLastSyncAt ? formatDateTime(settings.cloudLastSyncAt) : '未実行'
              }`,
              `同期エラー ${stats.errorCount} 件${
                cloud.pendingDeletes > 0 ? ` ・ クラウド削除の待ち ${cloud.pendingDeletes} 件` : ''
              }`,
            ].join('\n')}
          >
            {stats.errorCount > 0 ? (
              <AlertTriangle size={20} className="text-pdf" />
            ) : (
              <RefreshCw size={20} className="text-ink-sub" />
            )}
          </Row>
        ) : null}
      </div>

      {settings.cloudEnabled ? (
        <div className="bg-surface px-4 py-3 dark:bg-[#181e26]">
          <div className="flex gap-2 text-sm text-ink-sub dark:text-[#98a3b0]">
            <Wifi size={18} className="mt-0.5 shrink-0" />
            <div className="space-y-2">
              <p>
                クラウドへ移したPDFは一覧に残り、タップすると自動で取得して開きます。
                オフラインのときは取得できないため、その旨のメッセージを表示します。
              </p>
              <p>
                端末内のPDF本体を削除するのは、アップロード・存在確認・サイズ照合・保存先の記録が
                すべて成功したあとだけです。途中で失敗した場合、PDFは端末内にそのまま残ります。
              </p>
            </div>
          </div>
        </div>
      ) : null}

      {/* 未使用期間 */}
      <BottomSheet open={sheet === 'idle'} title="未使用期間" onClose={() => setSheet(null)}>
        {CLOUD_IDLE_OPTIONS.map((days) => (
          <MenuRow
            key={days}
            icon={
              <span
                className={cx(
                  'h-2.5 w-2.5 rounded-full',
                  settings.cloudIdleDays === days ? 'bg-brand-500' : 'bg-line',
                )}
              />
            }
            label={idleLabel(days)}
            onClick={() => {
              void updateSettings({ cloudIdleDays: days });
              setSheet(null);
            }}
          />
        ))}
      </BottomSheet>

      <ConfirmDialog
        open={confirmRestore}
        title="すべてのクラウドPDFを端末へ戻しますか？"
        description={`クラウドに保管中の ${stats.cloudCount + stats.trashedCloudCount} 件のPDFを端末へダウンロードします。端末内へ保存できたことを確認してからクラウド側を削除するため、途中で失敗してもPDFが失われることはありません。戻したPDFがすぐに再アップロードされないよう、クラウド保管はオフになります。`}
        confirmLabel="端末へ戻す"
        onClose={() => setConfirmRestore(false)}
        onConfirm={() => {
          setConfirmRestore(false);
          void cloud.restoreAll();
        }}
      />

      <ConfirmDialog
        open={confirmSignOut}
        title="ログアウトしますか？"
        description="端末内のPDF・フォルダー・タグ・メモは削除されません。クラウド保管済みのPDFは、もう一度ログインするまで開けなくなります。"
        confirmLabel="ログアウト"
        onClose={() => setConfirmSignOut(false)}
        onConfirm={() => {
          setConfirmSignOut(false);
          void cloud.signOut();
        }}
      />
    </>
  );
}
