// Web search helpers (DuckDuckGo first, Bing fallback). Extracted from index.ts.
const UA = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";
export const BROWSER_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36";

export function stripTags(s: string): string {
  return s
    .replace(/<[^>]+>/g, "")
    .replace(/&quot;/g, '"')
    .replace(/&#x27;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/\s+/g, " ")
    .trim();
}

export async function ddgSearch(query: string): Promise<Array<{ title: string; href: string; body: string }>> {
  const url = "https://html.duckduckgo.com/html/?q=" + encodeURIComponent(query);
  const res = await fetch(url, { headers: { "User-Agent": UA } });
  const html = await res.text();
  const results: Array<{ title: string; href: string; body: string }> = [];
  const blocks = html.split(/class="result results_links/);
  for (const b of blocks.slice(1)) {
    const m = b.match(/class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/);
    const s = b.match(/class="result__snippet"[^>]*>([\s\S]*?)<\/a>/);
    if (m) {
      let href = m[1];
      const ud = href.match(/uddg=([^&]+)/);
      if (ud) href = decodeURIComponent(ud[1]);
      results.push({ title: stripTags(m[2]), href, body: s ? stripTags(s[1]) : "" });
    }
    if (results.length >= 6) break;
  }
  return results;
}

// Bing wraps result links as /ck/a?...&u=a1<base64url(real url)>. (Was defined in index.ts but never exported -> the Bing fallback threw ReferenceError silently.)
export function bingDecode(href: string): string {
  const m = href.match(/[?&]u=a1([^&]+)/);
  if (!m) return href;
  try {
    let b = m[1].replace(/-/g, "+").replace(/_/g, "/");
    while (b.length % 4) b += "=";
    const bin = atob(b);
    return new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0)));
  } catch {
    return href;
  }
}

export async function bingSearch(query: string): Promise<Array<{ title: string; href: string; body: string }>> {
  const url = "https://www.bing.com/search?q=" + encodeURIComponent(query);
  const res = await fetch(url, { headers: { "User-Agent": UA } });
  const html = await res.text();
  const results: Array<{ title: string; href: string; body: string }> = [];
  const blocks = html.match(/<li class="b_algo"[\s\S]*?<\/li>/g) ?? [];
  for (const b of blocks) {
    const m = b.match(/<h2><a[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/);
    const s = b.match(/<p[^>]*>([\s\S]*?)<\/p>/);
    if (m) {
      results.push({ title: stripTags(m[2]), href: bingDecode(m[1].replace(/&amp;/g, "&")), body: s ? stripTags(s[1]) : "" });
    }
    if (results.length >= 6) break;
  }
  return results;
}

export async function webSearch(query: string): Promise<string> {
  let results = await ddgSearch(query).catch(() => [] as Array<{ title: string; href: string; body: string }>);
  if (results.length === 0) {
    results = await bingSearch(query).catch(() => [] as Array<{ title: string; href: string; body: string }>);
  }
  return JSON.stringify(results, null, 0);
}
