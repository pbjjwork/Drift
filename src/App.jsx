import React from 'react';
import { convertFileSrc, invoke } from '@tauri-apps/api/core';
import { emitTo, listen } from '@tauri-apps/api/event';
import { open } from '@tauri-apps/plugin-dialog';
import { disable, enable, isEnabled } from '@tauri-apps/plugin-autostart';
import { availableMonitors, getCurrentWindow } from '@tauri-apps/api/window';
import { WebviewWindow } from '@tauri-apps/api/webviewWindow';

const STORAGE_KEY = 'drift.settings.v1';
const SURFACE_PREFIX = 'wallpaper-';
const DEFAULTS = { path: '', name: '', fit: 'cover', muted: true, loop: true, playing: true, monitorIndex: 0, displayMode: 'single', displayScenes: {} };
const readSettings = () => { try { return { ...DEFAULTS, ...JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}') }; } catch { return DEFAULTS; } };
const nameFromPath = (path = '') => path.split(/[\\/]/).pop() || '';
const surfaceLabel = (index) => `${SURFACE_PREFIX}${index}`;
const monitorTitle = (monitor, index) => monitor?.name || monitor?.deviceName || `Display ${index + 1}`;
const sceneFor = (settings, index) => settings.displayMode === 'individual' ? { path: '', name: '', fit: settings.fit, muted: settings.muted, loop: settings.loop, ...settings.displayScenes?.[index] } : settings;

export default function App() {
  const [settings, setSettings] = React.useState(readSettings);
  const settingsRef = React.useRef(settings);
  const launchHandledRef = React.useRef(false);
  const [monitors, setMonitors] = React.useState([]);
  const [running, setRunning] = React.useState(false);
  const [launchAtLogin, setLaunchAtLogin] = React.useState(false);
  const [desktopProtection, setDesktopProtection] = React.useState(false);
  const [notice, setNotice] = React.useState('Choose a video to turn your desktop into a living scene.');

  const persist = React.useCallback((next) => { settingsRef.current = next; setSettings(next); localStorage.setItem(STORAGE_KEY, JSON.stringify(next)); }, []);
  const targetIndexes = React.useCallback((config = settingsRef.current, displayList = monitors) => config.displayMode === 'single' ? [Math.min(config.monitorIndex || 0, Math.max(0, displayList.length - 1))] : displayList.map((_, index) => index), [monitors]);
  const syncSurfaces = React.useCallback(async (next) => { await Promise.all(targetIndexes(next).map((index) => emitTo(surfaceLabel(index), 'drift://settings', { ...next, surfaceMonitorIndex: index }).catch(() => {}))); }, [targetIndexes]);
  const update = (patch) => { const next = { ...settingsRef.current, ...patch }; persist(next); if (running) syncSurfaces(next); };
  const destroySurfaces = React.useCallback(async (displayList = monitors) => { await Promise.all([WebviewWindow.getByLabel('wallpaper').then((surface) => surface?.destroy()).catch(() => {}), ...displayList.map((_, index) => WebviewWindow.getByLabel(surfaceLabel(index)).then((surface) => surface?.destroy()).catch(() => {}))]); }, [monitors]);
  const stopWallpaper = React.useCallback(async () => { await destroySurfaces(); setRunning(false); setNotice('Wallpaper stopped. Your scenes are still saved.'); }, [destroySurfaces]);

  const startWallpaper = React.useCallback(async (override) => {
    const config = { ...settingsRef.current, ...(override || {}), playing: true };
    let displays = monitors;
    if (!displays.length) displays = await invoke('get_monitors').catch(() => availableMonitors());
    const indexes = targetIndexes(config, displays);
    if (indexes.some((index) => !sceneFor(config, index).path)) {
      setNotice(config.displayMode === 'individual' ? 'Choose a video for every display first.' : 'Choose a video first.');
      return;
    }
    persist(config);
    await destroySurfaces(displays);
    await Promise.all(indexes.map(async (index) => {
      const monitor = displays[index];
      if (!monitor) return;
      const scale = monitor.scaleFactor || 1;
      const size = monitor.size || { width: window.screen.width, height: window.screen.height };
      const position = monitor.position || { x: 0, y: 0 };
      const logical = monitor.dimensionsAreLogical === true;
      const surface = new WebviewWindow(surfaceLabel(index), {
        url: `index.html#/wallpaper?display=${index}`,
        x: logical ? position.x : position.x / scale,
        y: logical ? position.y : position.y / scale,
        width: logical ? size.width : size.width / scale,
        height: logical ? size.height : size.height / scale,
        decorations: false, shadow: false, resizable: false, focus: false, focusable: false,
        skipTaskbar: true, alwaysOnBottom: true, visibleOnAllWorkspaces: true, backgroundColor: '#000000',
      });
      surface.once('tauri://created', async () => {
        await Promise.all([surface.setAlwaysOnBottom(true), surface.setVisibleOnAllWorkspaces(true), surface.setIgnoreCursorEvents(true), surface.setSkipTaskbar(true)]).catch(() => {});
        setTimeout(() => emitTo(surfaceLabel(index), 'drift://settings', { ...config, surfaceMonitorIndex: index }).catch(() => {}), 250);
      });
      surface.once('tauri://error', (event) => setNotice(`Could not start on ${monitorTitle(monitor, index)}: ${event.payload || 'window failed to open'}`));
    }));
    setRunning(true);
    setNotice(indexes.length > 1 ? `Drift is running across ${indexes.length} displays.` : `Drift is running on ${monitorTitle(displays[indexes[0]], indexes[0])}.`);
  }, [destroySurfaces, monitors, persist, targetIndexes]);

  const changeDisplaySetup = async (patch) => { const next = { ...settingsRef.current, ...patch }; persist(next); if (running) await startWallpaper(next); };

  React.useEffect(() => {
    let disposed = false;
    const loadMonitors = async () => {
      let displayList = await invoke('get_monitors').catch(() => []);
      if (!displayList?.length) displayList = await availableMonitors().catch(() => []);
      if (!disposed) setMonitors(displayList || []);
      return displayList || [];
    };
    Promise.all([loadMonitors(), isEnabled(), invoke('get_click_protection')]).then(async ([displayList, autostart, protectedDesktop]) => {
      if (disposed) return;
      setLaunchAtLogin(Boolean(autostart)); setDesktopProtection(Boolean(protectedDesktop));
      const surfaces = await Promise.all(displayList.map((_, index) => WebviewWindow.getByLabel(surfaceLabel(index))));
      if (!disposed) setRunning(surfaces.some(Boolean));
    }).catch(() => {});
    let disposers = [];
    Promise.all([listen('drift://toggle', () => update({ playing: !settingsRef.current.playing })), listen('drift://stop', stopWallpaper)]).then((values) => { disposers = values; });
    if (!launchHandledRef.current) {
      launchHandledRef.current = true;
      invoke('is_autostart_launch').then(async () => {
        const config = settingsRef.current;
        if (config.path || Object.values(config.displayScenes || {}).some((scene) => scene?.path)) await startWallpaper();
        await getCurrentWindow().hide();
      }).catch(() => {});
    }
    return () => { disposed = true; disposers.forEach((dispose) => dispose()); };
  }, [startWallpaper, stopWallpaper]);

  const chooseVideo = async () => {
    const picked = await open({ multiple: false, directory: false, filters: [{ name: 'Video', extensions: ['mp4', 'mov', 'm4v', 'webm'] }] });
    if (!picked || Array.isArray(picked)) return;
    const current = settingsRef.current;
    const media = { path: picked, name: nameFromPath(picked), fit: current.fit, muted: current.muted, loop: current.loop };
    const next = current.displayMode === 'individual' ? { ...current, displayScenes: { ...current.displayScenes, [current.monitorIndex]: media }, playing: true } : { ...current, ...media, playing: true };
    persist(next); if (running) syncSurfaces(next);
    setNotice(current.displayMode === 'individual' ? `Scene saved for ${monitorTitle(monitors[current.monitorIndex], current.monitorIndex)}.` : 'Scene ready. Start Drift when the framing looks right.');
  };
  const toggleAutostart = async () => { if (launchAtLogin) await disable(); else await enable(); setLaunchAtLogin(!launchAtLogin); };
  const toggleProtection = async () => { const enabled = await invoke('set_click_protection', { enabled: !desktopProtection }); setDesktopProtection(Boolean(enabled)); setNotice(enabled ? 'Desktop protected. Wallpaper clicks will keep your windows in place.' : 'Standard macOS desktop reveal restored.'); };
  const previewScene = sceneFor(settings, settings.monitorIndex);
  const previewUrl = previewScene.path ? convertFileSrc(previewScene.path) : '';

  return <main className="drift-app"><div className="drift-app__glow" />
    <header className="drift-header" data-tauri-drag-region><div className="drift-brand" data-tauri-drag-region><span>≈</span><div><strong>Drift</strong><small>MOTION WALLPAPER</small></div></div><div className={`drift-live ${running ? 'is-live' : ''}`}><i />{running ? 'RUNNING' : 'READY'}</div></header>
    <section className="drift-layout">
      <div className="drift-preview-card"><div className="drift-section-title"><span>DESKTOP PREVIEW</span><strong>{settings.displayMode === 'all' ? 'All displays' : monitorTitle(monitors[settings.monitorIndex], settings.monitorIndex)}</strong></div><div className="drift-preview">{previewUrl ? <video src={previewUrl} autoPlay muted loop playsInline style={{ objectFit: previewScene.fit || settings.fit }} /> : <button onClick={chooseVideo}><b>＋</b><strong>Choose a scene</strong><small>MP4, MOV, M4V or WebM</small></button>}<div className="drift-preview__shade" /><div className="drift-preview__dock"><i/><i/><i/><i/><i/></div></div><p>{notice}</p></div>
      <aside className="drift-controls">
        <div className="drift-section-title"><span>SCENE</span><strong>{previewScene.name || 'No video selected'}</strong></div>
        <div className="drift-display-modes"><button className={settings.displayMode === 'single' ? 'active' : ''} onClick={() => changeDisplaySetup({ displayMode: 'single' })}><strong>One</strong><small>Selected</small></button><button className={settings.displayMode === 'all' ? 'active' : ''} onClick={() => changeDisplaySetup({ displayMode: 'all' })}><strong>All</strong><small>Same scene</small></button><button className={settings.displayMode === 'individual' ? 'active' : ''} onClick={() => changeDisplaySetup({ displayMode: 'individual' })}><strong>Custom</strong><small>Per display</small></button></div>
        <label className="drift-select"><span>{settings.displayMode === 'individual' ? 'EDIT DISPLAY' : 'DISPLAY'}</span><select value={settings.monitorIndex} disabled={settings.displayMode === 'all'} onChange={(event) => changeDisplaySetup({ monitorIndex: Number(event.target.value) })}>{(monitors.length ? monitors : [{ name: 'Main display' }]).map((monitor, index) => <option key={`${monitor.name}-${index}`} value={index}>{monitorTitle(monitor, index)}{monitor.isPrimary ? ' · Primary' : ''}</option>)}</select></label>
        <button className="drift-file" onClick={chooseVideo}><span>▶</span><div><strong>{previewScene.name || 'Choose video'}</strong><small>{settings.displayMode === 'individual' ? `For ${monitorTitle(monitors[settings.monitorIndex], settings.monitorIndex)}` : (previewScene.path ? 'Click to replace' : 'Select a local file')}</small></div><b>Browse</b></button>
        {settings.displayMode === 'individual' && <div className="drift-display-scenes">{monitors.map((monitor, index) => <button key={index} className={index === settings.monitorIndex ? 'active' : ''} onClick={() => changeDisplaySetup({ monitorIndex: index })}><i className={settings.displayScenes?.[index]?.path ? 'ready' : ''}/><span><strong>{monitorTitle(monitor, index)}</strong><small>{settings.displayScenes?.[index]?.name || 'No scene selected'}</small></span></button>)}</div>}
        <div className="drift-segment"><button className={settings.fit === 'cover' ? 'active' : ''} onClick={() => update({ fit: 'cover' })}><strong>Fill</strong><small>Crop edges</small></button><button className={settings.fit === 'contain' ? 'active' : ''} onClick={() => update({ fit: 'contain' })}><strong>Fit</strong><small>Show everything</small></button></div>
        <Toggle title="Loop continuously" subtitle="Restart when the video ends" enabled={settings.loop} onClick={() => update({ loop: !settings.loop })} /><Toggle title="Mute wallpaper" subtitle="Keep your desktop quiet" enabled={settings.muted} onClick={() => update({ muted: !settings.muted })} /><Toggle title="Open at login" subtitle="Start Drift when you sign in" enabled={launchAtLogin} onClick={toggleAutostart} /><Toggle title="Keep windows in place" subtitle="Disable click-to-reveal desktop" enabled={desktopProtection} onClick={toggleProtection} />
        <div className="drift-actions"><button className="drift-primary" onClick={running ? () => update({ playing: !settings.playing }) : () => startWallpaper()}>{running ? (settings.playing ? 'Pause motion' : 'Resume motion') : 'Start Drift'}</button>{running && <button className="drift-stop" onClick={stopWallpaper}>Stop</button>}</div>
      </aside>
    </section>
  </main>;
}

function Toggle({ title, subtitle, enabled, onClick }) { return <div className="drift-toggle"><span><strong>{title}</strong><small>{subtitle}</small></span><button className={enabled ? 'on' : ''} onClick={onClick}><i /></button></div>; }
