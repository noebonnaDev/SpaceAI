import { en } from './en';
import { it, type Dict } from './it';

type DeepPartial<T> = { [K in keyof T]?: T[K] extends object ? (T[K] extends unknown[] ? T[K] : DeepPartial<T[K]>) : T[K] };

const dictionaries: Record<string, DeepPartial<Dict>> = { it, en };

/** Italian is the default; other languages fall back to Italian for missing keys. */
let current = 'it';

export function setLanguage(lang: string): void {
  current = dictionaries[lang] ? lang : 'it';
  document.documentElement.lang = current;
}

export function language(): string {
  return current;
}

function lookup(dict: unknown, path: string[]): unknown {
  let node = dict;
  for (const p of path) {
    if (node && typeof node === 'object' && p in (node as Record<string, unknown>)) node = (node as Record<string, unknown>)[p];
    else return undefined;
  }
  return node;
}

/** Translates "section.key" with {placeholders}. */
export function t(key: string, vars?: Record<string, string | number>): string {
  const path = key.split('.');
  let value = lookup(dictionaries[current], path);
  if (typeof value !== 'string') value = lookup(it, path);
  if (typeof value !== 'string') return key;
  return vars ? value.replace(/\{(\w+)\}/g, (_, k) => (k in vars ? String(vars[k]) : `{${k}}`)) : value;
}

/** Non-string entries (arrays, e.g. weekday names). */
export function tList(key: string): string[] {
  const value = lookup(dictionaries[current], key.split('.')) ?? lookup(it, key.split('.'));
  return Array.isArray(value) ? (value as string[]) : [];
}
