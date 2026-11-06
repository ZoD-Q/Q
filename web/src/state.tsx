import { createContext, useCallback, useContext, useState, type ReactNode } from 'react';

type Locale = 'zh' | 'en';
type Admin = { locale: Locale; setLocale: (value: Locale) => void; t: (zh: string, en: string) => string };
const Context = createContext<Admin | null>(null);

export function AdminProvider({ children }: { children: ReactNode }) {
  const [locale, setLocale] = useState<Locale>('zh');
  const t = useCallback((zh: string, en: string) => locale === 'zh' ? zh : en, [locale]);
  return <Context.Provider value={{ locale, setLocale, t }}><div className="app" data-theme="operations" lang={locale === 'zh' ? 'zh-CN' : 'en'}>{children}</div></Context.Provider>;
}
export function useAdmin() {
  const value = useContext(Context);
  if (!value) throw new Error('AdminProvider is required');
  return value;
}
