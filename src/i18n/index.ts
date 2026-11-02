import IntlMessageFormat from "intl-messageformat";
import en from "./en.json";
import ja from "./ja.json";
import zhCN from "./zh-CN.json";

export type Locale = "ja" | "zh-CN" | "en";

type Catalog = Record<string, string>;

/** Message catalogs, keyed by locale. English is the source language. */
const catalogs: Record<Locale, Catalog> = {
  ja: ja as Catalog,
  "zh-CN": zhCN as Catalog,
  en: en as Catalog,
};

const FALLBACK: Locale = "en";

/** Languages offered by the UI, in switching order. */
export const LOCALES: Locale[] = ["ja", "zh-CN", "en"];

/** Each language named in itself, the usual convention for a language menu. */
export const NATIVE_NAMES: Record<Locale, string> = {
  ja: "日本語",
  "zh-CN": "中文",
  en: "English",
};

const STORAGE_KEY = "vn.locale";

function isLocale(value: string | null | undefined): value is Locale {
  return !!value && Object.prototype.hasOwnProperty.call(catalogs, value);
}

/** Region-less matching: zh-Hans-CN -> zh-CN, en-US -> en. */
function matchLocale(tag: string): Locale | null {
  if (isLocale(tag)) return tag;
  const base = tag.split("-")[0].toLowerCase();
  const hit = LOCALES.find((locale) => locale.split("-")[0].toLowerCase() === base);
  return hit ?? null;
}

/** `?lang=` wins, then the last choice, then the browser preferences. */
export function initialLocale(): Locale {
  const fromQuery = new URLSearchParams(window.location.search).get("lang");
  const candidates = [
    fromQuery,
    window.localStorage.getItem(STORAGE_KEY),
    ...(navigator.languages ?? [navigator.language]),
  ];

  for (const candidate of candidates) {
    if (!candidate) continue;
    const hit = matchLocale(candidate);
    if (hit) return hit;
  }

  return "ja"; // the story itself is Japanese
}

let active: Locale = initialLocale();
const formatters = new Map<string, IntlMessageFormat>();

/**
 * The active catalog is a module value: components call `t()` directly, so the
 * app sets it once per render and the strings follow.
 */
export function setLocale(locale: Locale): void {
  active = locale;
}

export function getLocale(): Locale {
  return active;
}

export function rememberLocale(locale: Locale): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, locale);
  } catch {
    // private mode / storage disabled: switching still works for this session
  }
}

/** Translate a key with ICU MessageFormat (interpolation + plurals). */
export function t(key: string, values?: Record<string, unknown>): string {
  const cacheKey = `${active}\u0000${key}`;
  let formatter = formatters.get(cacheKey);

  if (!formatter) {
    const message = catalogs[active][key] ?? catalogs[FALLBACK][key] ?? key;
    formatter = new IntlMessageFormat(message, active);
    formatters.set(cacheKey, formatter);
  }

  return String(formatter.format(values));
}
