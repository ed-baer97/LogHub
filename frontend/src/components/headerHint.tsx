import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from "react";

type Ctx = { hint: string | null; setHint: (v: string | null) => void };

const HeaderHint = createContext<Ctx>({ hint: null, setHint: () => undefined });

export function HeaderHintProvider({ children }: { children: ReactNode }) {
  const [hint, setHint] = useState<string | null>(null);
  const value = useMemo(() => ({ hint, setHint }), [hint]);
  return <HeaderHint.Provider value={value}>{children}</HeaderHint.Provider>;
}

export function useHeaderHintValue() {
  return useContext(HeaderHint).hint;
}

export function useHeaderHint(text: string | null) {
  const { setHint } = useContext(HeaderHint);
  useEffect(() => {
    setHint(text);
    return () => setHint(null);
  }, [setHint, text]);
}
