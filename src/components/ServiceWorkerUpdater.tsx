'use client';

import { useEffect } from 'react';

/**
 * ホーム画面へ追加した PWA でも、復帰時に最新の Service Worker を確認し、
 * 新しいバージョンへ切り替わったら一度だけ再読み込みする。
 */
export function ServiceWorkerUpdater() {
  useEffect(() => {
    if (!('serviceWorker' in navigator)) return;

    let registration: ServiceWorkerRegistration | null = null;
    let reloading = false;
    const hadControllerAtMount = Boolean(navigator.serviceWorker.controller);

    const checkForUpdate = () => {
      void registration?.update().catch(() => {
        // 更新確認に失敗してもアプリ自体は継続して利用できる
      });
    };

    const handleVisibilityChange = () => {
      if (document.visibilityState === 'visible') checkForUpdate();
    };

    const handleControllerChange = () => {
      // 初回インストール時は不要な再読み込みを避ける。
      // 既存バージョンから更新された場合のみ、1回だけ最新画面へ切り替える。
      if (!hadControllerAtMount || reloading) return;
      reloading = true;
      window.location.reload();
    };

    navigator.serviceWorker.addEventListener('controllerchange', handleControllerChange);
    window.addEventListener('focus', checkForUpdate);
    window.addEventListener('pageshow', checkForUpdate);
    window.addEventListener('online', checkForUpdate);
    document.addEventListener('visibilitychange', handleVisibilityChange);

    void navigator.serviceWorker
      .register('/sw.js', { updateViaCache: 'none' })
      .then(async (result) => {
        registration = result;

        // 以前のバージョンが waiting のまま残っている場合にも切り替える。
        registration.waiting?.postMessage({ type: 'SKIP_WAITING' });
        await registration.update();
      })
      .catch(() => {
        // Service Worker の登録に失敗してもアプリ自体は継続して利用できる
      });

    return () => {
      navigator.serviceWorker.removeEventListener('controllerchange', handleControllerChange);
      window.removeEventListener('focus', checkForUpdate);
      window.removeEventListener('pageshow', checkForUpdate);
      window.removeEventListener('online', checkForUpdate);
      document.removeEventListener('visibilitychange', handleVisibilityChange);
    };
  }, []);

  return null;
}
