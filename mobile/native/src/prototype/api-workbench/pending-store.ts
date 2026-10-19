import * as SecureStore from "expo-secure-store";
import { createPendingStore } from "./core";

export const pendingStore = createPendingStore({ get: SecureStore.getItemAsync, set: SecureStore.setItemAsync, remove: SecureStore.deleteItemAsync });
