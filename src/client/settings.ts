// Persisted client settings (localStorage).

export type Quality = 'low' | 'medium' | 'high';

export interface Settings {
  name: string;
  sensitivity: number;
  adsSensitivity: number;
  fov: number;
  quality: Quality;
  master: number;
  music: number;
  sfx: number;
  toggleSprint: boolean;
  toggleCrouch: boolean;
  invertY: boolean;
  showFps: boolean;
  autoSprint: boolean;
  // touch & controller
  touchSensitivity: number;
  buttonScale: number;
  buttonOpacity: number;
  aimAssist: number; // 0 = off .. 1 = full (touch + gamepad only)
  autoFire: boolean; // touch only
  vibration: boolean;
  fullscreen: boolean; // enter fullscreen + lock landscape when a match starts (touch)
  // performance
  dynamicRes: boolean;
  fpsCap: number; // 0 = display rate
}

const KEY = 'surgefall.settings.v1';
const isMobile = typeof navigator !== 'undefined' && (/Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent) || (navigator.maxTouchPoints > 1 && !matchMedia('(pointer: fine)').matches));

export const DEFAULT_SETTINGS: Settings = {
  name: '',
  sensitivity: 1,
  adsSensitivity: 0.7,
  fov: 80,
  quality: isMobile ? 'low' : 'high',
  master: 0.8,
  music: 0.5,
  sfx: 0.9,
  toggleSprint: false,
  toggleCrouch: false,
  invertY: false,
  showFps: false,
  autoSprint: false,
  touchSensitivity: 1,
  buttonScale: 1,
  buttonOpacity: 0.85,
  aimAssist: 0.7,
  autoFire: false,
  vibration: true,
  fullscreen: true,
  dynamicRes: isMobile,
  fpsCap: 0,
};

export const IS_MOBILE = isMobile;
/** The device has a touch screen (phones, tablets, touch laptops). */
export const HAS_TOUCH = typeof window !== 'undefined' && ('ontouchstart' in window || navigator.maxTouchPoints > 0);

export function loadSettings(): Settings {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) return { ...DEFAULT_SETTINGS, ...JSON.parse(raw) };
  } catch {
    /* storage unavailable */
  }
  return { ...DEFAULT_SETTINGS };
}

export function saveSettings(s: Settings) {
  try {
    localStorage.setItem(KEY, JSON.stringify(s));
  } catch {
    /* ignore */
  }
}

// Online and offline (in-browser server) profiles are separate, so each keeps its own token.
const tokenKey = (offline: boolean) => (offline ? 'surgefall.offline.token' : 'surgefall.token');

export function loadToken(offline = false): string | null {
  try {
    return localStorage.getItem(tokenKey(offline));
  } catch {
    return null;
  }
}

export function saveToken(t: string, offline = false) {
  try {
    localStorage.setItem(tokenKey(offline), t);
  } catch {
    /* ignore */
  }
}
