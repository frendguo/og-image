import { styleText } from "node:util";
import type { SatoriOptions } from "satori";

export type FallbackFonts = NonNullable<SatoriOptions["fonts"]>;

// satori 无 lang 提示时会把汉字判为 ja-JP（或组合码），故 CJK 码统一走简体中文字体；
// 全角标点等未命中任何语言的字符会以 "unknown" 回调，同样尝试 Noto Sans SC。
const FAMILY_BY_CODE: Record<string, string> = {
  "zh-CN": "Noto Sans SC",
  "zh-TW": "Noto Sans SC",
  "zh-HK": "Noto Sans SC",
  "ja-JP": "Noto Sans SC",
  unknown: "Noto Sans SC",
  "ko-KR": "Noto Sans KR",
};

const WEIGHTS = [400, 700] as const;

/**
 * 创建 CJK 回退字体加载器：用 Google Fonts 的 `text=` 参数按需取「只含该片段字符」的子集 TTF，
 * 每段只有几 KB。非 CJK 语言码或网络失败时返回 null，由调用方回退，不让构建失败。
 */
export function createCjkFontLoader(fetchImpl: typeof fetch = fetch) {
  const cache = new Map<string, Promise<FallbackFonts | null>>();
  let subsetSeq = 0;

  async function load(family: string, segment: string): Promise<FallbackFonts | null> {
    // 每个子集用独立字体名：satori 对同名同字重的字体只保留先加载的一份，
    // 同一页里「、。」与汉字分两次回调时，同名会导致汉字落到只含标点的子集而变豆腐块
    const subsetName = `${family} ${++subsetSeq}`;
    try {
      const cssUrl =
        `https://fonts.googleapis.com/css2?family=${family.replaceAll(" ", "+")}` +
        `:wght@${WEIGHTS.join(";")}&text=${encodeURIComponent(segment)}`;
      const cssRes = await fetchImpl(cssUrl);
      if (!cssRes.ok) throw new Error(`css ${cssRes.status}`);
      const css = await cssRes.text();

      const fonts: FallbackFonts = [];
      const blockRe = /@font-face\s*{([^}]*)}/g;
      for (const [, block] of css.matchAll(blockRe)) {
        const weight = Number(block?.match(/font-weight:\s*(\d+)/)?.[1]);
        const url = block?.match(/src:\s*url\((.+?)\)\s*format\('(?:truetype|opentype)'\)/)?.[1];
        if (!url || !WEIGHTS.includes(weight as (typeof WEIGHTS)[number])) continue;
        const fontRes = await fetchImpl(url);
        if (!fontRes.ok) throw new Error(`font ${fontRes.status}`);
        fonts.push({
          name: subsetName,
          data: await fontRes.arrayBuffer(),
          weight: weight as (typeof WEIGHTS)[number],
          style: "normal",
        });
      }
      return fonts.length > 0 ? fonts : null;
    } catch (err) {
      console.warn(
        styleText(
          "yellow",
          `Warning: Failed to load fallback font ${family} for "${segment}": ${String(err)}`,
        ),
      );
      return null;
    }
  }

  return async (languageCode: string, segment: string): Promise<FallbackFonts | null> => {
    // satori 对可能属于多种语言的字符会传组合码，如 "ja-JP|zh-CN|zh-TW|zh-HK"
    const family = languageCode
      .split("|")
      .map((code) => FAMILY_BY_CODE[code])
      .find((f): f is string => Boolean(f));
    if (!family) return null;
    const key = `${family}\u0000${segment}`;
    let pending = cache.get(key);
    if (!pending) {
      pending = load(family, segment);
      cache.set(key, pending);
    }
    return await pending;
  };
}

export const loadCjkFont = createCjkFontLoader();
