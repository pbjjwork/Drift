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
  const surfaceMonitorIndex = Number(new URLSearchParams(window.location.hash.split('?')[1] || '').get('display') || 0);

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

  const scene = settings.displayMode === 'individual'
    ? { ...settings, ...(settings.displayScenes?.[settings.surfaceMonitorIndex ?? surfaceMonitorIndex] || {}) }
    : settings;

  React.useEffect(() => {
    if (!videoRef.current) return;
    videoRef.current.muted = scene.muted !== false;
    videoRef.current.loop = scene.loop !== false;
    if (scene.playing === false) videoRef.current.pause();
    else videoRef.current.play().catch(() => {});
  }, [scene]);

  return <main className="drift-surface">
    {scene.path && <video
      ref={videoRef}
      key={scene.path}
      src={convertFileSrc(scene.path)}
      autoPlay
      muted={scene.muted !== false}
      loop={scene.loop !== false}
      playsInline
      style={{ objectFit: scene.fit || settings.fit || 'cover' }}
    />}
  </main>;
}
