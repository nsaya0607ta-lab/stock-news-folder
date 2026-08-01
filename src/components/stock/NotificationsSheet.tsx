'use client';

/** アプリ内通知の履歴。通知が許可されていなくても、ここから確認できる。 */
import { useEffect } from 'react';
import { BellRing, Trash2 } from 'lucide-react';
import { BottomSheet } from '@/components/ui/Sheet';
import { Button } from '@/components/ui/Primitives';
import { useApp } from '@/store/AppStore';
import { useStock } from '@/store/StockStore';
import { formatDateTime } from './StockBits';

export function NotificationsSheet({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { settings } = useApp();
  const { notifications, readAllNotifications, clearNotificationHistory, enablePushNotifications } = useStock();

  useEffect(() => {
    if (open) void readAllNotifications();
  }, [open, readAllNotifications]);

  return (
    <BottomSheet
      open={open}
      title="通知"
      description="レポートが作成されると、ここに履歴が残ります。"
      onClose={onClose}
      footer={
        notifications.length > 0 ? (
          <Button className="w-full" onClick={() => void clearNotificationHistory()}>
            <Trash2 size={18} />
            履歴を消去
          </Button>
        ) : undefined
      }
    >
      {!settings.stockPushEnabled ? (
        <div className="mx-4 mt-2 rounded-card border border-line bg-surface-sub px-3 py-3 dark:border-[#333d49] dark:bg-[#1b222a]">
          <p className="text-sm text-ink dark:text-[#e6eaef]">端末の通知を受け取る</p>
          <p className="mt-1 text-xs leading-relaxed text-ink-sub dark:text-[#98a3b0]">
            許可すると、レポートの作成時に端末の通知が表示されます。許可しない場合も、この履歴で確認できます。
          </p>
          <Button
            variant="primary"
            className="mt-2 h-9 min-h-0 px-3 text-sm"
            onClick={() => void enablePushNotifications()}
          >
            <BellRing size={16} />
            通知を許可する
          </Button>
        </div>
      ) : null}

      {notifications.length === 0 ? (
        <p className="px-4 py-8 text-center text-sm text-ink-sub dark:text-[#98a3b0]">
          通知はまだありません。
        </p>
      ) : (
        <ul>
          {notifications.map((notification) => (
            <li
              key={notification.id}
              className="border-b border-line px-4 py-3 last:border-b-0 dark:border-[#2a333d]"
            >
              <p className="break-words text-base font-semibold text-ink dark:text-[#e6eaef]">
                {notification.title}
              </p>
              <p className="mt-0.5 break-words text-sm leading-relaxed text-ink-sub dark:text-[#98a3b0]">
                {notification.body}
              </p>
              <p className="mt-1 text-xs text-ink-faint">{formatDateTime(notification.createdAt)}</p>
            </li>
          ))}
        </ul>
      )}
    </BottomSheet>
  );
}
