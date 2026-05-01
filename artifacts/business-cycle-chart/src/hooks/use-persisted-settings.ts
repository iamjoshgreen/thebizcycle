import { useCallback, useEffect, useRef, useState } from "react";
import { useGetSetting, usePutSetting } from "@workspace/api-client-react";

type Updater<T> = T | ((prev: T) => T);

export interface PersistedSettings<T> {
  value: T;
  setValue: (next: Updater<T>) => void;
  ready: boolean;
  isSaving: boolean;
}

const DEBOUNCE_MS = 400;

export function usePersistedSettings<T extends object>(
  key: string,
  defaults: T,
): PersistedSettings<T> {
  const defaultsRef = useRef(defaults);
  const [value, setLocal] = useState<T>(defaults);
  const [ready, setReady] = useState(false);
  const dirtyRef = useRef(false);

  const { data, isLoading, isError } = useGetSetting(key);
  const putMutation = usePutSetting();
  const putRef = useRef(putMutation);
  putRef.current = putMutation;

  useEffect(() => {
    if (ready) return;
    if (isLoading) return;
    if (!dirtyRef.current && data && data.value && typeof data.value === "object") {
      setLocal({ ...defaultsRef.current, ...(data.value as Partial<T>) });
    }
    if (data || isError) setReady(true);
  }, [data, isLoading, isError, ready]);

  const debounceTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const latestRef = useRef<T>(value);
  latestRef.current = value;

  const writeSeq = useRef(0);
  const lastSentSeq = useRef(0);
  const inFlight = useRef(false);
  const pendingFlush = useRef(false);

  const doPut = useCallback(() => {
    const mySeq = ++writeSeq.current;
    inFlight.current = true;
    putRef.current.mutate(
      {
        key,
        data: { value: latestRef.current as Record<string, unknown> },
      },
      {
        onSettled: () => {
          inFlight.current = false;
          if (mySeq > lastSentSeq.current) lastSentSeq.current = mySeq;
          if (pendingFlush.current) {
            pendingFlush.current = false;
            doPut();
          }
        },
      },
    );
  }, [key]);

  const flush = useCallback(() => {
    if (debounceTimer.current) {
      clearTimeout(debounceTimer.current);
      debounceTimer.current = null;
    }
    if (inFlight.current) {
      pendingFlush.current = true;
      return;
    }
    doPut();
  }, [doPut]);

  const flushRef = useRef(flush);
  flushRef.current = flush;

  useEffect(() => {
    if (!ready) return;
    if (!dirtyRef.current) return;
    if (debounceTimer.current) clearTimeout(debounceTimer.current);
    debounceTimer.current = setTimeout(() => {
      debounceTimer.current = null;
      flushRef.current();
    }, DEBOUNCE_MS);
  }, [ready]);

  const setValue = useCallback(
    (next: Updater<T>) => {
      setLocal((prev) => {
        const resolved =
          typeof next === "function" ? (next as (p: T) => T)(prev) : next;
        latestRef.current = resolved;
        return resolved;
      });
      dirtyRef.current = true;
      if (!ready) return;
      if (debounceTimer.current) clearTimeout(debounceTimer.current);
      debounceTimer.current = setTimeout(() => {
        debounceTimer.current = null;
        flushRef.current();
      }, DEBOUNCE_MS);
    },
    [ready],
  );

  useEffect(() => {
    return () => {
      if (debounceTimer.current) {
        clearTimeout(debounceTimer.current);
        debounceTimer.current = null;
        if (dirtyRef.current) flushRef.current();
      }
    };
  }, []);

  useEffect(() => {
    const onHide = () => {
      if (debounceTimer.current) {
        clearTimeout(debounceTimer.current);
        debounceTimer.current = null;
        if (dirtyRef.current) flushRef.current();
      }
    };
    const onVisibility = () => {
      if (document.visibilityState === "hidden") onHide();
    };
    window.addEventListener("pagehide", onHide);
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      window.removeEventListener("pagehide", onHide);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, []);

  return { value, setValue, ready, isSaving: putMutation.isPending };
}
