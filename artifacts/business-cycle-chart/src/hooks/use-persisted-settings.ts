import { useCallback, useEffect, useRef, useState } from "react";
import { useGetSetting, usePutSetting } from "@workspace/api-client-react";

type Updater<T> = T | ((prev: T) => T);

export interface PersistedSettings<T> {
  value: T;
  setValue: (next: Updater<T>) => void;
  ready: boolean;
  isSaving: boolean;
  /** True when the most recent settled save failed. Resets when a new save starts. */
  saveError: boolean;
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

  return {
    value,
    setValue,
    ready,
    isSaving: putMutation.isPending,
    // `isError` reflects the most recent settled mutation; react-query clears
    // it when a new mutation starts, which matches the semantics we want.
    saveError: putMutation.isError && !putMutation.isPending,
  };
}

export type SaveStatus = "idle" | "saving" | "saved" | "error";

const SAVED_LINGER_MS = 1000;
const ERROR_LINGER_MS = 1000;

/**
 * Convert the persisted-settings save signals into a sticky four-state label
 * for a "Saving…" / "Saved" / "Save failed" indicator in the top bar.
 *
 * - While a write is in flight, returns "saving".
 * - On the falling edge of `isSaving`:
 *   - if `saveError` is true → "error" for ~4s, then "idle"
 *   - otherwise → "saved" for ~1.5s, then "idle"
 * - Returns "idle" until the first save completes.
 */
export function useSaveStatus(isSaving: boolean, saveError: boolean = false): SaveStatus {
  const [status, setStatus] = useState<SaveStatus>("idle");
  const wasSavingRef = useRef(false);

  useEffect(() => {
    if (isSaving) {
      wasSavingRef.current = true;
      setStatus("saving");
      return;
    }
    if (!wasSavingRef.current) return;
    const isError = saveError;
    setStatus(isError ? "error" : "saved");
    const t = setTimeout(() => setStatus("idle"), isError ? ERROR_LINGER_MS : SAVED_LINGER_MS);
    return () => clearTimeout(t);
  }, [isSaving, saveError]);

  return status;
}

