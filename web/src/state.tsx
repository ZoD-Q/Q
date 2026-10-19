import { createContext, useContext, useState, type ReactNode } from 'react';
import { applyAction, createInitialState, type Command, type DemoState, type Locale, type Text } from './domain';

type Admin = {
  state: DemoState; locale: Locale; setLocale: (value: Locale) => void;
  theme: 'light' | 'dark' | 'warm'; setTheme: (value: 'light' | 'dark' | 'warm') => void;
  operator: 'Mandow' | 'hera'; setOperator: (value: 'Mandow' | 'hera') => void;
  t: (zh: string, en: string) => string; text: (value: Text) => string;
  execute: (command: Omit<Command, 'operator'>) => { ok: boolean; recorded: boolean; message: string };
  reset: () => void;
};
const Context = createContext<Admin | null>(null);
export function AdminProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState(createInitialState);
  const [locale, setLocale] = useState<Locale>('zh');
  const [theme, setTheme] = useState<'light' | 'dark' | 'warm'>('light');
  const [operator, setOperator] = useState<'Mandow' | 'hera'>('Mandow');
  const value: Admin = {
    state, locale, setLocale, theme, setTheme, operator, setOperator,
    t: (zh, en) => locale === 'zh' ? zh : en, text: (value) => value[locale],
    execute: (command) => {
      const result = applyAction(state, { ...command, operator });
      setState(result.state);
      return { ok: result.ok, recorded: result.state !== state, message: result.message[locale] };
    },
    reset: () => setState(createInitialState()),
  };
  return <Context.Provider value={value}><div className="app" data-theme={theme} lang={locale === 'zh' ? 'zh-CN' : 'en'}>{children}</div></Context.Provider>;
}
export function useAdmin() {
  const context = useContext(Context);
  if (!context) throw new Error('AdminProvider is required');
  return context;
}
