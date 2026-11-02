import { createPaymentJournal } from './journal-core';
// Only the allowlisted pending intent reaches localStorage. Bearer tokens never do.
export const paymentJournal = (origin: string, ownerId: string) => createPaymentJournal({
  get: async key => localStorage.getItem(key),
  set: async (key, value) => localStorage.setItem(key, value),
  remove: async key => localStorage.removeItem(key),
}, origin, ownerId);
