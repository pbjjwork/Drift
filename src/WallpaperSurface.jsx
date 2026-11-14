import React from 'react';
import { convertFileSrc } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { getCurrentWindow } from '@tauri-apps/api/window';

const STORAGE_KEY = 'drift.settings.v1';

function readSettings() {
  try { return JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}'); }
  catch { return {}; }
}

export default function WallpaperSurface() {
  const [settings, setSettings] = React.useState(readSettings);
  const videoRef = React.useRef(null);

  React.useEffect(() => {
    const current = getCurrentWindow();
    Promise.all([
      current.setAlwaysOnBottom(true),
      current.setVisibleOnAllWorkspaces(true),
      current.setIgnoreCursorEvents(true),
      current.setSkipTaskbar(true),
    ]).catch(() => {});

    let disposeSettings;
    let disposePlayback;
    listen('drift://settings', (event) => {
      const next = event.payload || {};
      localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
      setSettings(next);
    }).then((dispose) => { disposeSettings = dispose; });
    listen('drift://playback', (event) => {
      setSettings((currentSettings) => ({ ...currentSettings, playing: event.payload !== false }));
    }).then((dispose) => { disposePlayback = dispose; });
    return () => { disposeSettings?.(); disposePlayback?.(); };
  }, []);

  React.useEffect(() => {
    if (!videoRef.current) return;
    videoRef.current.muted = settings.muted !== false;
    videoRef.current.loop = settings.loop !== false;
    if (settings.playing === false) videoRef.current.pause();
    else videoRef.current.play().catch(() => {});
  }, [settings]);

  return <main className="drift-surface">
    {settings.path && <video
      ref={videoRef}
      key={settings.path}
      src={convertFileSrc(settings.path)}
      autoPlay
      muted={settings.muted !== false}
      loop={settings.loop !== false}
      playsInline
      style={{ objectFit: settings.fit || 'cover' }}
    />}
  </main>;
}
