import { useEffect } from 'react';

export const SITE_URL = 'https://cinema-elarab.vercel.app';
export const DEFAULT_TITLE = 'سينما العرب | عالم من الحكايات';
export const DEFAULT_DESCRIPTION = 'سينما العرب — اكتشف مجموعة مختارة من الأفلام والمسلسلات في تجربة عربية أنيقة.';

function setMeta(selector, attributes) {
  if (typeof document === 'undefined') return;
  let element = document.head.querySelector(selector);
  if (!element) {
    element = document.createElement('meta');
    document.head.appendChild(element);
  }
  for (const [key, value] of Object.entries(attributes)) {
    element.setAttribute(key, value);
  }
}

function setCanonical(href) {
  if (typeof document === 'undefined') return;
  let link = document.head.querySelector('link[rel="canonical"]');
  if (!link) {
    link = document.createElement('link');
    link.setAttribute('rel', 'canonical');
    document.head.appendChild(link);
  }
  link.setAttribute('href', href);
}

export function usePageSeo({
  title = DEFAULT_TITLE,
  description = DEFAULT_DESCRIPTION,
  path = '/',
  noindex = false,
} = {}) {
  useEffect(() => {
    document.title = title;
    const canonicalUrl = `${SITE_URL}${path.startsWith('/') ? path : `/${path}`}`;
    setMeta('meta[name="description"]', { name: 'description', content: description });
    setMeta('meta[property="og:title"]', { property: 'og:title', content: title });
    setMeta('meta[property="og:description"]', { property: 'og:description', content: description });
    setMeta('meta[property="og:url"]', { property: 'og:url', content: canonicalUrl });
    setMeta('meta[name="robots"]', { name: 'robots', content: noindex ? 'noindex, nofollow' : 'index, follow' });
    setCanonical(canonicalUrl);
  }, [title, description, path, noindex]);
}
