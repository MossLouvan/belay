// The two hooks theme.ts imports. Never called during extraction — the theme
// store only runs inside a React render — but the import has to resolve.
export const useCallback = (callback) => callback;
export const useSyncExternalStore = (_subscribe, getSnapshot) => getSnapshot();
