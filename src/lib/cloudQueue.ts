/**
 * クラウド上のファイルを「あとで削除する」ための待ち行列。
 *
 * 完全削除 (ごみ箱の完全削除・保持期間切れ・ごみ箱を空にする) を実行すると、
 * 端末内のレコードは消えてしまうため、クラウド側の保存先を覚えておく場所が必要になる。
 * ここへ積んでおき、オンラインになったタイミングでまとめて削除する。
 *
 * - このモジュールは IndexedDB だけを触る (Firebase へは依存しない)。
 *   そのため repository からも安全に呼べる。
 * - 同じパスを何度積んでも 1 件にまとまる (冪等)。
 * - 削除に失敗しても行は残るので、次回オンライン時に再試行される。
 */
import { readKeyed, writeKeyed } from './db';
import { nowIso } from './naming';

const QUEUE_KEY = 'cloudDeleteQueue';
/** 際限なく溜まらないよう上限を設ける (古いものから捨てる)。 */
const MAX_TASKS = 500;

/** クラウド上でユーザーごとに分離するためのディレクトリ名。 */
export const CLOUD_DIR = 'pdf-cloud';

/** クラウド上の保存先。UID 配下に固定し、他人の領域を指せないようにする。 */
export function cloudPathFor(uid: string, fileId: string): string {
  return `users/${uid}/${CLOUD_DIR}/${fileId}.pdf`;
}

/** 保存先パスから所有者 UID を取り出す (削除キューの持ち主判定に使う)。 */
export function uidFromCloudPath(path: string | undefined): string {
  const matched = /^users\/([^/]+)\//.exec(path ?? '');
  return matched?.[1] ?? '';
}

export type CloudDeleteTask = {
  /** クラウド上の保存先。`users/<uid>/pdf-cloud/<fileId>.pdf` */
  path: string;
  /** どのユーザーの領域か。別アカウントでログインしたときに実行しないための保険。 */
  uid: string;
  /** 参考表示用。削除済みでも名前が分かるようにしておく。 */
  name?: string;
  enqueuedAt: string;
  attempts: number;
  lastError?: string;
  lastAttemptAt?: string;
};

export async function readDeleteQueue(): Promise<CloudDeleteTask[]> {
  const value = await readKeyed<CloudDeleteTask[]>(QUEUE_KEY);
  return Array.isArray(value) ? value : [];
}

async function writeDeleteQueue(tasks: CloudDeleteTask[]): Promise<void> {
  await writeKeyed(QUEUE_KEY, tasks.slice(-MAX_TASKS));
}

/** クラウド上の削除対象を積む。すでに同じパスがあれば何もしない。 */
export async function enqueueCloudDeletes(
  entries: { path: string; uid: string; name?: string }[],
): Promise<void> {
  const valid = entries.filter((entry) => entry.path && entry.uid);
  if (valid.length === 0) return;

  const current = await readDeleteQueue();
  const known = new Set(current.map((task) => task.path));
  const added: CloudDeleteTask[] = [];
  for (const entry of valid) {
    if (known.has(entry.path)) continue;
    known.add(entry.path);
    added.push({
      path: entry.path,
      uid: entry.uid,
      name: entry.name,
      enqueuedAt: nowIso(),
      attempts: 0,
    });
  }
  if (added.length === 0) return;
  await writeDeleteQueue([...current, ...added]);
}

/** 削除が完了した (または対象が存在しなかった) パスを取り除く。 */
export async function resolveCloudDeletes(paths: string[]): Promise<void> {
  if (paths.length === 0) return;
  const done = new Set(paths);
  const current = await readDeleteQueue();
  const next = current.filter((task) => !done.has(task.path));
  if (next.length === current.length) return;
  await writeDeleteQueue(next);
}

/** 削除に失敗したパスへ理由を記録する (行は残し、次回再試行させる)。 */
export async function markCloudDeleteFailed(path: string, reason: string): Promise<void> {
  const current = await readDeleteQueue();
  const next = current.map((task) =>
    task.path === path
      ? { ...task, attempts: task.attempts + 1, lastError: reason, lastAttemptAt: nowIso() }
      : task,
  );
  await writeDeleteQueue(next);
}

/**
 * 別のユーザーの領域を指す行を取り除く。
 * ログアウト → 別アカウントでログイン、という流れで他人のファイルへ
 * 削除要求を出さないようにするための掃除。端末内のデータには一切触れない。
 */
export async function dropForeignDeletes(uid: string): Promise<void> {
  const current = await readDeleteQueue();
  const next = current.filter((task) => task.uid === uid);
  if (next.length === current.length) return;
  await writeDeleteQueue(next);
}
