import type { BankAccount } from "../banking/client";
import { PluginsPage } from "./plugins";
import { WalletPage } from "./wallet";
import { KeysPage } from "./keys";
import { FinancePage } from "./finance";
import { InstallmentsPage } from "./installments";
import { InsurancePage } from "./insurance";
export function ServicePage({
  page,
  onOpenWorkbench,
  onBankTransfer,
}: {
  onOpenWorkbench: () => void;
  onBankTransfer: (account: BankAccount) => void;
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
      return <FinancePage />;
    case "installments":
      return <InstallmentsPage />;
    case "insurance":
      return <InsurancePage />;
  }
}
