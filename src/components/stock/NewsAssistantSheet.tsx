'use client';

/**
 * 保存済みニュースについてのAI質問。
 *
 * 端末に保存されているレポートの内容だけを材料として渡し、
 * 横断要約・銘柄比較・期間要約・自由質問に答える。
 */
import { useMemo, useRef, useState } from 'react';
import { MessageSquareText, Send, Square } from 'lucide-react';
import { BottomSheet } from '@/components/ui/Sheet';
import { Button, Spinner, cx } from '@/components/ui/Primitives';
import { cloudIdToken } from '@/lib/firebaseCloud';
import { toMessage } from '@/lib/errors';
import { useApp } from '@/store/AppStore';
import { useStock, todayKey } from '@/store/StockStore';
import { CATEGORY_LABELS, SENTIMENT_LABELS } from '@/lib/stock/core/taxonomy.mjs';
import { addDays } from '@/lib/stock/core/schedule.mjs';
import type { StockReportEntry } from '@/lib/stock/types';

/** Geminiへ渡す材料の上限（長すぎる場合は新しい順に切り詰める）。 */
const MAX_CONTEXT_CHARS = 40000;

type Mode = 'today' | 'compare' | 'period' | 'free';

const MODE_LABELS: Record<Mode, string> = {
  today: '今日のニュースを横断要約',
  compare: '複数銘柄のニュースを比較',
  period: '指定期間のニュースを要約',
  free: '保存済みニュースへの質問',
};

function serialize(reports: StockReportEntry[]): string {
  const blocks: string[] = [];
  let total = 0;
  for (const report of reports) {
    const lines = [
      `## ${report.ticker}（${report.companyName}） ${report.reportDate}`,
      `要約: ${report.summary}`,
      ...report.articles.map(
        (article, index) =>
          `${index + 1}. [${CATEGORY_LABELS[article.category]}／重要度${article.importance}／${SENTIMENT_LABELS[article.sentiment]}] ${article.title}\n   ${article.summary}\n   出典: ${article.sourceName} ${article.url}（公開 ${article.publishedAt}）`,
      ),
    ];
    const block = lines.join('\n');
    if (total + block.length > MAX_CONTEXT_CHARS) break;
    total += block.length;
    blocks.push(block);
  }
  return blocks.join('\n\n');
}

export function NewsAssistantSheet({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { notify } = useApp();
  const { reports, subscriptions, cloudReady } = useStock();
  const [mode, setMode] = useState<Mode>('today');
  const [question, setQuestion] = useState('');
  const [tickers, setTickers] = useState<string[]>([]);
  const [days, setDays] = useState(7);
  const [answer, setAnswer] = useState('');
  const [sending, setSending] = useState(false);
  const abortRef = useRef<AbortController | null>(null);

  const today = todayKey();

  const scoped = useMemo(() => {
    if (mode === 'today') return reports.filter((entry) => entry.reportDate === today);
    if (mode === 'compare') {
      const selected = tickers.length > 0 ? tickers : subscriptions.map((entry) => entry.ticker);
      return reports.filter((entry) => selected.includes(entry.ticker)).slice(0, 40);
    }
    const from = addDays(today, -Math.max(1, days));
    return reports.filter((entry) => entry.reportDate >= from && entry.reportDate <= today);
  }, [days, mode, reports, subscriptions, tickers, today]);

  const instruction = useMemo(() => {
    if (mode === 'today') return '本日分のニュースを銘柄横断で要約し、重要なものから順に整理してください。';
    if (mode === 'compare')
      return '指定された銘柄のニュースを比較し、共通点・相違点・注目すべき違いを整理してください。';
    if (mode === 'period') return `直近${days}日間のニュースの流れを、銘柄ごとに要約してください。`;
    return question.trim();
  }, [days, mode, question]);

  const send = async () => {
    if (!cloudReady) {
      notify('AIへの質問にはクラウド連携（ログイン）が必要です。', 'error');
      return;
    }
    if (mode === 'free' && !question.trim()) return;
    if (scoped.length === 0) {
      notify('対象となる保存済みレポートがありません。', 'info');
      return;
    }

    const controller = new AbortController();
    abortRef.current = controller;
    setSending(true);
    setAnswer('');

    const prompt = [
      'あなたは、保存済みの株式ニュースレポートだけを材料として扱うアシスタントです。',
      '次の制約を必ず守ってください。',
      '・以下の資料に書かれていない情報を推測で補わない。',
      '・「買うべき」「売るべき」などの投資助言はしない。',
      '・断定できないことは「可能性がある」「確認が必要」と書く。',
      '・事実と、あなたの分析を分けて書く。',
      '・回答は日本語で、見出しと箇条書きを使って読みやすくまとめる。',
      '',
      `【依頼】${instruction}`,
      '',
      '【保存済みレポート】',
      serialize(scoped),
    ].join('\n');

    try {
      const token = await cloudIdToken();
      const response = await fetch('/api/gemini/chat', {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ messages: [{ role: 'user', text: prompt, attachments: [] }] }),
        signal: controller.signal,
      });
      if (!response.ok || !response.body) {
        const data = (await response.json().catch(() => null)) as { error?: string } | null;
        throw new Error(data?.error || 'AIから回答を取得できませんでした。');
      }
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let text = '';
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        text += decoder.decode(value, { stream: true });
        setAnswer(text);
      }
      setAnswer(text + decoder.decode());
    } catch (error) {
      if ((error as Error)?.name !== 'AbortError') notify(toMessage(error), 'error');
    } finally {
      abortRef.current = null;
      setSending(false);
    }
  };

  return (
    <BottomSheet
      open={open}
      title="ニュースAIアシスタント"
      description="端末に保存されているレポートの内容だけを材料に回答します。"
      onClose={() => {
        abortRef.current?.abort();
        onClose();
      }}
      maxHeight="88vh"
      footer={
        <Button
          variant="primary"
          className="w-full"
          disabled={!sending && mode === 'free' && !question.trim()}
          onClick={() => (sending ? abortRef.current?.abort() : void send())}
        >
          {sending ? <Square size={16} /> : <Send size={18} />}
          {sending ? '停止' : '質問する'}
        </Button>
      }
    >
      <div className="flex flex-wrap gap-1.5 px-4 pt-3">
        {(Object.keys(MODE_LABELS) as Mode[]).map((key) => (
          <button
            key={key}
            type="button"
            aria-pressed={mode === key}
            onClick={() => setMode(key)}
            className={cx(
              'rounded-full border px-3 py-1.5 text-sm',
              mode === key
                ? 'border-brand-500 bg-brand-500 text-white'
                : 'border-line text-ink dark:border-[#333d49] dark:text-[#e6eaef]',
            )}
          >
            {MODE_LABELS[key]}
          </button>
        ))}
      </div>

      {mode === 'compare' ? (
        <div className="px-4 pt-3">
          <p className="mb-1 text-sm text-ink dark:text-[#e6eaef]">比較する銘柄（未選択ならすべて）</p>
          <div className="flex flex-wrap gap-1.5">
            {subscriptions.map((entry) => {
              const selected = tickers.includes(entry.ticker);
              return (
                <button
                  key={entry.ticker}
                  type="button"
                  aria-pressed={selected}
                  onClick={() =>
                    setTickers(
                      selected
                        ? tickers.filter((value) => value !== entry.ticker)
                        : [...tickers, entry.ticker],
                    )
                  }
                  className={cx(
                    'rounded-card border px-3 py-1.5 text-sm',
                    selected
                      ? 'border-brand-500 bg-brand-50 text-brand-600 dark:bg-[#16202e] dark:text-brand-300'
                      : 'border-line text-ink dark:border-[#333d49] dark:text-[#e6eaef]',
                  )}
                >
                  {entry.ticker}
                </button>
              );
            })}
          </div>
        </div>
      ) : null}

      {mode === 'period' ? (
        <label className="block px-4 pt-3">
          <span className="mb-1 block text-sm text-ink dark:text-[#e6eaef]">対象期間（過去 N 日）</span>
          <input
            type="number"
            min={1}
            max={60}
            value={days}
            onChange={(event) => setDays(Number(event.target.value))}
            className="w-full rounded-card border border-line bg-surface px-3 py-2 text-base text-ink dark:border-[#333d49] dark:bg-[#1b222a] dark:text-[#e6eaef]"
          />
        </label>
      ) : null}

      {mode === 'free' ? (
        <label className="block px-4 pt-3">
          <span className="mb-1 block text-sm text-ink dark:text-[#e6eaef]">質問</span>
          <textarea
            rows={3}
            value={question}
            placeholder="例：直近1週間で、決算に関するニュースがあった銘柄は？"
            onChange={(event) => setQuestion(event.target.value)}
            className="w-full rounded-card border border-line bg-surface px-3 py-2 text-base text-ink dark:border-[#333d49] dark:bg-[#1b222a] dark:text-[#e6eaef]"
          />
        </label>
      ) : null}

      <p className="px-4 pt-3 text-xs text-ink-sub dark:text-[#98a3b0]">
        対象レポート：{scoped.length} 件
        {!cloudReady ? '／ クラウド連携（ログイン）が必要です' : ''}
      </p>

      <div className="px-4 py-3">
        {sending && !answer ? (
          <div className="flex items-center gap-2 text-sm text-ink-sub dark:text-[#98a3b0]">
            <Spinner className="h-4 w-4" />
            回答を作成しています…
          </div>
        ) : null}
        {answer ? (
          <div className="card whitespace-pre-wrap break-words p-3 text-sm leading-relaxed text-ink dark:text-[#e6eaef]">
            {answer}
          </div>
        ) : !sending ? (
          <p className="flex items-center gap-2 text-sm text-ink-sub dark:text-[#98a3b0]">
            <MessageSquareText size={16} aria-hidden />
            使い方を選んで「質問する」を押してください。
          </p>
        ) : null}
      </div>
    </BottomSheet>
  );
}
