export const GEMINI_CHAT_RETENTION_DAYS = 5;
export const GEMINI_TIME_ZONE = 'Asia/Tokyo';

export type GeminiRole = 'user' | 'model';

export type GeminiAttachment = {
  id: string;
  name: string;
  mimeType: 'application/pdf' | 'image/jpeg' | 'image/png' | 'image/webp';
  size: number;
  storagePath: string;
  downloadUrl?: string;
};

export type GeminiMessage = {
  id: string;
  role: GeminiRole;
  text: string;
  createdAt: string;
  expiresAt: string;
  attachments: GeminiAttachment[];
  status?: 'complete' | 'streaming' | 'error';
};

export type GeminiChat = {
  date: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  expiresAt: string;
  messageCount: number;
};

export type GeminiPurpose = 'learning' | 'work' | 'general';
export type GeminiDetail = 'concise' | 'standard' | 'detailed';

export type GeminiPreferences = {
  purpose: GeminiPurpose;
  detail: GeminiDetail;
  responsePolicy: string;
  emphasizeImportant: boolean;
  includeCommandExamples: boolean;
  preferTables: boolean;
  beginnerFriendly: boolean;
  includeExamTips: boolean;
};

export const DEFAULT_GEMINI_PREFERENCES: GeminiPreferences = {
  purpose: 'learning',
  detail: 'detailed',
  responsePolicy:
    'ユーザーがどこで迷ったか、何を勘違いしたか、結論は何かを明確に整理してください。確認していない関連知識は勝手に広げすぎないでください。',
  emphasizeImportant: true,
  includeCommandExamples: true,
  preferTables: true,
  beginnerFriendly: true,
  includeExamTips: true,
};

export type PdfDuplicateMode = 'overwrite' | 'skip' | 'rename' | 'replaceSameDate';
export type PdfChatTarget = 'sameDay' | 'previousDay';

export type PdfGenerationRule = {
  id: string;
  name: string;
  enabled: boolean;
  time: string;
  timeZone: string;
  chatTarget: PdfChatTarget;
  folderId: string;
  folderPath: string;
  fileNameTemplate: string;
  titleTemplate: string;
  purpose: string;
  instructions: string;
  keepChat: boolean;
  notifyOnSuccess: boolean;
  duplicateMode: PdfDuplicateMode;
  createdAt: string;
  updatedAt: string;
  lastRunAt?: string;
  lastRunDate?: string;
  lastRunStatus?: 'success' | 'failed' | 'skipped' | 'running';
  lastError?: string;
};

export type PdfGenerationRun = {
  id: string;
  ruleId: string;
  ruleName: string;
  chatDate: string;
  status: 'queued' | 'running' | 'success' | 'failed' | 'skipped';
  fileName?: string;
  folderId?: string;
  objectPath?: string;
  error?: string;
  attempt: number;
  createdAt: string;
  updatedAt: string;
};

export type GeneratedGeminiPdf = {
  id: string;
  runId: string;
  ruleId?: string;
  ruleName?: string;
  chatDate: string;
  fileName: string;
  title: string;
  folderId: string;
  folderPath?: string;
  duplicateMode: PdfDuplicateMode;
  objectPath: string;
  size: number;
  tags: string[];
  status: 'ready' | 'imported' | 'error';
  createdAt: string;
  importedAt?: string;
  cleanupAt?: string;
};

export type PdfOutlineRequest = {
  chatDate: string;
  title: string;
  documentType: string;
  additionalInstructions: string;
  messages: Pick<GeminiMessage, 'role' | 'text'>[];
  preferences: GeminiPreferences;
};

export type PdfOutlineResponse = {
  title: string;
  markdown: string;
  suggestedTags: string[];
};

export function jstDateKey(value = new Date()): string {
  return new Intl.DateTimeFormat('sv-SE', {
    timeZone: GEMINI_TIME_ZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(value);
}

export function addDays(dateKey: string, days: number): string {
  const date = new Date(`${dateKey}T12:00:00+09:00`);
  date.setUTCDate(date.getUTCDate() + days);
  return jstDateKey(date);
}

export function expiryIso(dateKey: string): string {
  return new Date(`${addDays(dateKey, GEMINI_CHAT_RETENTION_DAYS)}T00:00:00+09:00`).toISOString();
}

export function applyDateVariables(
  template: string,
  dateKey: string,
  values: { chatTitle?: string; ruleName?: string } = {},
): string {
  const [yyyy, mm, dd] = dateKey.split('-');
  const weekday = new Intl.DateTimeFormat('ja-JP', {
    timeZone: GEMINI_TIME_ZONE,
    weekday: 'short',
  }).format(new Date(`${dateKey}T12:00:00+09:00`));
  const replacements: Record<string, string> = {
    'yyyy-mm-dd': dateKey,
    yyyymmdd: `${yyyy}${mm}${dd}`,
    yyyy,
    mm,
    dd,
    weekday,
    chat_title: values.chatTitle ?? '',
    rule_name: values.ruleName ?? '',
  };

  return Object.entries(replacements).reduce(
    (result, [key, replacement]) => result.replaceAll(key, replacement),
    template,
  );
}
