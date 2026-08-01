'use client';

import {
  CalendarDays,
  FilePlus2,
  FileText,
  ImagePlus,
  Paperclip,
  RotateCcw,
  Send,
  Settings,
  Sparkles,
  Square,
  Trash2,
  X,
} from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { cloudErrorMessage, cloudIdToken } from '@/lib/firebaseCloud';
import {
  cleanupExpiredGeminiChats,
  deleteGeminiAttachment,
  readGeminiPreferences,
  resetGeminiChat,
  saveGeminiMessage,
  subscribeGeminiChats,
  subscribeGeminiMessages,
  updateGeminiChatTitle,
  uploadGeminiAttachment,
} from '@/lib/geminiCloud';
import {
  DEFAULT_GEMINI_PREFERENCES,
  addDays,
  jstDateKey,
  type GeminiAttachment,
  type GeminiChat,
  type GeminiMessage,
  type GeminiPreferences,
} from '@/lib/geminiTypes';
import * as repo from '@/lib/repository';
import { useApp } from '@/store/AppStore';
import { useCloudRequired } from '@/store/CloudStore';
import { Button, IconButton, Spinner, cx } from '@/components/ui/Primitives';
import { MarkdownContent } from './MarkdownContent';
import { GeminiPdfComposer } from './GeminiPdfComposer';
import { GeminiSettingsPanel } from './GeminiSettingsPanel';

const MAX_INPUT_LENGTH = 20_000;
const MAX_PENDING_ATTACHMENTS = 6;

function dateLabel(date: string): string {
  return new Intl.DateTimeFormat('ja-JP', {
    timeZone: 'Asia/Tokyo',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    weekday: 'short',
  }).format(new Date(`${date}T12:00:00+09:00`));
}

function allowedDates(today: string): string[] {
  return Array.from({ length: 5 }, (_, index) => addDays(today, -index));
}

function attachmentIcon(mimeType: string) {
  return mimeType === 'application/pdf' ? <FileText size={15} /> : <ImagePlus size={15} />;
}

function GeminiBackdrop() {
  return (
    <div
      aria-hidden="true"
      className="pointer-events-none absolute inset-0 overflow-hidden dark:hidden"
      style={{ background: 'linear-gradient(180deg, #ffffff 0%, #f8fbff 48%, #e7f1ff 100%)' }}
    >
      <div className="absolute -bottom-28 left-1/2 h-96 w-96 -translate-x-1/2 rounded-full bg-blue-200/35 blur-3xl" />
      <div className="absolute bottom-12 -left-14 h-56 w-56 rounded-full bg-cyan-200/25 blur-3xl" />
      <div className="absolute bottom-24 -right-16 h-64 w-64 rounded-full bg-indigo-200/20 blur-3xl" />
    </div>
  );
}

export function GeminiWorkspace({
  showLauncher = true,
  openSignal = 0,
}: {
  /** 右下の起動ボタンを出すか（株式ニュース画面ではAIボタンを別機能に使う）。 */
  showLauncher?: boolean;
  /** 値が変わったときに画面を開く（設定画面などから開くために使う）。 */
  openSignal?: number;
} = {}) {
  const app = useApp();
  const cloud = useCloudRequired();
  const { files, folders, notify, navigate } = app;
  const [open, setOpen] = useState(false);
  const [today, setToday] = useState(jstDateKey());
  const [selectedDate, setSelectedDate] = useState(jstDateKey());
  const [chats, setChats] = useState<GeminiChat[]>([]);
  const [messages, setMessages] = useState<GeminiMessage[]>([]);
  const [preferences, setPreferences] = useState<GeminiPreferences>(DEFAULT_GEMINI_PREFERENCES);
  const [input, setInput] = useState('');
  const [pendingAttachments, setPendingAttachments] = useState<GeminiAttachment[]>([]);
  const [uploadingAttachment, setUploadingAttachment] = useState(false);
  const [streamText, setStreamText] = useState('');
  const [sending, setSending] = useState(false);
  const [lastFailedInput, setLastFailedInput] = useState<string | null>(null);
  const [showSettings, setShowSettings] = useState(false);
  const [showPdf, setShowPdf] = useState(false);
  const [showDatePicker, setShowDatePicker] = useState(false);
  const [showExistingPicker, setShowExistingPicker] = useState(false);
  const [existingFileId, setExistingFileId] = useState('');
  const [chatTitle, setChatTitle] = useState('');
  const [editingTitle, setEditingTitle] = useState(false);
  const attachmentInput = useRef<HTMLInputElement | null>(null);
  const imageInput = useRef<HTMLInputElement | null>(null);
  const bottomRef = useRef<HTMLDivElement | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const sendFingerprint = useRef('');

  const uid = cloud.user?.uid;

  // 設定画面などから開く要求を受け取る（初期値の 0 では開かない）。
  useEffect(() => {
    if (openSignal > 0) setOpen(true);
  }, [openSignal]);

  const availableDates = useMemo(() => allowedDates(today), [today]);
  const selectedChat = chats.find((chat) => chat.date === selectedDate);
  const activeFiles = useMemo(
    () => files.filter((file) => !file.deletedAt).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)),
    [files],
  );

  useEffect(() => {
    const timer = window.setInterval(() => {
      const next = jstDateKey();
      setToday((current) => {
        if (current !== next) {
          setSelectedDate((date) => (date === current ? next : date));
        }
        return next;
      });
    }, 60_000);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    if (!uid || !open) return;
    const unsubscribeChats = subscribeGeminiChats(uid, setChats, (error) =>
      notify(cloudErrorMessage(error), 'error'),
    );
    void readGeminiPreferences(uid)
      .then(setPreferences)
      .catch((error) => notify(cloudErrorMessage(error), 'error'));
    void cleanupExpiredGeminiChats(uid).catch(() => undefined);
    return unsubscribeChats;
  }, [notify, open, uid]);

  useEffect(() => {
    if (!uid || !open || !availableDates.includes(selectedDate)) {
      setMessages([]);
      return;
    }
    return subscribeGeminiMessages(uid, selectedDate, setMessages, (error) =>
      notify(cloudErrorMessage(error), 'error'),
    );
  }, [availableDates, notify, open, selectedDate, uid]);

  useEffect(() => {
    setChatTitle(selectedChat?.title ?? `${selectedDate}のチャット`);
  }, [selectedChat?.title, selectedDate]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: sending ? 'auto' : 'smooth' });
  }, [messages, sending, streamText]);

  useEffect(
    () => () => {
      abortRef.current?.abort();
    },
    [],
  );

  const removePendingAttachment = useCallback((attachment: GeminiAttachment) => {
    setPendingAttachments((current) => current.filter((item) => item.id !== attachment.id));
    void deleteGeminiAttachment(attachment);
  }, []);

  const addAttachments = async (list: FileList | null) => {
    if (!uid || !list?.length) return;
    const room = MAX_PENDING_ATTACHMENTS - pendingAttachments.length;
    if (room <= 0) {
      notify(`添付は1回につき${MAX_PENDING_ATTACHMENTS}件までです。`, 'error');
      return;
    }
    setUploadingAttachment(true);
    try {
      for (const file of Array.from(list).slice(0, room)) {
        const attachment = await uploadGeminiAttachment(uid, selectedDate, file, file.name);
        setPendingAttachments((current) => [...current, attachment]);
      }
    } catch (error) {
      notify(cloudErrorMessage(error), 'error');
    } finally {
      setUploadingAttachment(false);
    }
  };

  const attachExistingPdf = async () => {
    if (!uid || !existingFileId) return;
    const file = activeFiles.find((entry) => entry.id === existingFileId);
    if (!file) return;
    setUploadingAttachment(true);
    try {
      const blob = (await repo.readBlob(file.id)) ?? (await cloud.resolveBlob(file));
      const attachment = await uploadGeminiAttachment(uid, selectedDate, blob, file.name);
      setPendingAttachments((current) => [...current, attachment]);
      setExistingFileId('');
      setShowExistingPicker(false);
    } catch (error) {
      notify(cloudErrorMessage(error), 'error');
    } finally {
      setUploadingAttachment(false);
    }
  };

  const stop = () => {
    abortRef.current?.abort();
    abortRef.current = null;
  };

  const send = async (override?: string) => {
    if (!uid || sending) return;
    const text = (override ?? input).trim();
    if (!text && pendingAttachments.length === 0) return;
    if (text.length > MAX_INPUT_LENGTH) {
      notify(`入力は${MAX_INPUT_LENGTH.toLocaleString('ja-JP')}文字以内にしてください。`, 'error');
      return;
    }

    const fingerprint = `${selectedDate}:${text}:${pendingAttachments.map((item) => item.id).join(',')}`;
    if (fingerprint === sendFingerprint.current) return;
    sendFingerprint.current = fingerprint;
    window.setTimeout(() => {
      if (sendFingerprint.current === fingerprint) sendFingerprint.current = '';
    }, 2500);

    const attachments = [...pendingAttachments];
    setInput('');
    setPendingAttachments([]);
    setSending(true);
    setStreamText('');
    setLastFailedInput(null);
    const controller = new AbortController();
    abortRef.current = controller;

    try {
      const userMessage = await saveGeminiMessage(uid, selectedDate, {
        role: 'user',
        text,
        attachments,
      });
      const history = [...messages, userMessage]
        .filter((message) => message.status !== 'streaming')
        .slice(-50)
        .map((message) => ({
          role: message.role,
          text: message.text,
          attachments: message.attachments,
        }));
      const token = await cloudIdToken();
      const response = await fetch('/api/gemini/chat', {
        method: 'POST',
        headers: {
          authorization: `Bearer ${token}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ messages: history, preferences }),
        signal: controller.signal,
      });
      if (!response.ok || !response.body) {
        const data = (await response.json().catch(() => null)) as { error?: string } | null;
        throw new Error(data?.error || 'Geminiから回答を取得できませんでした。');
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let answer = '';
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        answer += decoder.decode(value, { stream: true });
        setStreamText(answer);
      }
      answer += decoder.decode();
      if (answer.trim()) {
        await saveGeminiMessage(uid, selectedDate, {
          role: 'model',
          text: answer.trim(),
          attachments: [],
        });
      }
      setStreamText('');
    } catch (error) {
      if ((error as Error)?.name === 'AbortError') {
        if (streamText.trim()) {
          await saveGeminiMessage(uid, selectedDate, {
            role: 'model',
            text: `${streamText.trim()}\n\n> 回答はユーザーによって停止されました。`,
            attachments: [],
          }).catch(() => undefined);
        }
      } else {
        setLastFailedInput(text);
        notify(error instanceof Error ? error.message : 'Geminiへの送信に失敗しました。', 'error');
      }
    } finally {
      abortRef.current = null;
      setSending(false);
      setStreamText('');
    }
  };

  const reset = async () => {
    if (!uid || !window.confirm(`${dateLabel(selectedDate)}のチャットを削除して新しく始めますか？`)) return;
    stop();
    try {
      await resetGeminiChat(uid, selectedDate);
      setMessages([]);
      notify('この日のチャットを新しくしました。', 'success');
    } catch (error) {
      notify(cloudErrorMessage(error), 'error');
    }
  };

  const saveTitle = async () => {
    if (!uid) return;
    try {
      await updateGeminiChatTitle(uid, selectedDate, chatTitle);
      setEditingTitle(false);
    } catch (error) {
      notify(cloudErrorMessage(error), 'error');
    }
  };

  if (!open) {
    if (!showLauncher) return null;
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        aria-label="Geminiを開く"
        className="fixed right-4 z-40 flex h-14 w-14 items-center justify-center rounded-full bg-[#4c65a8] text-white shadow-fab active:scale-95"
        style={{ bottom: 'calc(var(--bottom-nav-height) + var(--safe-bottom) + 18px)' }}
      >
        <Sparkles size={25} />
      </button>
    );
  }

  if (!cloud.enabled || !cloud.user) {
    return (
      <div className="fixed inset-0 z-[100] overflow-hidden bg-white dark:bg-[#11161c]">
        <GeminiBackdrop />
        <div className="relative z-10 mx-auto flex min-h-full max-w-3xl flex-col">
          <div className="flex min-h-[58px] items-center border-b border-white/60 bg-white/80 px-3 shadow-sm backdrop-blur-xl dark:border-[#2a323d] dark:bg-[#181e26]/95">
            <IconButton label="閉じる" onClick={() => setOpen(false)}>
              <X size={22} />
            </IconButton>
            <h1 className="flex-1 text-center text-lg font-semibold">Gemini</h1>
            <span className="h-tap w-tap" />
          </div>
          <div className="flex flex-1 flex-col items-center justify-center px-8 text-center">
            <div className="mb-5 flex h-20 w-20 items-center justify-center rounded-[28px] border border-white/70 bg-white/70 shadow-lg shadow-blue-200/25 backdrop-blur-xl dark:border-[#2a323d] dark:bg-[#181e26]">
              <Sparkles size={46} className="text-[#596fb0]" />
            </div>
            <h2 className="text-xl font-semibold">クラウドへのログインが必要です</h2>
            <p className="mt-3 max-w-sm text-sm leading-relaxed text-ink-sub">
              日付別チャットと自動PDF設定を安全に保存するため、設定からFirebaseクラウド保管を有効にしてログインしてください。
            </p>
            <Button
              variant="primary"
              className="mt-6"
              onClick={() => {
                setOpen(false);
                navigate({ view: 'settings' });
              }}
            >
              設定を開く
            </Button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="fixed inset-0 z-[100] overflow-hidden bg-white dark:bg-[#11161c]">
      <GeminiBackdrop />
      <div className="relative z-10 mx-auto flex h-full max-w-3xl flex-col">
        <header className="shrink-0 border-b border-white/60 bg-white/80 px-3 pb-2 pt-[max(8px,var(--safe-top))] shadow-sm backdrop-blur-xl dark:border-[#2a323d] dark:bg-[#181e26]/95">
          <div className="flex min-h-[48px] items-center gap-1">
            <IconButton label="閉じる" onClick={() => setOpen(false)}>
              <X size={22} />
            </IconButton>
            <div className="min-w-0 flex-1 px-1">
              {editingTitle ? (
                <div className="flex gap-2">
                  <input
                    autoFocus
                    className="min-w-0 flex-1 rounded-lg border border-white/70 bg-white/60 px-2 py-1 text-base font-semibold outline-none backdrop-blur dark:border-[#39424e] dark:bg-transparent"
                    value={chatTitle}
                    maxLength={80}
                    onChange={(event) => setChatTitle(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter') void saveTitle();
                    }}
                  />
                  <Button className="min-h-9 px-3 text-sm" onClick={() => void saveTitle()}>
                    保存
                  </Button>
                </div>
              ) : (
                <button type="button" className="max-w-full text-left" onClick={() => setEditingTitle(true)}>
                  <h1 className="truncate text-lg font-semibold">{selectedChat?.title ?? 'Gemini'}</h1>
                  <p className="truncate text-xs text-ink-sub">{dateLabel(selectedDate)}・チャットは5日間保存</p>
                </button>
              )}
            </div>
            <IconButton label="日付を選択" onClick={() => setShowDatePicker((value) => !value)}>
              <CalendarDays size={21} />
            </IconButton>
            <IconButton label="PDF作成" onClick={() => setShowPdf(true)} disabled={messages.length === 0}>
              <FilePlus2 size={21} />
            </IconButton>
            <IconButton label="Gemini設定" onClick={() => setShowSettings(true)}>
              <Settings size={21} />
            </IconButton>
          </div>

          {showDatePicker ? (
            <div className="grid grid-cols-5 gap-1 pt-2">
              {availableDates.map((date) => (
                <button
                  key={date}
                  type="button"
                  onClick={() => {
                    setSelectedDate(date);
                    setShowDatePicker(false);
                  }}
                  className={cx(
                    'rounded-xl border px-1 py-2 text-center text-xs shadow-sm backdrop-blur',
                    date === selectedDate
                      ? 'border-[#4c65a8] bg-[#4c65a8] text-white'
                      : 'border-white/70 bg-white/65 text-ink-sub dark:border-[#39424e] dark:bg-[#252d37]',
                  )}
                >
                  <span className="block font-semibold">{date.slice(5).replace('-', '/')}</span>
                  <span>{chats.some((chat) => chat.date === date) ? '履歴あり' : '新規'}</span>
                </button>
              ))}
            </div>
          ) : null}
        </header>

        <main className="min-h-0 flex-1 overflow-y-auto px-3 py-4">
          {messages.length === 0 && !sending ? (
            <div className="flex min-h-full flex-col items-center justify-center px-5 pb-24 text-center">
              <div className="mb-5 flex h-16 w-16 items-center justify-center rounded-3xl border border-white/70 bg-white/65 shadow-lg shadow-blue-200/20 backdrop-blur-xl dark:border-[#2a323d] dark:bg-[#181e26]">
                <Sparkles size={38} className="text-[#596fb0]" />
              </div>
              <h2 className="text-lg font-semibold">{dateLabel(selectedDate)}のチャット</h2>
              <p className="mt-2 max-w-sm text-sm leading-relaxed text-ink-sub">
                学習中の疑問や業務の確認を送ってください。この日の会話だけを使って、高品質な復習PDFを作成できます。
              </p>
            </div>
          ) : (
            <div className="space-y-4 pb-4">
              {messages.map((message) => (
                <div
                  key={message.id}
                  className={cx(
                    'max-w-[92%] rounded-2xl px-4 py-3 shadow-sm',
                    message.role === 'user'
                      ? 'ml-auto bg-[#4c65a8] text-white shadow-blue-900/10'
                      : 'mr-auto border border-white/70 bg-white/90 shadow-[0_10px_30px_rgba(76,101,168,0.08)] backdrop-blur-md dark:border-[#2a323d] dark:bg-[#181e26]',
                  )}
                >
                  {message.attachments.length > 0 ? (
                    <div className="mb-2 flex flex-wrap gap-1.5">
                      {message.attachments.map((attachment) => (
                        <span key={attachment.id} className={cx('inline-flex max-w-full items-center gap-1 rounded-lg px-2 py-1 text-xs', message.role === 'user' ? 'bg-white/15' : 'bg-white/65 dark:bg-[#252d37]')}>
                          {attachmentIcon(attachment.mimeType)}
                          <span className="truncate">{attachment.name}</span>
                        </span>
                      ))}
                    </div>
                  ) : null}
                  {message.role === 'model' ? (
                    <MarkdownContent markdown={message.text} />
                  ) : (
                    <p className="whitespace-pre-wrap text-[15px] leading-relaxed">{message.text}</p>
                  )}
                  <p className={cx('mt-2 text-[10px]', message.role === 'user' ? 'text-white/65' : 'text-ink-faint')}>
                    {new Date(message.createdAt).toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit' })}
                  </p>
                </div>
              ))}
              {sending ? (
                <div className="mr-auto max-w-[92%] rounded-2xl border border-white/70 bg-white/90 px-4 py-3 shadow-[0_10px_30px_rgba(76,101,168,0.08)] backdrop-blur-md dark:border-[#2a323d] dark:bg-[#181e26]">
                  {streamText ? <MarkdownContent markdown={streamText} /> : <div className="flex items-center gap-2 text-sm text-ink-sub"><Spinner /> 回答を作成しています…</div>}
                </div>
              ) : null}
              {lastFailedInput ? (
                <button type="button" className="mx-auto flex min-h-tap items-center gap-2 rounded-xl border border-white/70 bg-white/80 px-4 text-sm shadow-sm backdrop-blur dark:border-[#2a323d] dark:bg-[#181e26]" onClick={() => void send(lastFailedInput)}>
                  <RotateCcw size={17} /> 直前の質問を再送信
                </button>
              ) : null}
              <div ref={bottomRef} />
            </div>
          )}
        </main>

        <footer className="shrink-0 border-t border-white/60 bg-white/75 px-3 pb-[max(10px,var(--safe-bottom))] pt-2 shadow-[0_-8px_30px_rgba(76,101,168,0.05)] backdrop-blur-xl dark:border-[#2a323d] dark:bg-[#181e26]/95">
          {pendingAttachments.length > 0 ? (
            <div className="mb-2 flex max-h-24 flex-wrap gap-1.5 overflow-y-auto">
              {pendingAttachments.map((attachment) => (
                <span key={attachment.id} className="inline-flex max-w-[220px] items-center gap-1 rounded-lg border border-white/70 bg-white/70 px-2 py-1 text-xs backdrop-blur dark:border-[#39424e] dark:bg-[#252d37]">
                  {attachmentIcon(attachment.mimeType)}
                  <span className="truncate">{attachment.name}</span>
                  <button type="button" aria-label="添付を削除" onClick={() => removePendingAttachment(attachment)}>
                    <X size={14} />
                  </button>
                </span>
              ))}
            </div>
          ) : null}

          {showExistingPicker ? (
            <div className="mb-2 flex gap-2 rounded-xl border border-white/70 bg-white/65 p-2 shadow-sm backdrop-blur-md dark:border-[#39424e] dark:bg-[#252d37]">
              <select className="min-w-0 flex-1 rounded-lg border border-white/70 bg-white/85 px-2 text-sm dark:border-[#39424e] dark:bg-[#181e26]" value={existingFileId} onChange={(event) => setExistingFileId(event.target.value)}>
                <option value="">アプリ内PDFを選択</option>
                {activeFiles.map((file) => <option key={file.id} value={file.id}>{file.name}</option>)}
              </select>
              <Button className="min-h-10 px-3 text-sm" onClick={() => void attachExistingPdf()} disabled={!existingFileId || uploadingAttachment}>添付</Button>
            </div>
          ) : null}

          <div className="flex items-end gap-2">
            <div className="flex shrink-0">
              <IconButton label="PDFを添付" onClick={() => attachmentInput.current?.click()} disabled={uploadingAttachment || sending}>
                <Paperclip size={20} />
              </IconButton>
              <IconButton label="画像を添付" onClick={() => imageInput.current?.click()} disabled={uploadingAttachment || sending}>
                <ImagePlus size={20} />
              </IconButton>
              <IconButton label="アプリ内PDFを添付" onClick={() => setShowExistingPicker((value) => !value)} disabled={uploadingAttachment || sending}>
                <FileText size={20} />
              </IconButton>
            </div>
            <textarea
              value={input}
              onChange={(event) => setInput(event.target.value.slice(0, MAX_INPUT_LENGTH))}
              onKeyDown={(event) => {
                if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
                  event.preventDefault();
                  void send();
                }
              }}
              placeholder="Geminiに質問する"
              rows={1}
              disabled={sending}
              className="max-h-32 min-h-tap min-w-0 flex-1 resize-none rounded-2xl border border-white/80 bg-white/90 px-3 py-2.5 text-base shadow-sm outline-none backdrop-blur-xl focus:border-brand-400 dark:border-[#39424e] dark:bg-[#11161c]"
            />
            {sending ? (
              <button type="button" aria-label="回答を停止" onClick={stop} className="flex h-tap w-tap shrink-0 items-center justify-center rounded-full bg-[#313d48] text-white">
                <Square size={17} fill="currentColor" />
              </button>
            ) : (
              <button type="button" aria-label="送信" onClick={() => void send()} disabled={(!input.trim() && pendingAttachments.length === 0) || uploadingAttachment} className="flex h-tap w-tap shrink-0 items-center justify-center rounded-full bg-[#4c65a8] text-white shadow-sm disabled:opacity-40">
                {uploadingAttachment ? <Spinner className="border-white/30 border-t-white" /> : <Send size={19} />}
              </button>
            )}
          </div>
          <div className="mt-1 flex items-center justify-between px-1 text-[10px] text-ink-faint">
            <button type="button" className="flex items-center gap-1" onClick={() => void reset()} disabled={sending}>
              <Trash2 size={12} /> 新しいチャット
            </button>
            <span>{input.length.toLocaleString('ja-JP')} / {MAX_INPUT_LENGTH.toLocaleString('ja-JP')}</span>
          </div>
        </footer>

        <input ref={attachmentInput} type="file" accept="application/pdf,.pdf" multiple className="hidden" onChange={(event) => { void addAttachments(event.target.files); event.target.value = ''; }} />
        <input ref={imageInput} type="file" accept="image/jpeg,image/png,image/webp" multiple className="hidden" onChange={(event) => { void addAttachments(event.target.files); event.target.value = ''; }} />

        {showSettings && uid ? (
          <GeminiSettingsPanel uid={uid} folders={folders} preferences={preferences} onPreferencesChange={setPreferences} onClose={() => setShowSettings(false)} notify={notify} />
        ) : null}
        {showPdf ? (
          <GeminiPdfComposer chatDate={selectedDate} messages={messages} preferences={preferences} folders={folders} onClose={() => setShowPdf(false)} />
        ) : null}
      </div>
    </div>
  );
}
