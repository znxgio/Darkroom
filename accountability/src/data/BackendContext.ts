// The app's Backend, provided once in App.tsx so feature components (trackers, …)
// can be dropped into any screen without threading props through it.
import { createContext, useContext } from 'react';
import type { Backend } from './backend';

export const BackendContext = createContext<Backend | null>(null);

export function useBackend(): Backend {
  const b = useContext(BackendContext);
  if (!b) throw new Error('BackendContext is missing (wrap the app in <BackendContext.Provider>)');
  return b;
}
