import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Session } from '@supabase/supabase-js';
import { makeBackend } from './config';
import Login from './screens/Login';
import Today from './screens/Today';
import Tasks from './screens/Tasks';

type TabId = 'today' | 'tasks';

// Add new tabs (Photos, Stats, Settings) here.
const TABS: { id: TabId; label: string; icon: string }[] = [
  { id: 'today', label: 'Today', icon: '✓' },
  { id: 'tasks', label: 'Tasks', icon: '☰' },
];

export default function App() {
  const backend = useMemo(makeBackend, []);
  const { repo, supabase } = backend;
  const [session, setSession] = useState<Session | null>(null);
  const [authReady, setAuthReady] = useState(!supabase);
  const [tab, setTab] = useState<TabId>('today');
  const [openNewTask, setOpenNewTask] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const toastTimer = useRef<number | undefined>(undefined);

  const showToast = useCallback((msg: string) => {
    setToast(msg);
    window.clearTimeout(toastTimer.current);
    toastTimer.current = window.setTimeout(() => setToast(null), 4000);
  }, []);

  useEffect(() => {
    if (!supabase) return;
    supabase.auth.getSession().then(({ data }) => {
      setSession(data.session);
      setAuthReady(true);
    });
    const { data } = supabase.auth.onAuthStateChange((_event, s) => {
      setSession(s);
      setAuthReady(true);
    });
    return () => data.subscription.unsubscribe();
  }, [supabase]);

  if (!authReady) return <div className="splash">Loading…</div>;
  if (supabase && !session) return <Login supabase={supabase} />;

  const signOut = supabase
    ? async () => {
        const { error } = await supabase.auth.signOut();
        if (error) showToast(error.message);
      }
    : undefined;

  return (
    <div className="app">
      {repo.mode === 'demo' && (
        <div className="demo-banner">Demo mode — data stays on this phone only</div>
      )}
      <main className="main">
        {tab === 'today' && (
          <Today
            repo={repo}
            onError={showToast}
            onAddTask={() => {
              setOpenNewTask(true);
              setTab('tasks');
            }}
          />
        )}
        {tab === 'tasks' && (
          <Tasks
            repo={repo}
            onError={showToast}
            startWithNew={openNewTask}
            onStartedNew={() => setOpenNewTask(false)}
            onSignOut={signOut}
          />
        )}
      </main>
      {toast && (
        <div className="toast" role="alert" onClick={() => setToast(null)}>
          {toast}
        </div>
      )}
      <nav className="tabbar">
        {TABS.map((t) => (
          <button
            key={t.id}
            type="button"
            data-testid={`tab-${t.id}`}
            className={`tab${tab === t.id ? ' active' : ''}`}
            aria-current={tab === t.id ? 'page' : undefined}
            onClick={() => setTab(t.id)}
          >
            <span className="tab-icon" aria-hidden="true">
              {t.icon}
            </span>
            {t.label}
          </button>
        ))}
      </nav>
    </div>
  );
}
