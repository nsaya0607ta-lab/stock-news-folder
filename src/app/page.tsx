'use client';

import { ServiceWorkerUpdater } from '@/components/ServiceWorkerUpdater';
import { StockNewsAppShell } from '@/components/stock/StockNewsAppShell';
import { AppProvider } from '@/store/AppStore';
import { CloudProvider } from '@/store/CloudStore';
import { StockProvider } from '@/store/StockStore';

export default function Page() {
  return (
    <AppProvider>
      <CloudProvider>
        <StockProvider>
          <ServiceWorkerUpdater />
          <StockNewsAppShell />
        </StockProvider>
      </CloudProvider>
    </AppProvider>
  );
}
