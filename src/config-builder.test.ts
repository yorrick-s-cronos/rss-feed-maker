import { describe, expect, test } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";
import {
  buildConfig,
  deriveConfigName,
  inferNumericDateFormat,
  sanitizeName,
  type ConfigGenerator,
} from "./config-builder.js";
import { extractJsonObject, prepareHtmlForLLM } from "./llm.js";
import type { FeedConfig } from "./types.js";

const URL_ = "https://aleph-alpha.com/en/blog/";
const ALEPH_HTML = readFileSync(
  join(import.meta.dir, "..", "test", "fixtures", "aleph-alpha-blog.html"),
  "utf-8"
);

function llmConfig(overrides: Partial<FeedConfig> = {}): FeedConfig {
  return {
    name: "aleph-alpha",
    url: URL_,
    feed: { title: "Aleph Alpha Blog", description: "Research", language: "en" },
    selectors: {
      articleList: "main ul > li",
      title: "h3",
      date: "p > span:last-child",
      link: { source: "attr:href", prefix: "https://aleph-alpha.com" },
    },
    createdAt: "2026-10-08T00:00:00.000Z",
    ...overrides,
  };
}

/** Fake LLM: returns the queued configs in order and records the feedback it got. */
function fakeGenerator(...configs: FeedConfig[]) {
  const feedback: (string | undefined)[] = [];
  const generate: ConfigGenerator = async (_url, _html, fb) => {
    feedback.push(fb);
    const next = configs.shift();
    if (!next) throw new Error("fake generator exhausted");
    return structuredClone(next);
  };
  return { generate, feedback };
}

describe("inferNumericDateFormat", () => {
  test("day-first when a first number is above 12", () => {
    expect(inferNumericDateFormat(["08/10/2026", "30/09/2026"])).toBe("dd/MM/yyyy");
    expect(inferNumericDateFormat(["24.09.2026", "08.09.2026"])).toBe("dd.MM.yyyy");
  });

  test("month-first when a second number is above 12", () => {
    expect(inferNumericDateFormat(["10/08/2026", "09/30/2026"])).toBe("MM/dd/yyyy");
  });

  test("finds the date inside surrounding text", () => {
    expect(inferNumericDateFormat(["Research 30/09/2026", "Research08/10/2026"])).toBe("dd/MM/yyyy");
  });

  test("undefined when ambiguous, contradictory or not numeric", () => {
    expect(inferNumericDateFormat(["08/10/2026", "01/02/2026"])).toBeUndefined();
    expect(inferNumericDateFormat(["30/09/2026", "09/30/2026"])).toBeUndefined();
    expect(inferNumericDateFormat(["October 8, 2026", "September 30, 2026"])).toBeUndefined();
    expect(inferNumericDateFormat(["2026-10-08", "2026-09-30"])).toBeUndefined();
    expect(inferNumericDateFormat([undefined, ""])).toBeUndefined();
  });
});

describe("buildConfig", () => {
  test("a correct LLM config is accepted as-is", async () => {
    const { generate } = fakeGenerator(llmConfig({ dateFormat: "dd/MM/yyyy" }));
    const { config, articles } = await buildConfig(URL_, ALEPH_HTML, { generate });
    expect(config.dateFormat).toBe("dd/MM/yyyy");
    expect(articles).toHaveLength(10);
    expect(articles[0].date?.toISOString()).toBe("2026-10-08T00:00:00.000Z");
  });

  test("the listing overrides a wrong or missing day/month order", async () => {
    for (const dateFormat of ["MM/dd/yyyy", undefined]) {
      const { generate } = fakeGenerator(llmConfig({ dateFormat }));
      const { config, articles } = await buildConfig(URL_, ALEPH_HTML, { generate });
      expect(config.dateFormat).toBe("dd/MM/yyyy");
      expect(articles.map((a) => a.date?.toISOString().slice(0, 10)).slice(0, 5)).toEqual([
        "2026-10-08", "2026-10-07", "2026-10-06", "2026-10-03", "2026-09-30",
      ]);
    }
  });

  test("a textual dateFormat is left byte-identical", async () => {
    const html =
      "<html><body><main><ul>" +
      ["October 8, 2026", "September 30, 2026", "September 24, 2026"]
        .map((d, i) => `<li><a href="/p${i}/"><h3>Post ${i}</h3><time>${d}</time></a></li>`)
        .join("") +
      "</ul></main></body></html>";
    const { generate } = fakeGenerator(
      llmConfig({
        url: "https://example.com/blog",
        dateFormat: "MMMM d, yyyy",
        selectors: { articleList: "main li", title: "h3", date: "time", link: { source: "attr:href" } },
      })
    );
    const { config, articles } = await buildConfig("https://example.com/blog", html, { generate });
    expect(config.dateFormat).toBe("MMMM d, yyyy");
    expect(articles[1].date?.toISOString()).toBe("2026-09-30T00:00:00.000Z");
  });

  test("selectors that match nothing are fed back to the LLM", async () => {
    const { generate, feedback } = fakeGenerator(
      llmConfig({ selectors: { articleList: ".does-not-exist", title: "h3", link: { source: "attr:href" } } }),
      llmConfig({ dateFormat: "dd/MM/yyyy" })
    );
    const { articles } = await buildConfig(URL_, ALEPH_HTML, { generate });
    expect(articles).toHaveLength(10);
    expect(feedback[0]).toBeUndefined();
    expect(feedback[1]).toContain("produced 0 articles");
  });

  test("gives up after the configured number of attempts", async () => {
    const broken = llmConfig({ selectors: { articleList: ".nope", title: "h3", link: { source: "attr:href" } } });
    const { generate } = fakeGenerator(broken, broken);
    await expect(buildConfig(URL_, ALEPH_HTML, { generate, attempts: 2 })).rejects.toThrow(
      "after 2 attempts"
    );
  });

  test("the LLM cannot change the URL, escape configs/ or pick odd modes", async () => {
    const { generate } = fakeGenerator(
      llmConfig({
        name: "../../src/Evil Name!",
        url: "https://attacker.example/",
        parserMode: "github-releases",
        dateFormat: "dd/MM/yyyy",
      })
    );
    const { config } = await buildConfig(URL_, ALEPH_HTML, { generate });
    expect(config.url).toBe(URL_);
    expect(config.name).toBe("src-evil-name");
    expect(config.parserMode).toBe("css");
  });
});

describe("names", () => {
  test("sanitizeName", () => {
    expect(sanitizeName("Aleph Alpha")).toBe("aleph-alpha");
    expect(sanitizeName("../x")).toBe("x");
    expect(sanitizeName(undefined)).toBe("");
  });

  test("deriveConfigName", () => {
    expect(deriveConfigName("https://aleph-alpha.com/en/blog/")).toBe("aleph-alpha-com");
    expect(deriveConfigName("https://www.humanlayer.dev/blog")).toBe("humanlayer-dev");
  });
});

describe("LLM helpers", () => {
  test("prepareHtmlForLLM keeps the listing and drops noise", () => {
    const page = prepareHtmlForLLM(ALEPH_HTML);
    expect(page.scope).toBe("main");
    expect(page.truncated).toBe(false);
    expect(page.title).toBe("Blog — Aleph Alpha");
    expect(page.lang).toBe("en");
    expect(page.html).toContain("/en/blog/specialized-llms-punch-above-their-weight/");
    expect(page.html).toContain("30/09/2026");
    expect(page.html).not.toContain("<svg");
    expect(page.html).not.toContain("srcset=");
    expect(page.html).not.toContain("data-astro-cid");
    expect(page.html.length).toBeLessThan(25_000);
  });

  test("prepareHtmlForLLM falls back to <body> without a useful <main>", () => {
    const page = prepareHtmlForLLM(
      '<html><body><main><p>Hi</p></main><div><a href="/a">a</a><a href="/b">b</a><a href="/c">c</a></div></body></html>'
    );
    expect(page.scope).toBe("body");
    expect(page.html).toContain('href="/c"');
  });

  test("extractJsonObject tolerates code fences and prose", () => {
    expect(extractJsonObject('{"a":1}')).toEqual({ a: 1 });
    expect(extractJsonObject('```json\n{"a":1}\n```')).toEqual({ a: 1 });
    expect(extractJsonObject('Here you go: {"a":{"b":2}} — done')).toEqual({ a: { b: 2 } });
    expect(() => extractJsonObject("OK")).toThrow("no JSON object");
  });
});
