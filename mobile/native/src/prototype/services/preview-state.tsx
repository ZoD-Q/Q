import { createContext, use, useState, type ReactNode } from 'react';
import { useQAccount } from '../account/account-state';

type Installment = { serviceId: string; periods: number };
type Insurance = { scene: 'everyday' | 'travel' | 'home'; planId: string };
type Finance = { firm: number; principal: number; days: number; rate: number };
function usePreviewState() {
  const [installment, setInstallment] = useState<Installment | null>(null);
  const [insurance, setInsurance] = useState<Insurance | null>(null);
  const [finance, setFinance] = useState<Finance | null>(null);
  const [savedListings, setSavedListings] = useState<string[]>([]);
  return { installment, setInstallment, insurance, setInsurance, finance, setFinance, savedListings, setSavedListings };
}
const Context = createContext<ReturnType<typeof usePreviewState> | null>(null);
export function FinancialPreviewProvider({ children }: { children: ReactNode }) {
  const { session } = useQAccount();
  return <PreviewSession key={session?.user.id ?? 'guest'}>{children}</PreviewSession>;
}
function PreviewSession({ children }: { children: ReactNode }) {
  const state = usePreviewState();
  return <Context value={state}>{children}</Context>;
}
export function useFinancialPreview() {
  const value = use(Context);
  if (!value) throw new Error('FinancialPreviewProvider required');
  return value;
}
