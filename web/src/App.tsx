import { AdminProvider } from './state';
import { PaymentWorkspace } from './payments/PaymentWorkspace';

export default function App() {
  return <AdminProvider><PaymentWorkspace /></AdminProvider>;
}
