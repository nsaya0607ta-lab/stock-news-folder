/**
 * PDF にパスワード (開くときのパスワード) を設定する。
 *
 * PDF 標準のセキュリティハンドラー Revision 3 / 128bit RC4 を実装している。
 * この方式を選んだ理由:
 *  - 追加のライブラリーなしで、ブラウザーだけで完結する
 *  - iOS / Android の標準ビューアー、Acrobat、pdf.js のいずれでも開ける
 *
 * 注意: RC4 128bit は現在の暗号強度としては強くない。他人に見られて困る情報を
 * 守る用途ではなく、「うっかり開かれないようにする」程度の用途を想定している。
 * その旨は設定画面にも表示する。
 *
 * 暗号化は「すべてのフィルターを適用したあとのストリーム」と「文字列」に対して行う。
 * 暗号辞書 (/Encrypt) と ID だけは暗号化しない。
 */
import { AppError } from './errors';
import type { PDFDocument } from 'pdf-lib';

/* ------------------------------------------------------------------ */
/* MD5                                                                 */
/* ------------------------------------------------------------------ */

const MD5_SHIFTS = [
  7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22,
  5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20,
  4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23,
  6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21,
];

const MD5_K = (() => {
  const table = new Uint32Array(64);
  for (let index = 0; index < 64; index += 1) {
    table[index] = Math.floor(Math.abs(Math.sin(index + 1)) * 4294967296);
  }
  return table;
})();

function rotateLeft(value: number, shift: number): number {
  return (value << shift) | (value >>> (32 - shift));
}

export function md5(input: Uint8Array): Uint8Array {
  const length = input.length;
  const paddedLength = (((length + 8) >> 6) + 1) << 6;
  const padded = new Uint8Array(paddedLength);
  padded.set(input);
  padded[length] = 0x80;
  const bits = length * 8;
  const view = new DataView(padded.buffer);
  view.setUint32(paddedLength - 8, bits >>> 0, true);
  view.setUint32(paddedLength - 4, Math.floor(bits / 4294967296), true);

  let a0 = 0x67452301;
  let b0 = 0xefcdab89;
  let c0 = 0x98badcfe;
  let d0 = 0x10325476;

  const chunk = new Uint32Array(16);
  for (let offset = 0; offset < paddedLength; offset += 64) {
    for (let index = 0; index < 16; index += 1) {
      chunk[index] = view.getUint32(offset + index * 4, true);
    }
    let a = a0;
    let b = b0;
    let c = c0;
    let d = d0;

    for (let index = 0; index < 64; index += 1) {
      let f: number;
      let g: number;
      if (index < 16) {
        f = (b & c) | (~b & d);
        g = index;
      } else if (index < 32) {
        f = (d & b) | (~d & c);
        g = (5 * index + 1) % 16;
      } else if (index < 48) {
        f = b ^ c ^ d;
        g = (3 * index + 5) % 16;
      } else {
        f = c ^ (b | ~d);
        g = (7 * index) % 16;
      }
      const temp = d;
      d = c;
      c = b;
      b = (b + rotateLeft((a + f + MD5_K[index] + chunk[g]) >>> 0, MD5_SHIFTS[index])) >>> 0;
      a = temp;
    }

    a0 = (a0 + a) >>> 0;
    b0 = (b0 + b) >>> 0;
    c0 = (c0 + c) >>> 0;
    d0 = (d0 + d) >>> 0;
  }

  const digest = new Uint8Array(16);
  const out = new DataView(digest.buffer);
  out.setUint32(0, a0, true);
  out.setUint32(4, b0, true);
  out.setUint32(8, c0, true);
  out.setUint32(12, d0, true);
  return digest;
}

/* ------------------------------------------------------------------ */
/* RC4                                                                 */
/* ------------------------------------------------------------------ */

export function rc4(key: Uint8Array, data: Uint8Array): Uint8Array {
  const state = new Uint8Array(256);
  for (let index = 0; index < 256; index += 1) state[index] = index;

  let j = 0;
  for (let index = 0; index < 256; index += 1) {
    j = (j + state[index] + key[index % key.length]) & 0xff;
    const temp = state[index];
    state[index] = state[j];
    state[j] = temp;
  }

  const output = new Uint8Array(data.length);
  let i = 0;
  j = 0;
  for (let index = 0; index < data.length; index += 1) {
    i = (i + 1) & 0xff;
    j = (j + state[i]) & 0xff;
    const temp = state[i];
    state[i] = state[j];
    state[j] = temp;
    output[index] = data[index] ^ state[(state[i] + state[j]) & 0xff];
  }
  return output;
}

/* ------------------------------------------------------------------ */
/* 鍵の生成 (PDF 仕様 Algorithm 2 / 3 / 5)                              */
/* ------------------------------------------------------------------ */

/** 仕様で定められた 32 バイトのパディング列。 */
const PAD = new Uint8Array([
  0x28, 0xbf, 0x4e, 0x5e, 0x4e, 0x75, 0x8a, 0x41, 0x64, 0x00, 0x4e, 0x56, 0xff, 0xfa, 0x01, 0x08,
  0x2e, 0x2e, 0x00, 0xb6, 0xd0, 0x68, 0x3e, 0x80, 0x2f, 0x0c, 0xa9, 0xfe, 0x64, 0x53, 0x69, 0x7a,
]);

/** 鍵の長さ (バイト)。128bit。 */
const KEY_LENGTH = 16;
/** リビジョン 3 (128bit RC4)。 */
const REVISION = 3;
/**
 * 権限フラグ。すべて許可 (印刷・コピー・編集)。
 * 下位 2 ビットは仕様で 0、それ以外は 1 にする必要があるため -4 (0xFFFFFFFC)。
 */
const PERMISSIONS = -4;

/**
 * パスワードを PDF が期待するバイト列にする。
 * この方式 (R3) は Latin-1 の範囲しか扱えないため、それ以外は受け付けない。
 */
export function passwordBytes(password: string): Uint8Array {
  const bytes = new Uint8Array(password.length);
  for (let index = 0; index < password.length; index += 1) {
    const code = password.charCodeAt(index);
    if (code > 0xff) throw new AppError('IMAGE_PDF_ENCRYPT_FAILED');
    bytes[index] = code;
  }
  return bytes;
}

/** パスワードを 32 バイトへ切り詰め / 埋める。 */
function padPassword(password: Uint8Array): Uint8Array {
  const padded = new Uint8Array(32);
  const used = Math.min(password.length, 32);
  padded.set(password.subarray(0, used));
  padded.set(PAD.subarray(0, 32 - used), used);
  return padded;
}

function concat(...parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const result = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    result.set(part, offset);
    offset += part.length;
  }
  return result;
}

/** 鍵の各バイトを i で XOR した鍵 (Algorithm 3/5 の繰り返しで使う)。 */
function xorKey(key: Uint8Array, value: number): Uint8Array {
  const result = new Uint8Array(key.length);
  for (let index = 0; index < key.length; index += 1) result[index] = key[index] ^ value;
  return result;
}

/** O エントリー (所有者パスワード情報)。所有者パスワードは利用者と同じものを使う。 */
export function computeOwnerEntry(password: Uint8Array): Uint8Array {
  let digest = md5(padPassword(password));
  for (let round = 0; round < 50; round += 1) digest = md5(digest.subarray(0, KEY_LENGTH));
  const rc4Key = digest.subarray(0, KEY_LENGTH);

  let value = rc4(rc4Key, padPassword(password));
  for (let round = 1; round <= 19; round += 1) value = rc4(xorKey(rc4Key, round), value);
  return value;
}

/** 暗号鍵 (Algorithm 2)。 */
export function computeEncryptionKey(
  password: Uint8Array,
  ownerEntry: Uint8Array,
  documentId: Uint8Array,
): Uint8Array {
  const permissions = new Uint8Array(4);
  new DataView(permissions.buffer).setInt32(0, PERMISSIONS, true);

  let digest = md5(concat(padPassword(password), ownerEntry, permissions, documentId));
  for (let round = 0; round < 50; round += 1) digest = md5(digest.subarray(0, KEY_LENGTH));
  return digest.slice(0, KEY_LENGTH);
}

/** U エントリー (利用者パスワード情報。Algorithm 5)。 */
export function computeUserEntry(key: Uint8Array, documentId: Uint8Array): Uint8Array {
  const digest = md5(concat(PAD, documentId));
  let value = rc4(key, digest);
  for (let round = 1; round <= 19; round += 1) value = rc4(xorKey(key, round), value);
  // 後半 16 バイトは任意の値でよい (仕様どおりパディングで埋める)
  return concat(value, PAD.subarray(0, 16));
}

/** オブジェクトごとの鍵 (Algorithm 1)。 */
function objectKey(key: Uint8Array, objectNumber: number, generationNumber: number): Uint8Array {
  const extra = new Uint8Array(5);
  extra[0] = objectNumber & 0xff;
  extra[1] = (objectNumber >> 8) & 0xff;
  extra[2] = (objectNumber >> 16) & 0xff;
  extra[3] = generationNumber & 0xff;
  extra[4] = (generationNumber >> 8) & 0xff;
  const digest = md5(concat(key, extra));
  return digest.slice(0, Math.min(key.length + 5, 16));
}

/* ------------------------------------------------------------------ */
/* PDF への適用                                                        */
/* ------------------------------------------------------------------ */

function toHex(bytes: Uint8Array): string {
  let hex = '';
  for (const byte of bytes) hex += byte.toString(16).padStart(2, '0');
  return hex;
}

function randomBytes(length: number): Uint8Array {
  const bytes = new Uint8Array(length);
  if (typeof crypto !== 'undefined' && crypto.getRandomValues) {
    crypto.getRandomValues(bytes);
    return bytes;
  }
  for (let index = 0; index < length; index += 1) bytes[index] = Math.floor(Math.random() * 256);
  return bytes;
}

/**
 * 文書全体にパスワードを設定する。
 *
 * 呼び出したあとに `doc.save({ useObjectStreams: false })` で書き出すこと。
 * オブジェクトストリームを使うと、その中の文字列を個別に暗号化できないため。
 */
export async function encryptDocument(doc: PDFDocument, password: string): Promise<void> {
  const secret = passwordBytes(password);
  if (secret.length === 0) throw new AppError('IMAGE_PDF_ENCRYPT_FAILED');

  const {
    PDFArray,
    PDFDict,
    PDFHexString,
    PDFName,
    PDFNumber,
    PDFRawStream,
    PDFStream,
    PDFString,
  } = await import('pdf-lib');

  // 画像・フォントなどの遅延埋め込みを先に済ませ、すべてのオブジェクトを確定させる
  await doc.flush();

  const context = doc.context;
  const documentId = randomBytes(16);
  const ownerEntry = computeOwnerEntry(secret);
  const key = computeEncryptionKey(secret, ownerEntry, documentId);
  const userEntry = computeUserEntry(key, documentId);

  /** 文字列を暗号化して、同じ位置へ差し戻す。 */
  const encryptStrings = (target: unknown, itemKey: Uint8Array, depth = 0): void => {
    if (depth > 32) return;
    if (target instanceof PDFDict) {
      for (const [name, value] of target.entries()) {
        if (value instanceof PDFString || value instanceof PDFHexString) {
          target.set(name, PDFHexString.of(toHex(rc4(itemKey, value.asBytes()))));
        } else if (value instanceof PDFDict || value instanceof PDFArray) {
          encryptStrings(value, itemKey, depth + 1);
        }
      }
      return;
    }
    if (target instanceof PDFArray) {
      for (let index = 0; index < target.size(); index += 1) {
        const value = target.get(index);
        if (value instanceof PDFString || value instanceof PDFHexString) {
          target.set(index, PDFHexString.of(toHex(rc4(itemKey, value.asBytes()))));
        } else if (value instanceof PDFDict || value instanceof PDFArray) {
          encryptStrings(value, itemKey, depth + 1);
        }
      }
    }
  };

  try {
    for (const [ref, object] of context.enumerateIndirectObjects()) {
      const itemKey = objectKey(key, ref.objectNumber, ref.generationNumber);

      if (object instanceof PDFStream) {
        // フィルター適用後のバイト列を暗号化する (長さは変わらない)
        const contents = object.getContents();
        const encrypted = rc4(itemKey, contents);
        encryptStrings(object.dict, itemKey);
        // 暗号化後のバイト列を持つ生ストリームへ置き換える。
        // (pdf-lib のストリームは書き出し時に中身を組み立てるものがあるため、
        //  ここで確定させておく。長さは RC4 で変わらないので /Length はそのまま)
        context.assign(ref, PDFRawStream.of(object.dict, encrypted));
        continue;
      }

      encryptStrings(object, itemKey);
    }

    // 暗号辞書自体は暗号化しない。走査を終えてから登録する。
    const encryptDict = context.obj({
      Filter: PDFName.of('Standard'),
      V: PDFNumber.of(2),
      R: PDFNumber.of(REVISION),
      Length: PDFNumber.of(KEY_LENGTH * 8),
      P: PDFNumber.of(PERMISSIONS),
      O: PDFHexString.of(toHex(ownerEntry)),
      U: PDFHexString.of(toHex(userEntry)),
    });
    context.trailerInfo.Encrypt = context.register(encryptDict);
    // ID も暗号化しない (鍵の計算に使うため、書き出す値と一致している必要がある)
    const id = PDFHexString.of(toHex(documentId));
    context.trailerInfo.ID = context.obj([id, id]);
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw new AppError('IMAGE_PDF_ENCRYPT_FAILED');
  }
}
