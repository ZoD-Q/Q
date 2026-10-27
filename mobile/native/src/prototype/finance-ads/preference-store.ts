import * as SecureStore from "expo-secure-store";
import { createAdPreferenceStore } from "./preference-core";

export const adPreferenceStore = createAdPreferenceStore({
  get: key => SecureStore.getItemAsync(key),
  set: (key, value) => SecureStore.setItemAsync(key, value),
});
