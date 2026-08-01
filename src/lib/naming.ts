/** ファイル名の正規化と自動採番。 */

export function stripPdfExtension(name: string): string {
  return name.replace(/\.pdf$/i, '');
}

export function ensurePdfExtension(name: string): string {
  const trimmed = name.trim();
  if (!trimmed) return 'untitled.pdf';
  return /\.pdf$/i.test(trimmed) ? trimmed : `${trimmed}.pdf`;
}

const INVALID_NAME_CHARS = /[\\/:*?"<>|]/g;

/** ファイル名に使えない文字を除去する (空白はそのまま残す)。 */
export function sanitizeName(name: string): string {
  return name.replace(INVALID_NAME_CHARS, '_').replace(/\s+/g, ' ').trim();
}

/**
 * 同名が存在する場合に「手順書 (2).pdf」「手順書 (3).pdf」と採番する。
 * @param existing 同じフォルダー内にある既存の名前
 */
export function nextAvailableName(name: string, existing: Iterable<string>): string {
  const taken = new Set(Array.from(existing, (value) => value.toLowerCase()));
  if (!taken.has(name.toLowerCase())) return name;

  const dot = name.lastIndexOf('.');
  const hasExt = dot > 0;
  const rawBase = hasExt ? name.slice(0, dot) : name;
  const ext = hasExt ? name.slice(dot) : '';
  // すでに「(2)」が付いている場合は数字部分を取り除いてから採番し直す
  const base = rawBase.replace(/\s\(\d+\)$/, '');

  for (let index = 2; index < 10_000; index += 1) {
    const candidate = `${base} (${index})${ext}`;
    if (!taken.has(candidate.toLowerCase())) return candidate;
  }
  return `${base} (${Date.now()})${ext}`;
}

/** ID 生成 (crypto.randomUUID が無い環境へのフォールバック付き)。 */
export function createId(prefix = 'id'): string {
  const uuid =
    typeof crypto !== 'undefined' && 'randomUUID' in crypto
      ? crypto.randomUUID()
      : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  return `${prefix}-${uuid}`;
}

export function nowIso(): string {
  return new Date().toISOString();
}
