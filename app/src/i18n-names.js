/** app/src/i18n-names.js - every language the app knows: its name in that language. */

export const LANG_NAMES = {
  en: 'English', es: 'Español', 'zh-Hans': '简体中文', 'zh-Hant': '繁體中文', vi: 'Tiếng Việt', ko: '한국어', tl: 'Tagalog',
  ja: '日本語', hi: 'हिन्दी', bn: 'বাংলা', pa: 'ਪੰਜਾਬੀ', gu: 'ગુજરાતી', ur: 'اردو', ar: 'العربية', fa: 'فارسی', he: 'עברית',
  ru: 'Русский', uk: 'Українська', pl: 'Polski', ht: 'Kreyòl ayisyen', fr: 'Français', pt: 'Português', de: 'Deutsch', it: 'Italiano',
  so: 'Soomaali', am: 'አማርኛ', km: 'ខ្មែរ', lo: 'ລາວ', hmn: 'Hmoob', my: 'မြန်မာ', ne: 'नेपाली', sw: 'Kiswahili', tr: 'Türkçe', nv: 'Diné bizaad',
};

/** The closest available language for a browser language tag (zh-TW → zh-Hant, es-MX → es). */
export function closestLang(tag, available) {
  const t = String(tag || '');
  if (available.includes(t)) return t;
  if (/^zh\b/i.test(t)) {
    const v = /-(TW|HK|MO|Hant)\b/i.test(t) ? 'zh-Hant' : 'zh-Hans';
    return available.includes(v) ? v : available.find((a) => a.startsWith('zh')) || null;
  }
  if (/^fil\b/i.test(t) && available.includes('tl')) return 'tl';
  const base = t.split('-')[0].toLowerCase();
  return available.includes(base) ? base : null;
}

