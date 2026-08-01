/**
 * アプリ全体で共有するデータ型。
 * 将来のクラウド同期を見据えて、すべてのレコードに `updatedAt` (ISO 文字列) を持たせ、
 * 差分同期の判定に使えるようにしている。
 */

/** 仮想ルート (「株式ニュースフォルダー」) の ID。 */
export const ROOT_ID = 'root';

/** 初期作成される「未分類」フォルダーの固定 ID。 */
export const UNSORTED_ID = 'folder-unsorted';

export type FolderColor =
  | 'yellow'
  | 'blue'
  | 'green'
  | 'red'
  | 'purple'
  | 'gray';

export type Folder = {
  id: string;
  /** 親フォルダー ID。ルート直下は ROOT_ID。 */
  parentId: string | null;
  name: string;
  color?: FolderColor;
  isFavorite: boolean;
  /** 手動並べ替え用の順序値。 */
  sortOrder?: number;
  createdAt: string;
  updatedAt: string;
  deletedAt?: string;
  /** ごみ箱から復元するときの戻し先。 */
  restoreParentId?: string;
};

/** 重要度。0 = 未設定、1〜3 で高くなる。 */
export type Importance = 0 | 1 | 2 | 3;

/**
 * PDF 本体 (Blob) がどこにあるか。
 *
 * - `local`       … 端末内だけにある (既定。クラウド保管を使わない場合は常にこれ)
 * - `uploading`   … クラウドへ送信中。端末内の Blob はまだ残っている
 * - `cloud`       … クラウドに検証済みのコピーがある
 *                   (`localCachedAt` が入っていれば端末内にもキャッシュがある)
 * - `downloading` … クラウドから取得中
 * - `error`       … 直前の処理に失敗した。端末内の Blob は必ず残っている
 *
 * 端末内 Blob を削除するのは「`cloud` へ確定したあと」だけに限定する。
 */
export type StorageState = 'local' | 'uploading' | 'cloud' | 'downloading' | 'error';

/** 旧データ (storageState を持たない PDF) は `local` として扱う。 */
export function storageStateOf(file: Pick<PdfFileMeta, 'storageState'>): StorageState {
  return file.storageState ?? 'local';
}

/** クラウドにコピーがあるか (端末内キャッシュの有無は問わない)。 */
export function isInCloud(file: Pick<PdfFileMeta, 'storageState' | 'cloudPath'>): boolean {
  return storageStateOf(file) === 'cloud' && Boolean(file.cloudPath);
}

/**
 * PDF の登録元 (どの経路でアプリに入ってきたか)。
 * 自動分類ルールの「登録元」条件で使う。省略時は `unknown` として扱う。
 */
export type PdfOrigin =
  /** ファイルアプリなどから選択して追加 */
  | 'file'
  /** 他アプリの共有メニューから受け取った */
  | 'share'
  /** カメラで撮影して作成 */
  | 'camera'
  /** 端末内の画像から作成 */
  | 'image'
  /** 毎朝の学習レポートの自動取り込み */
  | 'report'
  /** アプリ内の編集 (分割・抽出) で作成 */
  | 'edit'
  | 'unknown';

export const ORIGIN_LABELS: Record<PdfOrigin, string> = {
  file: 'ファイルから追加',
  share: '他アプリからの共有',
  camera: 'カメラ撮影',
  image: '画像から作成',
  report: '毎朝の学習レポート',
  edit: 'PDF編集',
  unknown: '不明',
};

/**
 * PDF のメタデータ。
 * 一覧表示のたびに数十 MB の Blob を読み込まないよう、実体 (Blob) は
 * 別のオブジェクトストアに分離して保存する。
 */
export type PdfFileMeta = {
  id: string;
  parentId: string;
  name: string;
  size: number;
  pageCount?: number;
  mimeType: 'application/pdf';
  tags: string[];
  memo?: string;
  importance?: Importance;
  isFavorite: boolean;
  isRead: boolean;
  sortOrder?: number;
  createdAt: string;
  updatedAt: string;
  lastOpenedAt?: string;
  deletedAt?: string;
  restoreParentId?: string;
  /** サムネイル生成を試みたか (失敗した PDF を毎回再試行しないため)。 */
  thumbState?: 'none' | 'ready' | 'failed';

  /* --- 自動分類の条件に使う出どころ情報 (省略可。既存データは unknown 扱い) --- */
  /** どの経路で追加されたか。 */
  origin?: PdfOrigin;
  /** 共有元アプリ名など (分かる場合だけ)。 */
  sharedFrom?: string;
  /**
   * 元になったファイルの形式 (`pdf` / `jpeg` / `heic` など)。
   * 画像から作った PDF では、使った画像形式をすべて記録する。
   */
  sourceFormats?: string[];
  /** 最後に自動分類したルールの ID (どのルールで移動したかの表示に使う)。 */
  classifiedByRuleId?: string;
  /** 自動分類した日時。 */
  classifiedAt?: string;

  /* --- クラウド保管 (省略時は local 扱い。既存データとの互換性のため任意) --- */
  /** PDF 本体の所在。 */
  storageState?: StorageState;
  /** クラウド上の保存先 (`users/<uid>/pdf-cloud/<fileId>.pdf`)。 */
  cloudPath?: string;
  /** クラウドへの保存が完了し、存在確認まで通った日時。 */
  cloudUploadedAt?: string;
  /** クラウド上の実バイト数 (整合性確認に使う)。 */
  cloudSize?: number;
  /** 直近の失敗理由 (日本語)。成功したら消す。 */
  cloudError?: string;
  /** クラウドから取得した本体を端末へキャッシュした日時。 */
  localCachedAt?: string;
};

/** 仕様どおりの「Blob を含む PDF レコード」。読み書きの境界で組み立てる。 */
export type PdfFile = PdfFileMeta & { blob: Blob };

/* ------------------------------------------------------------------ */
/* PDF ごとのメモ                                                      */
/* ------------------------------------------------------------------ */

/** クラウドへログインしていないときの持ち主 (この端末)。 */
export const LOCAL_OWNER_ID = 'local';

/**
 * PDF に紐付くメモ。
 *
 * 紐付けはファイル名やパスではなく、変更されない `fileId` で行う。
 * そのため PDF を別フォルダーへ移動しても、名前を変更しても、メモは切れない。
 * `pageStart` / `pageEnd` を省略すると「PDF 全体へのメモ」になる。
 */
export type PdfMemo = {
  id: string;
  /** 持ち主。クラウド未ログイン時は LOCAL_OWNER_ID。 */
  userId: string;
  /** 対象 PDF の不変 ID。 */
  fileId: string;
  title?: string;
  content: string;
  /** 対象ページ (1 始まり)。未設定なら PDF 全体へのメモ。 */
  pageStart?: number;
  /** 範囲メモの終了ページ。省略時は pageStart と同じ 1 ページ分。 */
  pageEnd?: number;
  tags: string[];
  isFavorite: boolean;
  /** 復習項目として登録するか。 */
  isReview: boolean;
  /** 入力途中の自動保存 (下書き)。明示的に保存すると false になる。 */
  isDraft: boolean;
  createdAt: string;
  updatedAt: string;
};

/** メモ一覧の並べ替え。 */
export type MemoSortKey = 'createdDesc' | 'page' | 'updatedDesc';

export const MEMO_SORT_LABELS: Record<MemoSortKey, string> = {
  createdDesc: '作成日時が新しい順',
  page: 'ページ順',
  updatedDesc: '更新日時が新しい順',
};

/* ------------------------------------------------------------------ */
/* 自動分類ルール                                                      */
/* ------------------------------------------------------------------ */

/** 条件の種類。ユーザーが選ぶ 12 種類。 */
export type RuleField =
  /** ファイル名に指定文字を含む */
  | 'nameContains'
  /** ファイル名が指定文字から始まる */
  | 'nameStartsWith'
  /** ファイル名が指定文字で終わる */
  | 'nameEndsWith'
  /** PDF内の文字に指定語句を含む */
  | 'contentContains'
  /** 登録元 */
  | 'origin'
  /** 共有元 */
  | 'sharedFrom'
  /** ファイル形式 */
  | 'fileType'
  /** ファイル容量 (MB) */
  | 'size'
  /** ページ数 */
  | 'pageCount'
  /** 作成日 */
  | 'createdAt'
  /** 追加日 */
  | 'addedAt'
  /** タグ */
  | 'tag';

export const RULE_FIELD_LABELS: Record<RuleField, string> = {
  nameContains: 'ファイル名に指定文字を含む',
  nameStartsWith: 'ファイル名が指定文字から始まる',
  nameEndsWith: 'ファイル名が指定文字で終わる',
  contentContains: 'PDF内の文字に指定語句を含む',
  origin: '登録元',
  sharedFrom: '共有元',
  fileType: 'ファイル形式',
  size: 'ファイル容量',
  pageCount: 'ページ数',
  createdAt: '作成日',
  addedAt: '追加日',
  tag: 'タグ',
};

/** 数値・日付条件の比較方法。 */
export type RuleCompare =
  /** 以上 (数値) / 以降 (日付) */
  | 'atLeast'
  /** 以下 (数値) / 以前 (日付) */
  | 'atMost'
  /** 範囲 */
  | 'between'
  /** 最近 N 日以内 (日付のみ) */
  | 'withinDays';

/**
 * 1 つの条件。
 *
 * 種類ごとに使う項目が異なるが、入力画面で扱いやすいよう平らな形にしている。
 * - 文字列条件 (ファイル名・本文・タグ・登録元・共有元・ファイル形式) … `text`
 * - 数値条件 (容量 MB・ページ数)                                     … `compare` / `min` / `max`
 * - 日付条件 (作成日・追加日)                                        … `compare` / `from` / `to` / `days`
 */
export type RuleCondition = {
  id: string;
  field: RuleField;
  text?: string;
  compare?: RuleCompare;
  min?: number;
  max?: number;
  /** YYYY-MM-DD */
  from?: string;
  /** YYYY-MM-DD */
  to?: string;
  days?: number;
};

/** 複数条件の組み合わせ方。 */
export type RuleMatchMode = 'all' | 'any';

export const RULE_MATCH_LABELS: Record<RuleMatchMode, string> = {
  all: 'すべての条件に一致',
  any: 'いずれかの条件に一致',
};

/** ユーザーが作る自動分類ルール。 */
export type ClassifyRule = {
  id: string;
  /** 持ち主。クラウド未ログイン時は LOCAL_OWNER_ID。 */
  userId: string;
  name: string;
  match: RuleMatchMode;
  conditions: RuleCondition[];
  /** 一致したときの移動先フォルダー ID (ROOT_ID も可)。 */
  destFolderId: string;
  /** 自動で移動するか。false なら「一致した」ことだけ知らせる。 */
  autoMove: boolean;
  /** 移動前に確認するか。 */
  confirmBeforeMove: boolean;
  enabled: boolean;
  /** 小さいほど優先。1 が最優先。 */
  priority: number;
  createdAt: string;
  updatedAt: string;
};

/** 複数のルールに一致したときの扱い。 */
export type MultiMatchStrategy =
  /** 最も優先順位が高いルールだけを適用 */
  | 'highest'
  /** 適用するルールをユーザーに確認 */
  | 'ask'
  /** 最初に一致したルールを適用 (優先順位順に見て、見つかった時点で判定を打ち切る) */
  | 'first';

export const MULTI_MATCH_LABELS: Record<MultiMatchStrategy, string> = {
  highest: '最も優先順位が高いルールだけを適用',
  ask: '適用するルールをユーザーに確認',
  first: '最初に一致したルールを適用',
};

/* ------------------------------------------------------------------ */
/* 画像から PDF を作成                                                 */
/* ------------------------------------------------------------------ */

export type PaperSize = 'auto' | 'a4' | 'a3' | 'b5' | 'letter';

export const PAPER_LABELS: Record<PaperSize, string> = {
  auto: '画像サイズに合わせる',
  a4: 'A4',
  a3: 'A3',
  b5: 'B5',
  letter: 'Letter',
};

export type PageOrientation = 'portrait' | 'landscape';

/** 画像の配置方法 (用紙に対する収め方)。 */
export type ImageLayout =
  /** 全体を表示 (はみ出さないよう縮小) */
  | 'contain'
  /** ページいっぱいに表示 (余白なし。はみ出す分は切り取る) */
  | 'fill'
  /** 中央揃え (原寸のまま中央へ。大きい場合だけ縮小) */
  | 'center'
  /** 余白あり (広めの余白を取って全体を表示) */
  | 'margin'
  /** 切り抜いて表示 (用紙比率に合わせて中央を切り抜く) */
  | 'crop';

export const LAYOUT_LABELS: Record<ImageLayout, string> = {
  contain: '全体を表示',
  fill: 'ページいっぱいに表示',
  center: '中央揃え',
  margin: '余白あり',
  crop: '切り抜いて表示',
};

/** 画質のプリセット。 */
export type QualityPreset = 'light' | 'standard' | 'high' | 'original';

export const QUALITY_LABELS: Record<QualityPreset, string> = {
  light: '軽量',
  standard: '標準',
  high: '高画質',
  original: '元画質に近い',
};

/** 各プリセットの長辺上限 (px) と JPEG 品質。 */
export const QUALITY_PRESETS: Record<QualityPreset, { maxEdge: number; quality: number }> = {
  light: { maxEdge: 1200, quality: 0.6 },
  standard: { maxEdge: 2000, quality: 0.8 },
  high: { maxEdge: 3000, quality: 0.88 },
  original: { maxEdge: 4200, quality: 0.94 },
};

/** PDF 作成時の設定。 */
export type ImagePdfOptions = {
  paper: PaperSize;
  orientation: PageOrientation;
  /** 余白 (mm)。用紙が `auto` かつ余白 0 のときは画像と同じ大きさのページになる。 */
  marginMm: number;
  layout: ImageLayout;
  quality: QualityPreset;
  /** 1 ページに並べる画像の枚数。 */
  imagesPerPage: 1 | 2 | 4;
  /** 開くときのパスワード。空なら設定しない。 */
  password?: string;
};

export const DEFAULT_IMAGE_PDF_OPTIONS: ImagePdfOptions = {
  paper: 'a4',
  orientation: 'portrait',
  marginMm: 8,
  layout: 'contain',
  quality: 'standard',
  imagesPerPage: 1,
};

export type ViewMode = 'list' | 'grid' | 'thumbnail';

export type SortKey =
  | 'name'
  | 'updatedDesc'
  | 'updatedAsc'
  | 'size'
  | 'type'
  | 'favorite'
  | 'manual';

export type ThemeMode = 'system' | 'light' | 'dark';

export type Settings = {
  viewMode: ViewMode;
  sortKey: SortKey;
  foldersFirst: boolean;
  theme: ThemeMode;
  trashRetentionDays: number;
  onboardingDone: boolean;
  /** データ構造のバージョン (将来のマイグレーション用)。 */
  schemaVersion: number;
  /** 毎朝の学習レポートを自動で取り込むか。 */
  dailyReportEnabled: boolean;
  /** 自動取り込み先フォルダー ID。未設定なら取り込まない。 */
  dailyReportFolderId?: string;
  /** 取り込み済みレポートの ID (日付) 一覧。二重取り込みの防止に使う。 */
  importedReports: string[];

  /* --- メモ --- */
  /** メモ一覧の並べ替え。 */
  memoSortKey: MemoSortKey;

  /* --- PDF 編集のバージョン履歴 --- */
  /** 1 つの PDF につき残す編集前バージョンの数。0 = 保持しない。 */
  versionKeepCount: number;
  /** バージョンを保持する日数。0 = 期限で消さない。 */
  versionKeepDays: number;

  /* --- 自動分類 --- */
  /** 追加したPDFへ自動分類ルールを適用するか。 */
  classifyEnabled: boolean;
  /** 複数のルールに一致したときの扱い。 */
  classifyMultiMatch: MultiMatchStrategy;
  /**
   * 本文条件の判定で読む先頭ページ数。
   * 全ページを読むと大きなPDFで時間がかかるため上限を設ける。
   */
  classifyTextPages: number;

  /* --- 画像からPDFを作成 --- */
  /** 前回使った作成設定 (次回の初期値)。 */
  imagePdfOptions: ImagePdfOptions;

  /* --- 株式ニュース --- */
  /** 実行済みのデータ移行バージョン (0 = 未実行)。 */
  stockMigrationVersion: number;
  /** レポート作成時にブラウザーの通知を出すか (許可の取得はユーザー操作で行う)。 */
  stockPushEnabled: boolean;
  /** 銘柄追加時の既定の取得時刻 (HH:MM)。 */
  stockDefaultTime: string;

  /* --- クラウド保管 --- */
  /**
   * クラウド保管機能を使うか。
   * 既定は OFF。ユーザーが明示的に ON にするまでアップロードは一切行わない。
   */
  cloudEnabled: boolean;
  /** この日数だけ開かれていない PDF を自動でクラウドへ移す。0 = 自動移動しない。 */
  cloudIdleDays: number;
  /** Wi-Fi (非従量制) 接続のときだけアップロードする。 */
  cloudWifiOnly: boolean;
  /** 最後に自動同期を実行した日時。 */
  cloudLastSyncAt?: string;
};

/** 未使用期間の選択肢 (0 = 自動移動しない)。 */
export const CLOUD_IDLE_OPTIONS = [1, 3, 7, 30, 0] as const;

export const DEFAULT_SETTINGS: Settings = {
  viewMode: 'list',
  sortKey: 'name',
  foldersFirst: true,
  theme: 'system',
  trashRetentionDays: 30,
  onboardingDone: false,
  schemaVersion: 1,
  dailyReportEnabled: false,
  importedReports: [],
  memoSortKey: 'page',
  classifyEnabled: true,
  classifyMultiMatch: 'highest',
  classifyTextPages: 5,
  imagePdfOptions: DEFAULT_IMAGE_PDF_OPTIONS,
  versionKeepCount: 3,
  versionKeepDays: 30,
  stockMigrationVersion: 0,
  stockPushEnabled: false,
  stockDefaultTime: '08:00',
  cloudEnabled: false,
  cloudIdleDays: 1,
  cloudWifiOnly: true,
};

/** 一覧に並べるための共通表現。 */
export type ExplorerItem =
  | { kind: 'folder'; folder: Folder }
  | { kind: 'file'; file: PdfFileMeta };

/** 同名ファイルが存在したときのユーザー選択。 */
export type DuplicateResolution = 'overwrite' | 'rename' | 'cancel';
