import type { BankAccount } from "../banking/client";
import { PluginsPage } from "./plugins";
import { WalletPage } from "./wallet";
import { KeysPage } from "./keys";
import { FinancialCatalogPage } from "../financial-catalog/page";
import { InsuranceDashboard, type InsuranceEntry } from "../insurance/page";
export function ServicePage({
  page,
  onOpenWorkbench,
  onBankTransfer,
  onOpenDataService,
  insuranceEntry,
}: {
  onOpenWorkbench: () => void;
  onBankTransfer: (account: BankAccount) => void;
  onOpenDataService: () => void;
  insuranceEntry?: InsuranceEntry;
  page:
    | "plugins"
    | "wallet"
    | "keys"
    | "finance"
    | "installments"
    | "insurance";
}) {
  switch (page) {
    case "plugins":
      return <PluginsPage onOpenWorkbench={onOpenWorkbench} />;
    case "wallet":
      return <WalletPage onTransfer={onBankTransfer} />;
    case "keys":
      return <KeysPage />;
    case "finance":
    case "installments":
      return <FinancialCatalogPage key={page} category={page} onOpenDataService={onOpenDataService} />;
    case "insurance":
      return <InsuranceDashboard initialEntry={insuranceEntry} />;
  }
}
