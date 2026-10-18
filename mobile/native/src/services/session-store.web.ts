// The browser preview deliberately keeps the bearer token in memory only.
let memoryToken: string | null = null;
export const readToken = async () => memoryToken;
export const writeToken = async (token: string) => { memoryToken = token; };
export const removeToken = async () => { memoryToken = null; };
