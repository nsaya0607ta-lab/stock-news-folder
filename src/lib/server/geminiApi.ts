import type {
  GeminiAttachment,
  GeminiMessage,
  GeminiPreferences,
  PdfOutlineRequest,
  PdfOutlineResponse,
} from '@/lib/geminiTypes';

const GEMINI_ENDPOINT = 'https://generativelanguage.googleapis.com/v1beta/models';
const MAX_HISTORY_MESSAGES = 50;
const MAX_TOTAL_TEXT = 120_000;
const MAX_ATTACHMENTS = 6;
const MAX_ATTACHMENT_BYTES = 15 * 1024 * 1024;

const rateWindows = new Map<string, number[]>();

export function enforceGeminiRateLimit(uid: string, limit = 12, windowMs = 60_000): void {
  const now = Date.now();
  const recent = (rateWindows.get(uid) ?? []).filter((value) => now - value < windowMs);
  if (recent.length >= limit) throw new Error('RATE_LIMITED');
  recent.push(now);
  rateWindows.set(uid, recent);
}

export function geminiErrorResponse(error: unknown): Response | null {
  if (!(error instanceof Error)) return null;
  if (error.message === 'RATE_LIMITED') {
    return Response.json(
      { error: '短時間の送信回数が多いため、1分ほど待ってから再送信してください。' },
      { status: 429 },
    );
  }
  if (error.message === 'GEMINI_NOT_CONFIGURED') {
    return Response.json(
      { error: 'Gemini APIキーがVercelに設定されていません。' },
      { status: 503 },
    );
  }
  return null;
}

function modelName(): string {
  return (process.env.GEMINI_MODEL || 'gemini-3.5-flash').replace(/^models\//, '');
}

function apiKey(): string {
  const value = process.env.GEMINI_API_KEY;
  if (!value) throw new Error('GEMINI_NOT_CONFIGURED');
  return value;
}

function systemInstruction(preferences: GeminiPreferences): string {
  const purpose =
    preferences.purpose === 'work'
      ? '業務の再現性を重視した実務アシスタント'
      : preferences.purpose === 'general'
        ? '正確で分かりやすいアシスタント'
        : '復習と資格学習を支援する学習アシスタント';
  const detail =
    preferences.detail === 'concise'
      ? '結論を先に、必要最小限で回答する'
      : preferences.detail === 'detailed'
        ? '前提から丁寧に説明し、具体例まで示す'
        : '結論と根拠をバランス良く説明する';

  return [
    `あなたは${purpose}です。`,
    detail,
    preferences.responsePolicy,
    preferences.emphasizeImportant ? '重要語句と結論を明確に強調してください。' : '',
    preferences.includeCommandExamples
      ? 'Linuxやコマンドの質問では、基本構文、使用例、結果例、よくある間違いを必要に応じて示してください。'
      : '',
    preferences.preferTables ? '比較が有効な場合はMarkdown表を使ってください。' : '',
    preferences.beginnerFriendly ? '専門用語は初学者にも理解できる一言説明を添えてください。' : '',
    preferences.includeExamTips ? '資格学習では試験で問われやすい点と覚え方を明記してください。' : '',
    'ユーザーが質問した点、勘違いしていた点、詰まった点を区別して整理してください。',
    '確認していない関連知識を無断で広げすぎず、補足する場合は「補足」と明記してください。',
    '内部の推論過程は開示せず、結論と説明だけを提示してください。',
    '回答は日本語で、Markdownを使用してください。',
  ]
    .filter(Boolean)
    .join('\n');
}

function validateMessages(messages: Pick<GeminiMessage, 'role' | 'text' | 'attachments'>[]): void {
  if (!Array.isArray(messages) || messages.length === 0 || messages.length > MAX_HISTORY_MESSAGES) {
    throw new Error('INVALID_MESSAGES');
  }
  const textSize = messages.reduce((sum, item) => sum + String(item.text ?? '').length, 0);
  if (textSize <= 0 || textSize > MAX_TOTAL_TEXT) throw new Error('INVALID_MESSAGES');
  const attachments = messages.flatMap((item) => item.attachments ?? []);
  if (attachments.length > MAX_ATTACHMENTS) throw new Error('INVALID_ATTACHMENTS');
}

function storageUrlBelongsToUser(value: string, uid: string): boolean {
  try {
    const url = new URL(value);
    if (!['firebasestorage.googleapis.com', 'storage.googleapis.com'].includes(url.hostname)) return false;
    const decoded = decodeURIComponent(url.pathname);
    return decoded.includes(`/users/${uid}/gemini-temp/`);
  } catch {
    return false;
  }
}

async function attachmentPart(attachment: GeminiAttachment, uid: string) {
  if (!attachment.downloadUrl || !storageUrlBelongsToUser(attachment.downloadUrl, uid)) {
    throw new Error('INVALID_ATTACHMENT_URL');
  }
  const response = await fetch(attachment.downloadUrl, { cache: 'no-store' });
  if (!response.ok) throw new Error('ATTACHMENT_FETCH_FAILED');
  const declared = Number(response.headers.get('content-length') ?? attachment.size ?? 0);
  if (declared > MAX_ATTACHMENT_BYTES) throw new Error('ATTACHMENT_TOO_LARGE');
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.length <= 0 || bytes.length > MAX_ATTACHMENT_BYTES) throw new Error('ATTACHMENT_TOO_LARGE');
  return {
    inlineData: {
      mimeType: attachment.mimeType,
      data: bytes.toString('base64'),
    },
  };
}

export async function buildGeminiContents(
  messages: Pick<GeminiMessage, 'role' | 'text' | 'attachments'>[],
  uid: string,
) {
  validateMessages(messages);
  const selected = messages.slice(-MAX_HISTORY_MESSAGES);
  const contents = [];

  for (const message of selected) {
    const parts: Array<Record<string, unknown>> = [];
    if (message.text.trim()) parts.push({ text: message.text.trim() });
    for (const attachment of message.attachments ?? []) {
      parts.push(await attachmentPart(attachment, uid));
    }
    if (parts.length === 0) continue;
    contents.push({ role: message.role === 'model' ? 'model' : 'user', parts });
  }
  if (contents.length === 0) throw new Error('INVALID_MESSAGES');
  return contents;
}

export async function openGeminiStream(options: {
  uid: string;
  messages: Pick<GeminiMessage, 'role' | 'text' | 'attachments'>[];
  preferences: GeminiPreferences;
  signal?: AbortSignal;
}): Promise<Response> {
  const contents = await buildGeminiContents(options.messages, options.uid);
  const response = await fetch(
    `${GEMINI_ENDPOINT}/${encodeURIComponent(modelName())}:streamGenerateContent?alt=sse`,
    {
      method: 'POST',
      headers: {
        'x-goog-api-key': apiKey(),
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: systemInstruction(options.preferences) }] },
        contents,
        generationConfig: {
          temperature: 0.35,
          topP: 0.9,
          maxOutputTokens: 8192,
        },
      }),
      signal: options.signal,
      cache: 'no-store',
    },
  );
  if (!response.ok || !response.body) {
    const detail = await response.text().catch(() => '');
    throw new Error(`GEMINI_${response.status}:${detail.slice(0, 500)}`);
  }
  return response;
}

function extractText(data: unknown): string {
  if (!data || typeof data !== 'object') return '';
  const candidates = (data as { candidates?: unknown[] }).candidates;
  if (!Array.isArray(candidates)) return '';
  return candidates
    .flatMap((candidate) => {
      const parts = (candidate as { content?: { parts?: unknown[] } })?.content?.parts;
      return Array.isArray(parts) ? parts : [];
    })
    .map((part) => String((part as { text?: unknown }).text ?? ''))
    .join('');
}

export function transformGeminiSse(source: ReadableStream<Uint8Array>): ReadableStream<Uint8Array> {
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  let buffer = '';

  return new ReadableStream<Uint8Array>({
    start(controller) {
      const reader = source.getReader();
      const pump = async (): Promise<void> => {
        const { done, value } = await reader.read();
        if (done) {
          if (buffer.trim()) {
            const line = buffer.trim();
            if (line.startsWith('data:')) {
              try {
                const text = extractText(JSON.parse(line.slice(5).trim()));
                if (text) controller.enqueue(encoder.encode(text));
              } catch {
                // 不完全な最終行は捨てる。
              }
            }
          }
          controller.close();
          return;
        }

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split(/\r?\n/);
        buffer = lines.pop() ?? '';
        for (const raw of lines) {
          const line = raw.trim();
          if (!line.startsWith('data:')) continue;
          const payload = line.slice(5).trim();
          if (!payload || payload === '[DONE]') continue;
          try {
            const text = extractText(JSON.parse(payload));
            if (text) controller.enqueue(encoder.encode(text));
          } catch {
            // Geminiの補助イベントは無視する。
          }
        }
        await pump();
      };
      void pump().catch((error) => controller.error(error));
    },
  });
}

function pdfPrompt(request: PdfOutlineRequest): string {
  const conversation = request.messages
    .map((message) => `${message.role === 'user' ? 'ユーザー' : 'Gemini'}:\n${message.text}`)
    .join('\n\n');
  return `次の会話だけを根拠に、後日復習したくなる高品質な資料をMarkdownで作成してください。

対象日: ${request.chatDate}
資料タイトル: ${request.title}
資料タイプ: ${request.documentType}
追加指示: ${request.additionalInstructions || 'なし'}

必須構成:
1. 今日扱った内容の全体像
2. 学習または業務の目的
3. 内容の流れ
4. 重要用語
5. 詳しい解説
6. ユーザーが質問した部分
7. ユーザーが勘違いしていた部分
8. 詰まったポイント
9. 正しい理解
10. 覚え方
11. 注意点
12. 復習問題
13. 最後の確認事項

LinuxやLPICの内容では、コマンドの目的、基本構文、主なオプション、実行例、実行結果例、間違いやすい指定、類似コマンドとの違い、試験ポイント、覚え方、実務例を必要に応じて含めてください。
会話で扱っていない内容を勝手に追加しすぎないでください。関連知識は「補足」と明記してください。
Markdownの見出し、表、箇条書き、コードブロック、太字を適切に使ってください。会話ログの転載ではなく、理解しやすい順番に再構成してください。

会話:
${conversation}`;
}

export async function generatePdfOutline(request: PdfOutlineRequest): Promise<PdfOutlineResponse> {
  if (request.messages.length === 0) throw new Error('NO_MESSAGES');
  const response = await fetch(
    `${GEMINI_ENDPOINT}/${encodeURIComponent(modelName())}:generateContent`,
    {
      method: 'POST',
      headers: {
        'x-goog-api-key': apiKey(),
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: systemInstruction(request.preferences) }] },
        contents: [{ role: 'user', parts: [{ text: pdfPrompt(request) }] }],
        generationConfig: {
          temperature: 0.25,
          topP: 0.85,
          maxOutputTokens: 16384,
        },
      }),
      cache: 'no-store',
    },
  );
  const data = (await response.json()) as unknown;
  if (!response.ok) throw new Error(`GEMINI_${response.status}`);
  const markdown = extractText(data).trim();
  if (!markdown) throw new Error('EMPTY_RESPONSE');

  const tags = new Set<string>(['Gemini生成']);
  if (/LPIC|Linux|rpm|systemd|find\s|grep\s|yum|apt/i.test(markdown)) tags.add('LPIC');
  if (request.documentType.includes('学習')) tags.add('学習まとめ');
  if (request.documentType.includes('業務')) tags.add('業務資料');
  tags.add(request.chatDate);

  return {
    title: request.title,
    markdown,
    suggestedTags: [...tags],
  };
}
