import { useEffect, useState } from "react";

/** Śledzi dostępność sieci (navigator.onLine + zdarzenia). */
export function useOnline(): boolean {
  const [online, setOnline] = useState<boolean>(
    () => (typeof navigator === "undefined" ? true : navigator.onLine),
  );

  useEffect(() => {
    const goOnline = (): void => setOnline(true);
    const goOffline = (): void => setOnline(false);
    window.addEventListener("online", goOnline);
    window.addEventListener("offline", goOffline);
    return () => {
      window.removeEventListener("online", goOnline);
      window.removeEventListener("offline", goOffline);
    };
  }, []);

  return online;
}

/**
 * Czy karta jest widoczna. Polling danych działa tylko wtedy (widoczna karta),
 * więc służy do odróżnienia statusu „na żywo" od samego interwału konfiguracji.
 */
export function usePageVisible(): boolean {
  const [visible, setVisible] = useState<boolean>(
    () => typeof document === "undefined" || document.visibilityState !== "hidden",
  );

  useEffect(() => {
    const update = (): void => setVisible(document.visibilityState === "visible");
    document.addEventListener("visibilitychange", update);
    return () => document.removeEventListener("visibilitychange", update);
  }, []);

  return visible;
}
