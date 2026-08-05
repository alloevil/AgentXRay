import { useEffect } from 'react';
import { toast } from 'sonner';
import { getVersion } from '@/api/client';

// Stale-page detection, ported from public/js/app.js: remember the server bootId
// on first success; when it changes, offer a one-time reload toast.
export function useVersionPoller() {
  useEffect(() => {
    let bootId: string | null = null;
    let notified = false;
    const check = async () => {
      try {
        const data = await getVersion();
        if (bootId === null) {
          bootId = data.bootId;
          return;
        }
        if (data.bootId !== bootId && !notified) {
          notified = true;
          toast('🔄 AgentXRay 已更新 — 点击刷新加载新版本', {
            duration: Number.POSITIVE_INFINITY,
            action: { label: '刷新', onClick: () => location.reload() },
          });
        }
      } catch {
        /* server briefly down during restart — keep polling */
      }
    };
    check();
    const timer = setInterval(check, 15_000);
    window.addEventListener('focus', check);
    return () => {
      clearInterval(timer);
      window.removeEventListener('focus', check);
    };
  }, []);
}
