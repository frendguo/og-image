import { describe, expect, it, vi } from "vitest";
import satori from "satori";
import { createElement } from "preact";
import type { JSX } from "preact";
import { loadAdditionalAsset, renderSocialSvg } from "../src/emitter";
import { createCjkFontLoader } from "../src/cjk-font";

// 用 Google Fonts 取一份只含拉丁字形的字体，模拟站点配置的 Source Sans Pro（不含中文）
async function fetchLatinFont(): Promise<ArrayBuffer> {
  const css = await (
    await fetch("https://fonts.googleapis.com/css2?family=Source+Sans+3:wght@400")
  ).text();
  const url = css.match(/src: url\((.+?)\) format\('(?:opentype|truetype)'\)/)?.[1];
  if (!url) throw new Error("无法解析 Source Sans 3 字体地址");
  return await (await fetch(url)).arrayBuffer();
}

async function fetchGoogleTtf(family: string, weight: number): Promise<ArrayBuffer> {
  const css = await (
    await fetch(`https://fonts.googleapis.com/css2?family=${family}:wght@${weight}`)
  ).text();
  const url = css.match(/src: url\((.+?)\) format\('(?:opentype|truetype)'\)/)?.[1];
  if (!url) throw new Error(`无法解析 ${family} 字体地址`);
  return await (await fetch(url)).arrayBuffer();
}

async function renderText(text: string, latin: ArrayBuffer): Promise<string> {
  return await satori(
    createElement(
      "div",
      { style: { display: "flex", fontFamily: "Source Sans 3", fontSize: 72 } },
      text,
    ) as Parameters<typeof satori>[0],
    {
      width: 400,
      height: 120,
      fonts: [{ name: "Source Sans 3", data: latin, weight: 400, style: "normal" }],
      loadAdditionalAsset,
    },
  );
}

describe("og-image 中文渲染（复现分享卡片豆腐块）", () => {
  it("不同汉字应渲染出不同字形，而不是同一个 .notdef 豆腐块", async () => {
    const latin = await fetchLatinFont();
    const a = await renderText("知", latin);
    const b = await renderText("识", latin);
    // 缺字时两字都会被画成同一个方框，SVG 完全相同
    expect(a).not.toEqual(b);
  }, 60_000);
});

describe("og-image 同页多次回退（标点与汉字分属不同语言码）", () => {
  it("同一页先回退了全角标点，汉字仍应正常渲染（站点真实字体与卡片结构）", async () => {
    // 与 emitter 的 getSatoriFonts 一致：站点配置的 header/body 字体
    const fonts = [
      {
        name: "Schibsted Grotesk",
        data: await fetchGoogleTtf("Schibsted+Grotesk", 700),
        weight: 700 as const,
        style: "normal" as const,
      },
      {
        name: "Source Sans Pro",
        data: await fetchGoogleTtf("Source+Sans+Pro", 400),
        weight: 400 as const,
        style: "normal" as const,
      },
    ];
    // satori 会把「、。」与汉字拆成两次 loadAdditionalAsset 调用（语言码不同），
    // 两次返回的子集字体若同名同字重，会被去重成只含标点的那份，汉字变豆腐块
    const render = (han: string) =>
      renderSocialSvg(
        createElement(
          "div",
          { style: { display: "flex", flexDirection: "column", fontFamily: "Source Sans Pro" } },
          createElement(
            "div",
            { style: { fontFamily: "Schibsted Grotesk", fontWeight: 700, fontSize: 72 } },
            `AI ${han}`,
          ),
          createElement("p", { style: { fontSize: 32 } }, "AI 工具、Claude Code 与智能体。"),
        ) as unknown as JSX.Element,
        { width: 1200, height: 630, fonts },
      );
    const a = await render("知");
    const b = await render("识");
    expect(a).not.toEqual(b);
  }, 60_000);
});

describe("og-image 多页共用同一 fonts 数组（真实构建路径）", () => {
  it("先渲染过其他汉字后，新汉字仍应渲染出不同字形", async () => {
    const latin = await fetchLatinFont();
    // 模拟 emitter：所有页面共用同一个 fonts 数组
    const fonts = [
      { name: "Source Sans 3", data: latin, weight: 400 as const, style: "normal" as const },
    ];
    const render = (text: string) =>
      renderSocialSvg(
        createElement(
          "div",
          { style: { display: "flex", fontFamily: "Source Sans 3", fontSize: 72 } },
          text,
        ) as unknown as JSX.Element,
        { width: 400, height: 120, fonts },
      );
    await render("知识库"); // 第一页
    const a = await render("房"); // 后续页面出现的新字
    const b = await render("屋");
    expect(a).not.toEqual(b);
  }, 60_000);
});

describe("createCjkFontLoader", () => {
  const fakeCss = (weight: number) =>
    `@font-face { font-weight: ${weight}; src: url(https://fonts.gstatic.com/l/font?kit=w${weight}) format('truetype'); }`;

  function makeFetch() {
    return vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.startsWith("https://fonts.googleapis.com/")) {
        const css = [400, 700].map(fakeCss).join("\n");
        return new Response(css, { status: 200 });
      }
      return new Response(new Uint8Array([1, 2, 3]), { status: 200 });
    });
  }

  it.each(["zh-CN", "zh-TW", "zh-HK", "ja-JP", "unknown", "ja-JP|zh-CN|zh-TW|zh-HK"])(
    "%s 返回 Noto Sans SC 的 400/700 两个字重",
    async (code) => {
      const fetchImpl = makeFetch();
      const load = createCjkFontLoader(fetchImpl as unknown as typeof fetch);
      const fonts = await load(code, "知识库");
      expect(Array.isArray(fonts)).toBe(true);
      const list = fonts as Array<{ name: string; weight: number }>;
      expect(list.map((f) => f.weight).sort()).toEqual([400, 700]);
      expect(list.every((f) => f.name.startsWith("Noto Sans SC"))).toBe(true);
      const cssUrl = String(fetchImpl.mock.calls[0]![0]);
      expect(cssUrl).toContain("family=Noto+Sans+SC");
      expect(cssUrl).toContain(`text=${encodeURIComponent("知识库")}`);
    },
  );

  it("ko-KR 使用 Noto Sans KR", async () => {
    const fetchImpl = makeFetch();
    const load = createCjkFontLoader(fetchImpl as unknown as typeof fetch);
    const fonts = (await load("ko-KR", "한국어")) as Array<{ name: string }>;
    expect(fonts[0]!.name.startsWith("Noto Sans KR")).toBe(true);
  });

  it("非 CJK 语言码返回 null（交由调用方回退）", async () => {
    const fetchImpl = makeFetch();
    const load = createCjkFontLoader(fetchImpl as unknown as typeof fetch);
    expect(await load("th-TH", "สวัสดี")).toBeNull();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("不同片段的子集字体名互不相同（避免 satori 按名+字重去重）", async () => {
    const fetchImpl = makeFetch();
    const load = createCjkFontLoader(fetchImpl as unknown as typeof fetch);
    const a = (await load("zh-CN", "、。")) as Array<{ name: string }>;
    const b = (await load("zh-CN", "知识库")) as Array<{ name: string }>;
    expect(a[0]!.name).not.toBe(b[0]!.name);
    expect(a[0]!.name.startsWith("Noto Sans SC")).toBe(true);
  });

  it("相同片段只请求一次（缓存）", async () => {
    const fetchImpl = makeFetch();
    const load = createCjkFontLoader(fetchImpl as unknown as typeof fetch);
    await load("zh-CN", "知识库");
    const calls = fetchImpl.mock.calls.length;
    await load("zh-CN", "知识库");
    expect(fetchImpl.mock.calls.length).toBe(calls);
  });

  it("网络失败时返回 null 而不是抛错，避免整站构建失败", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error("network down");
    });
    const load = createCjkFontLoader(fetchImpl as unknown as typeof fetch);
    expect(await load("zh-CN", "知识库")).toBeNull();
  });
});
