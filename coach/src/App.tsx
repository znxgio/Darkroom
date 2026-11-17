import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Session } from '@supabase/supabase-js';
import { makeBackend } from './config';
import { DEFAULT_SETTINGS, type PhotoWithCritiques, type Settings } from './data/types';
import { decodeFile, readExif, sizeOf } from './lib/image';
import { LiveScreen, type Capture } from './features/live/LiveScreen';
import { ImportScreen } from './features/critique/ImportScreen';
import { ShotSheet, type Shot } from './features/critique/ShotSheet';
import { GalleryScreen } from './features/gallery/GalleryScreen';
import { PhotoDetail } from './features/gallery/PhotoDetail';
import { ProgressScreen } from './features/progress/ProgressScreen';
import { SettingsScreen } from './features/settings/SettingsScreen';
import { Login } from './Login';

type Tab = 'shoot' | 'critique' | 'gallery' | 'progress' | 'settings';
const TABS: { id: Tab; label: string; icon: string }[] = [
  { id: 'shoot', label: 'Shoot', icon: 'M4 8h3l2-3h6l2 3h3v11H4z M12 17a4 4 0 1 0 0-8 4 4 0 0 0 0 8' },
  { id: 'critique', label: 'Critique', icon: 'M12 3l2.6 5.6 6 .7-4.5 4.1 1.2 6L12 16.4 6.7 19.4l1.2-6L3.4 9.3l6-.7z' },
  { id: 'gallery', label: 'Gallery', icon: 'M4 4h7v7H4z M13 4h7v7h-7z M4 13h7v7H4z M13 13h7v7h-7z' },
  { id: 'progress', label: 'Progress', icon: 'M4 19l5-6 4 3 7-9 M4 4v15h16' },
  { id: 'settings', label: 'Settings', icon: 'M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z M19 12l2-1-1-3-2 .3-1.5-1.5L17 5l-3-1-1 2h-2L10 4 7 5l.5 1.8L6 8.3 4 8l-1 3 2 1v0l-2 1 1 3 2-.3 1.5 1.5L7 19l3 1 1-2h2l1 2 3-1-.5-1.8 1.5-1.5 2 .3 1-3z' },
];

const TAB_KEY = 'darkroom:tab';

export default function App() {
  const backend = useMemo(makeBackend, []);
  const { repo, supabase } = backend;
  const [session, setSession] = useState<Session | null | 'loading'>(supabase ? 'loading' : null);

  useEffect(() => {
    if (!supabase) return;
    supabase.auth.getSession().then(({ data }) => setSession(data.session));
    const { data } = supabase.auth.onAuthStateChange((_e, s) => setSession(s));
    return () => data.subscription.unsubscribe();
  }, [supabase]);

  if (supabase && session === 'loading') return <div className="splash" />;
  if (supabase && !session) return <Login supabase={supabase} />;
  return <Main backend={backend} signOut={supabase ? () => supabase.auth.signOut() : null} />;
}

function Main({ backend, signOut }: { backend: ReturnType<typeof makeBackend>; signOut: (() => void) | null }) {
  const { repo } = backend;
  const [tab, setTab] = useState<Tab>(() => {
    try {
      return (localStorage.getItem(TAB_KEY) as Tab) || 'shoot';
    } catch {
      return 'shoot';
    }
  });
  const [settings, setSettings] = useState<Settings>(DEFAULT_SETTINGS);
  const [photos, setPhotos] = useState<PhotoWithCritiques[]>([]);
  const [shot, setShot] = useState<Shot | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);
  const [toast, setToast] = useState('');
  const [refreshKey, setRefreshKey] = useState(0);
  const fileRef = useRef<HTMLInputElement>(null);
  const recritiqueId = useRef<string | null>(null);

  const reload = useCallback(() => {
    repo.listPhotos().then(setPhotos).catch((e) => setToast(`Couldn’t load photos: ${e.message ?? e}`));
    setRefreshKey((k) => k + 1);
  }, [repo]);

  useEffect(() => {
    repo.getSettings().then(setSettings).catch(() => {});
    reload();
  }, [repo, reload]);

  useEffect(() => {
    try {
      localStorage.setItem(TAB_KEY, tab);
    } catch {
      /* fine */
    }
  }, [tab]);

  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(''), 3500);
    return () => clearTimeout(t);
  }, [toast]);

  // Save right away (in order), so a raised cap counts for the very next critique.
  const saveQueue = useRef<Promise<void>>(Promise.resolve());
  const changeSettings = (s: Settings) => {
    setSettings(s);
    saveQueue.current = saveQueue.current
      .then(() => repo.saveSettings(s))
      .catch(() => setToast('Couldn’t save settings'));
  };

  const pick = () => fileRef.current?.click();

  async function onFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = '';
    const photoId = recritiqueId.current ?? undefined;
    recritiqueId.current = null;
    if (!file) return;
    try {
      const img = await decodeFile(file);
      const { w, h } = sizeOf(img);
      const { exif, takenAt } = await readExif(file);
      setShot({ blob: file, url: URL.createObjectURL(file), source: 'import', width: w, height: h, liveScore: null, exif, takenAt, photoId });
    } catch (err) {
      setToast((err as Error).message);
    }
  }

  function onCapture(c: Capture) {
    setShot({ blob: c.blob, url: c.url, source: 'live', width: c.width, height: c.height, liveScore: c.liveScore, exif: null, takenAt: new Date().toISOString() });
  }

  const open = photos.find((p) => p.id === openId) ?? null;
  const visibleTabs = TABS.filter((t) => t.id !== 'critique' || settings.ai_critique);
  const current = visibleTabs.some((t) => t.id === tab) ? tab : 'shoot';

  return (
    <div className="app">
      <main className={`main main-${current}`}>
        {current === 'shoot' && <LiveScreen settings={settings} onSettings={changeSettings} onCapture={onCapture} onImport={pick} />}
        {current === 'critique' && <ImportScreen settings={settings} recent={photos} onPick={pick} onOpen={setOpenId} />}
        {current === 'gallery' && <GalleryScreen photos={photos} onOpen={setOpenId} />}
        {current === 'progress' && <ProgressScreen photos={photos} onOpen={setOpenId} />}
        {current === 'settings' && (
          <SettingsScreen repo={repo} settings={settings} onChange={changeSettings} onSignOut={signOut} refreshKey={refreshKey} />
        )}
      </main>

      <nav className="tabs" aria-label="Main">
        {visibleTabs.map((t) => (
          <button key={t.id} className={current === t.id ? 'is-on' : ''} aria-current={current === t.id ? 'page' : undefined} onClick={() => setTab(t.id)}>
            <svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round" strokeLinecap="round" aria-hidden="true">
              <path d={t.icon} />
            </svg>
            <span>{t.label}</span>
          </button>
        ))}
      </nav>

      {open && !shot && (
        <PhotoDetail
          photo={open}
          settings={settings}
          onClose={() => setOpenId(null)}
          onDelete={async () => {
            await repo.deletePhoto(open.id).catch(() => setToast('Couldn’t delete'));
            setOpenId(null);
            reload();
          }}
          onRecritique={() => {
            recritiqueId.current = open.id;
            pick();
          }}
        />
      )}

      {shot && (
        <ShotSheet
          key={shot.url}
          shot={shot}
          repo={repo}
          settings={settings}
          onClose={() => setShot(null)}
          onSaved={reload}
          onOpenSettings={() => {
            setShot(null);
            setOpenId(null);
            setTab('settings');
          }}
        />
      )}

      {toast && <div className="toast" role="status">{toast}</div>}
      <input ref={fileRef} type="file" accept="image/*" hidden onChange={onFile} data-testid="file" />
    </div>
  );
}
