/**
 * 他アプリの共有メニューから送られてきた PDF の受け取り。
 *
 * Service Worker が share_target への POST を受け取り、IndexedDB の
 * share_inbox ストアへ保存する。アプリ起動時にここで回収する。
 *
 * 対応状況:
 *  - Android (Chrome) でホーム画面に追加済みの場合に共有メニューへ表示される
 *  - iOS / iPadOS の Safari は Web Share Target に未対応のため、
 *    「ファイル」アプリ経由での追加を案内する
 */
import { STORE, idb, tx } from './db';

type SharedRecord = { id: string; name: string; blob: Blob; receivedAt: string };

export async function takeSharedFiles(): Promise<{ name: string; blob: Blob }[]> {
  try {
    return await tx(STORE.shareInbox, 'readwrite', async (t) => {
      const store = t.objectStore(STORE.shareInbox);
      const records = await idb.getAll<SharedRecord>(store);
      for (const record of records) await idb.delete(store, record.id);
      return records
        .filter((record) => record.blob instanceof Blob)
        .map((record) => ({ name: record.name || 'shared.pdf', blob: record.blob }));
    });
  } catch {
    return [];
  }
}

export function hasSharedFlag(): boolean {
  if (typeof window === 'undefined') return false;
  return new URLSearchParams(window.location.search).has('shared');
}

export function clearSharedFlag(): void {
  if (typeof window === 'undefined') return;
  const url = new URL(window.location.href);
  url.searchParams.delete('shared');
  window.history.replaceState(window.history.state, '', url.toString());
}
