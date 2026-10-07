// Globale Node-Namen, die die Module des Hauptprozesses erwarten (esbuild „inject“)
import { Buffer } from 'buffer';

export { Buffer };
export const setImmediate = (fn, ...args) => setTimeout(fn, 0, ...args);
