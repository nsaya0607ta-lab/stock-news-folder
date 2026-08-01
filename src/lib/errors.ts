/** ユーザーに日本語で提示するためのアプリ内エラー。 */
export class AppError extends Error {
  readonly code: AppErrorCode;
  readonly detail?: string;

  constructor(code: AppErrorCode, detail?: string) {
    super(ERROR_MESSAGES[code]);
    this.name = 'AppError';
    this.code = code;
    this.detail = detail;
  }
}

export type AppErrorCode =
  | 'NOT_PDF'
  | 'QUOTA_EXCEEDED'
  | 'PDF_READ_FAILED'
  | 'SHARE_FAILED'
  | 'DUPLICATE_NAME'
  | 'EMPTY_FOLDER_NAME'
  | 'EMPTY_FILE_NAME'
  | 'DELETE_FAILED'
  | 'INDEXEDDB_UNAVAILABLE'
  | 'NOT_FOUND'
  | 'INVALID_MOVE'
  | 'BACKUP_FAILED'
  | 'RESTORE_FAILED'
  | 'IMAGE_CONVERT_FAILED'
  | 'IMAGE_PDF_TOO_MANY'
  | 'IMAGE_PDF_CANCELLED'
  | 'IMAGE_PDF_IN_PROGRESS'
  | 'IMAGE_PDF_ENCRYPT_FAILED'
  | 'PRINT_FAILED'
  | 'PDF_EDIT_EMPTY'
  | 'PDF_EDIT_TOO_LARGE'
  | 'PDF_EDIT_FAILED'
  | 'PDF_EDIT_VERIFY_FAILED'
  | 'PDF_EDIT_IN_PROGRESS'
  | 'CLOUD_OFFLINE'
  | 'CLOUD_SIGNED_OUT'
  | 'CLOUD_UPLOAD_FAILED'
  | 'CLOUD_DOWNLOAD_FAILED'
  | 'CLOUD_VERIFY_FAILED'
  | 'CLOUD_NOT_FOUND'
  | 'CLOUD_QUOTA_EXCEEDED'
  | 'CLOUD_DISABLED'
  | 'UNKNOWN';

export const ERROR_MESSAGES: Record<AppErrorCode, string> = {
  NOT_PDF: 'PDF以外のファイルは追加できません。拡張子が .pdf のファイルを選択してください。',
  QUOTA_EXCEEDED:
    '端末の保存容量が不足しているため保存できませんでした。不要なPDFを削除するか、ごみ箱を空にしてください。',
  PDF_READ_FAILED: 'PDFの読み込みに失敗しました。ファイルが壊れている可能性があります。',
  SHARE_FAILED: 'PDFの共有に失敗しました。時間をおいて、もう一度お試しください。',
  DUPLICATE_NAME: '同じ名前のファイルがすでに存在します。',
  EMPTY_FOLDER_NAME: 'フォルダー名を入力してください。',
  EMPTY_FILE_NAME: 'ファイル名を入力してください。',
  DELETE_FAILED: '削除に失敗しました。もう一度お試しください。',
  INDEXEDDB_UNAVAILABLE:
    'この環境ではデータを保存できません（IndexedDBが利用できません）。プライベートブラウズを解除するか、別のブラウザーでお試しください。',
  NOT_FOUND: '対象が見つかりませんでした。すでに削除された可能性があります。',
  INVALID_MOVE: 'そのフォルダーへは移動できません。自分自身や配下のフォルダーは指定できません。',
  BACKUP_FAILED: 'バックアップの作成に失敗しました。',
  RESTORE_FAILED: 'バックアップファイルを読み込めませんでした。ファイルを確認してください。',
  IMAGE_CONVERT_FAILED: '画像からPDFを作成できませんでした。対応していない画像形式の可能性があります。',
  IMAGE_PDF_TOO_MANY:
    '一度に作成できる画像の枚数を超えています。枚数を減らして分けて作成してください。',
  IMAGE_PDF_CANCELLED: '',
  IMAGE_PDF_IN_PROGRESS: 'PDFを作成しています。完了までお待ちください。',
  IMAGE_PDF_ENCRYPT_FAILED:
    'パスワードの設定に失敗しました。パスワードなしで作成し直すか、もう一度お試しください。',
  PRINT_FAILED: '印刷画面を開けませんでした。ポップアップがブロックされていないか確認してください。',
  PDF_EDIT_EMPTY: 'ページがすべて削除されています。1ページ以上残してください。',
  PDF_EDIT_TOO_LARGE:
    'ページ数が多すぎるため、この端末では処理できません。PDFを分割してから編集してください。',
  PDF_EDIT_FAILED:
    '編集内容を保存できませんでした。元のPDFはそのまま残しています。編集内容は下書きとして保持しています。',
  PDF_EDIT_VERIFY_FAILED:
    '編集後のPDFを確認できなかったため、保存を中止しました。元のPDFはそのまま残しています。',
  PDF_EDIT_IN_PROGRESS: '保存の処理中です。完了までお待ちください。',
  CLOUD_OFFLINE:
    'このPDFはクラウドに保存されています。インターネットへ接続してから、もう一度開いてください。',
  CLOUD_SIGNED_OUT:
    'クラウド保管のログイン期限が切れました。設定画面からもう一度ログインしてください。',
  CLOUD_UPLOAD_FAILED:
    'クラウドへの保存に失敗しました。PDFは端末内にそのまま残しています。時間をおいて再試行します。',
  CLOUD_DOWNLOAD_FAILED:
    'クラウドからPDFを取得できませんでした。通信状況を確認して、もう一度お試しください。',
  CLOUD_VERIFY_FAILED:
    'クラウド上のPDFの内容を確認できませんでした。安全のため端末内のPDFはそのまま残しています。',
  CLOUD_NOT_FOUND:
    'クラウド上にPDFが見つかりませんでした。設定画面の「今すぐ対象ファイルをクラウドへ移動」で状態を確認してください。',
  CLOUD_QUOTA_EXCEEDED:
    'クラウドの保存容量が不足しています。不要なPDFを完全に削除するか、プランを確認してください。',
  CLOUD_DISABLED: 'クラウド保管が無効です。設定画面から有効にしてください。',
  UNKNOWN: '処理に失敗しました。もう一度お試しください。',
};

/** 任意の例外をユーザー向けメッセージに変換する。 */
export function toMessage(error: unknown): string {
  if (error instanceof AppError) return error.message;
  if (error instanceof DOMException) {
    if (error.name === 'QuotaExceededError') return ERROR_MESSAGES.QUOTA_EXCEEDED;
    if (error.name === 'AbortError') return '';
    if (error.name === 'NotAllowedError') return ERROR_MESSAGES.SHARE_FAILED;
  }
  if (error instanceof Error && error.message) return error.message;
  return ERROR_MESSAGES.UNKNOWN;
}
