import * as SecureStore from 'expo-secure-store';
const KEY = 'xiaoq.session.v1';
export const readToken = () => SecureStore.getItemAsync(KEY);
export const writeToken = (token: string) => SecureStore.setItemAsync(KEY, token);
export const removeToken = () => SecureStore.deleteItemAsync(KEY);
