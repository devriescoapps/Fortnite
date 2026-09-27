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
};

export const IS_MOBILE = isMobile;

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

export function loadToken(): string | null {
  try {
    return localStorage.getItem('surgefall.token');
  } catch {
    return null;
  }
}

export function saveToken(t: string) {
  try {
    localStorage.setItem('surgefall.token', t);
  } catch {
    /* ignore */
  }
}
