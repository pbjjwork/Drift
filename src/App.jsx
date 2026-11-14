import React from 'react';
import { convertFileSrc, invoke } from '@tauri-apps/api/core';
import { emitTo, listen } from '@tauri-apps/api/event';
import { open } from '@tauri-apps/plugin-dialog';
import { disable, enable, isEnabled } from '@tauri-apps/plugin-autostart';
import { availableMonitors, getCurrentWindow, primaryMonitor } from '@tauri-apps/api/window';
import { WebviewWindow } from '@tauri-apps/api/webviewWindow';

const STORAGE_KEY = 'drift.settings.v1';
const SURFACE_LABEL = 'wallpaper';
const DEFAULTS = { path: '', name: '', fit: 'cover', muted: true, loop: true, playing: true, monitorIndex: 0, resumeOnLaunch: true };

function readSettings() {
  try { return { ...DEFAULTS, ...JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}') }; }
  catch { return DEFAULTS; }
}
function nameFromPath(path = '') { return path.split(/[\\/]/).pop() || ''; }

export default function App() {
  const [settings, setSettings] = React.useState(readSettings);
  const settingsRef = React.useRef(settings);
  const [monitors, setMonitors] = React.useState([]);
  const [running, setRunning] = React.useState(false);
  const [launchAtLogin, setLaunchAtLogin] = React.useState(false);
  const [desktopProtection, setDesktopProtection] = React.useState(false);
  const [notice, setNotice] = React.useState('Choose a video to turn your desktop into a living scene.');

  const persist = React.useCallback((next) => {
    settingsRef.current = next;
    setSettings(next);
    localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
  }, []);

  const syncSurface = React.useCallback(async (next) => {
    await emitTo(SURFACE_LABEL, 'drift://settings', next).catch(() => {});
  }, []);

  const update = (patch) => {
    const next = { ...settingsRef.current, ...patch };
    persist(next);
    if (running) syncSurface(next);
  };

  const stopWallpaper = React.useCallback(async () => {
    const surface = await WebviewWindow.getByLabel(SURFACE_LABEL);
    await surface?.destroy();
    setRunning(false);
    setNotice('Wallpaper stopped. Your scene is still saved.');
  }, []);

  const startWallpaper = React.useCallback(async (override) => {
    const config = { ...settingsRef.current, ...(override || {}), playing: true };
    if (!config.path) {
      setNotice('Choose a video first.');
      return;
    }
    persist(config);
    const existing = await WebviewWindow.getByLabel(SURFACE_LABEL);
    if (existing) {
      await existing.show();
      await syncSurface(config);
      setRunning(true);
      setNotice('Drift is running quietly behind your workspace.');
      return;
    }
    const displays = monitors.length ? monitors : await availableMonitors();
    const monitor = displays[config.monitorIndex] || await primaryMonitor();
    const scale = monitor?.scaleFactor || 1;
    const size = monitor?.size || { width: window.screen.width, height: window.screen.height };
    const position = monitor?.position || { x: 0, y: 0 };
    const surface = new WebviewWindow(SURFACE_LABEL, {
      url: 'index.html#/wallpaper',
      x: position.x / scale,
      y: position.y / scale,
      width: size.width / scale,
      height: size.height / scale,
      decorations: false,
      shadow: false,
      resizable: false,
      focus: false,
      focusable: false,
      skipTaskbar: true,
      alwaysOnBottom: true,
      visibleOnAllWorkspaces: true,
      backgroundColor: '#000000',
    });
    surface.once('tauri://created', async () => {
      await Promise.all([
        surface.setAlwaysOnBottom(true),
        surface.setVisibleOnAllWorkspaces(true),
        surface.setIgnoreCursorEvents(true),
        surface.setSkipTaskbar(true),
      ]).catch(() => {});
      setRunning(true);
      setNotice('Drift is running quietly behind your workspace.');
      setTimeout(() => syncSurface(config), 250);
    });
    surface.once('tauri://error', (event) => setNotice(`Could not start Drift: ${event.payload || 'window failed to open'}`));
  }, [monitors, persist, syncSurface]);

  React.useEffect(() => {
    let disposed = false;
    Promise.all([availableMonitors(), isEnabled(), invoke('get_click_protection'), WebviewWindow.getByLabel(SURFACE_LABEL)])
      .then(([displayList, autostart, protectedDesktop, surface]) => {
        if (disposed) return;
        setMonitors(displayList || []);
        setLaunchAtLogin(Boolean(autostart));
        setDesktopProtection(Boolean(protectedDesktop));
        setRunning(Boolean(surface));
      }).catch(() => {});

    let disposers = [];
    Promise.all([
      listen('drift://toggle', async () => {
        const surface = await WebviewWindow.getByLabel(SURFACE_LABEL);
        if (!surface) return startWallpaper();
        const next = !settingsRef.current.playing;
        update({ playing: next });
      }),
      listen('drift://stop', stopWallpaper),
    ]).then((values) => { disposers = values; });

    invoke('is_autostart_launch').then(async (autostart) => {
      if (!autostart) return;
      if (settingsRef.current.resumeOnLaunch && settingsRef.current.path) await startWallpaper();
      await getCurrentWindow().hide();
    }).catch(() => {});
    return () => { disposed = true; disposers.forEach((dispose) => dispose()); };
  }, [startWallpaper, stopWallpaper]);

  const chooseVideo = async () => {
    const picked = await open({ multiple: false, directory: false, filters: [{ name: 'Video', extensions: ['mp4', 'mov', 'm4v', 'webm'] }] });
    if (!picked || Array.isArray(picked)) return;
    const next = { ...settingsRef.current, path: picked, name: nameFromPath(picked), playing: true };
    persist(next);
    if (running) syncSurface(next);
    setNotice('Scene ready. Start Drift when the framing looks right.');
  };

  const toggleAutostart = async () => {
    if (launchAtLogin) await disable(); else await enable();
    setLaunchAtLogin(!launchAtLogin);
  };

  const toggleProtection = async () => {
    const enabled = await invoke('set_click_protection', { enabled: !desktopProtection });
    setDesktopProtection(Boolean(enabled));
    setNotice(enabled ? 'Desktop protected. Wallpaper clicks will keep your windows in place.' : 'Standard macOS desktop reveal restored.');
  };

  const previewUrl = settings.path ? convertFileSrc(settings.path) : '';

  return <main className="drift-app">
    <div className="drift-app__glow" />
    <header className="drift-header" data-tauri-drag-region>
      <div className="drift-brand" data-tauri-drag-region><span>≈</span><div><strong>Drift</strong><small>MOTION WALLPAPER</small></div></div>
      <div className={`drift-live ${running ? 'is-live' : ''}`}><i />{running ? 'RUNNING' : 'READY'}</div>
    </header>

    <section className="drift-layout">
      <div className="drift-preview-card">
        <div className="drift-section-title"><span>DESKTOP PREVIEW</span><strong>{monitors[settings.monitorIndex]?.name || 'Main display'}</strong></div>
        <div className="drift-preview">
          {previewUrl ? <video src={previewUrl} autoPlay muted loop playsInline style={{ objectFit: settings.fit }} /> : <button onClick={chooseVideo}><b>＋</b><strong>Choose your first scene</strong><small>MP4, MOV, M4V or WebM</small></button>}
          <div className="drift-preview__shade" /><div className="drift-preview__dock"><i/><i/><i/><i/><i/></div>
        </div>
        <p>{notice}</p>
      </div>

      <aside className="drift-controls">
        <div className="drift-section-title"><span>SCENE</span><strong>{settings.name || 'No video selected'}</strong></div>
        <button className="drift-file" onClick={chooseVideo}><span>▶</span><div><strong>{settings.name || 'Choose video'}</strong><small>{settings.path ? 'Click to replace' : 'Select a local file'}</small></div><b>Browse</b></button>
        <label className="drift-select"><span>DISPLAY</span><select value={settings.monitorIndex} onChange={(event) => update({ monitorIndex: Number(event.target.value) })}>{(monitors.length ? monitors : [{ name: 'Main display' }]).map((monitor, index) => <option key={`${monitor.name}-${index}`} value={index}>{monitor.name || `Display ${index + 1}`}</option>)}</select></label>
        <div className="drift-segment"><button className={settings.fit === 'cover' ? 'active' : ''} onClick={() => update({ fit: 'cover' })}><strong>Fill</strong><small>Crop edges</small></button><button className={settings.fit === 'contain' ? 'active' : ''} onClick={() => update({ fit: 'contain' })}><strong>Fit</strong><small>Show everything</small></button></div>
        <Toggle title="Loop continuously" subtitle="Restart when the video ends" enabled={settings.loop} onClick={() => update({ loop: !settings.loop })} />
        <Toggle title="Mute wallpaper" subtitle="Keep your desktop quiet" enabled={settings.muted} onClick={() => update({ muted: !settings.muted })} />
        <Toggle title="Open at login" subtitle="Start Drift when you sign in" enabled={launchAtLogin} onClick={toggleAutostart} />
        <Toggle title="Resume scene on launch" subtitle="Restore this wallpaper automatically" enabled={settings.resumeOnLaunch} onClick={() => update({ resumeOnLaunch: !settings.resumeOnLaunch })} />
        <Toggle title="Keep windows in place" subtitle="Disable click-to-reveal desktop" enabled={desktopProtection} onClick={toggleProtection} />
        <div className="drift-actions"><button className="drift-primary" onClick={running ? () => update({ playing: !settings.playing }) : () => startWallpaper()}>{running ? (settings.playing ? 'Pause motion' : 'Resume motion') : 'Start Drift'}</button>{running && <button className="drift-stop" onClick={stopWallpaper}>Stop</button>}</div>
      </aside>
    </section>
  </main>;
}

function Toggle({ title, subtitle, enabled, onClick }) {
  return <div className="drift-toggle"><span><strong>{title}</strong><small>{subtitle}</small></span><button className={enabled ? 'on' : ''} onClick={onClick}><i /></button></div>;
}
