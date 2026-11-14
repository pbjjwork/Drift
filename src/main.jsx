import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import WallpaperSurface from './WallpaperSurface';
import './styles.css';

const surface = window.location.hash.startsWith('#/wallpaper');
ReactDOM.createRoot(document.getElementById('root')).render(surface ? <WallpaperSurface /> : <App />);
