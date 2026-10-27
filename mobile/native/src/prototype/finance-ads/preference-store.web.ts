import { createAdPreferenceStore } from "./preference-core";

// Only nonsensitive display preferences persist. Counts remain in memory.
export const adPreferenceStore = createAdPreferenceStore({
  get: async key => localStorage.getItem(key),
  set: async (key, value) => { localStorage.setItem(key, value); },
});
