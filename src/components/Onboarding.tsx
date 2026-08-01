'use client';

/** 初回起動時のチュートリアル。 */
import { useState } from 'react';
import { Bell, Clock, FolderPlus, Newspaper, ShieldCheck } from 'lucide-react';
import { Button, cx } from '@/components/ui/Primitives';

const STEPS = [
  {
    icon: FolderPlus,
    title: '追跡したい銘柄を追加',
    body: '画面下中央の「銘柄追加」から、ニュースを追いたい銘柄を選びます。一覧にない銘柄は、ティッカーを直接入力しても追加できます。',
  },
  {
    icon: Clock,
    title: '取得時刻を決める',
    body: '既定は毎日8:00（日本時間）です。頻度・時刻・レポートの詳しさは、銘柄ごとにあとから変更できます。',
  },
  {
    icon: Newspaper,
    title: '毎日レポートが自動で届く',
    body: '取得時刻になるとサーバー側でニュースを集め、整理した日次レポートが銘柄フォルダーに保存されます。アプリを閉じていても作成されます。',
  },
  {
    icon: Bell,
    title: '未読と重要度で見分ける',
    body: 'レポートには重要度・カテゴリー・ポジティブ／ネガティブの区分が付きます。通知履歴からも作成状況を確認できます。',
  },
  {
    icon: ShieldCheck,
    title: '投資助言ではありません',
    body: 'レポートは公開情報を自動で整理した情報提供資料です。事実とAIによる分析は分けて記載しており、売買を推奨するものではありません。',
  },
];

export function Onboarding({ onFinish }: { onFinish: () => void }) {
  const [index, setIndex] = useState(0);
  const step = STEPS[index];
  const Icon = step.icon;
  const last = index === STEPS.length - 1;

  return (
    <div className="fixed inset-0 z-[70] flex flex-col bg-surface dark:bg-[#11161c]">
      <div
        className="flex flex-1 flex-col items-center justify-center px-8 text-center"
        style={{ paddingTop: 'var(--safe-top)' }}
      >
        <div className="mb-6 flex h-20 w-20 items-center justify-center rounded-card bg-brand-50 dark:bg-[#16233a]">
          <Icon size={40} className="text-brand-500" strokeWidth={1.6} />
        </div>
        <p className="text-sm font-medium text-brand-500">
          {index + 1} / {STEPS.length}
        </p>
        <h2 className="mt-2 text-xl font-semibold text-ink dark:text-[#e6eaef]">{step.title}</h2>
        <p className="mt-3 max-w-sm text-base leading-relaxed text-ink-sub dark:text-[#98a3b0]">
          {step.body}
        </p>
      </div>

      <div className="flex justify-center gap-1.5 pb-4">
        {STEPS.map((entry, position) => (
          <span
            key={entry.title}
            className={cx(
              'h-1.5 w-1.5 rounded-full',
              position === index ? 'bg-brand-500' : 'bg-line dark:bg-[#3a444f]',
            )}
          />
        ))}
      </div>

      <div
        className="flex gap-2 px-5 pb-5"
        style={{ paddingBottom: 'calc(20px + var(--safe-bottom))' }}
      >
        <Button variant="secondary" className="flex-1" onClick={onFinish}>
          スキップ
        </Button>
        <Button
          variant="primary"
          className="flex-1"
          onClick={() => (last ? onFinish() : setIndex((value) => value + 1))}
        >
          {last ? 'はじめる' : '次へ'}
        </Button>
      </div>
    </div>
  );
}
