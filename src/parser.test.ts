import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";
import { parseArticles } from "./parser.js";
import type { FeedConfig } from "./types.js";

const ALEPH_HTML = readFileSync(
  join(import.meta.dir, "..", "test", "fixtures", "aleph-alpha-blog.html"),
  "utf-8"
);

// Dates exactly as shown on https://aleph-alpha.com/en/blog/ (DD/MM/YYYY).
const ALEPH_DATES = [
  "2026-10-08", "2026-10-07", "2026-10-06", "2026-10-03", "2026-09-30",
  "2026-09-28", "2026-09-24", "2026-09-10", "2026-09-08", "2026-08-08",
];

type ConfigOverrides = Omit<Partial<FeedConfig>, "selectors"> & {
  selectors?: Partial<FeedConfig["selectors"]>;
};

function config(overrides: ConfigOverrides = {}): FeedConfig {
  const { selectors, ...rest } = overrides;
  return {
    name: "test",
    url: "https://aleph-alpha.com/en/blog/",
    feed: { title: "Test", description: "", language: "en" },
    selectors: {
      articleList: "main ul > li",
      title: "h3",
      date: "p > span:last-child",
      link: { source: "attr:href", prefix: "https://aleph-alpha.com" },
      ...selectors,
    },
    createdAt: "2026-10-08T00:00:00.000Z",
    ...rest,
  };
}

function isoDates(articles: { date?: Date }[]): (string | undefined)[] {
  return articles.map((a) => a.date?.toISOString().slice(0, 10));
}

function card(date: string): string {
  return `<html><body><main><ul><li><a href="/p/"><h3>Post</h3><p>${date}</p></a></li></ul></main></body></html>`;
}

const ORIGINAL_TZ = process.env.TZ;
afterEach(() => {
  process.env.TZ = ORIGINAL_TZ;
});

describe("aleph-alpha listing (DD/MM/YYYY)", () => {
  test("dd/MM/yyyy gives the dates shown on the page", async () => {
    const articles = await parseArticles(ALEPH_HTML, config({ dateFormat: "dd/MM/yyyy" }));
    expect(articles).toHaveLength(10);
    expect(isoDates(articles)).toEqual(ALEPH_DATES);
    expect(articles[0]).toMatchObject({
      title: "Specialised LLMs punch above their weight",
      link: "https://aleph-alpha.com/en/blog/specialized-llms-punch-above-their-weight/",
      rawDate: "08/10/2026",
    });
  });

  test("finds the date inside surrounding text (category + date)", async () => {
    const articles = await parseArticles(
      ALEPH_HTML,
      config({ dateFormat: "dd/MM/yyyy", selectors: { date: "p" } })
    );
    expect(isoDates(articles)).toEqual(ALEPH_DATES);
  });

  test("finds a numeric date glued to other text", async () => {
    const [article] = await parseArticles(
      card("<span>Research</span><span>08/10/2026</span>"),
      config({ url: "https://example.com/", dateFormat: "dd/MM/yyyy", selectors: { date: "p", link: { source: "attr:href" } } })
    );
    expect(article.date?.toISOString()).toBe("2026-10-08T00:00:00.000Z");
  });

  test("dates are UTC midnight in any timezone", async () => {
    for (const tz of ["Europe/Brussels", "America/Los_Angeles", "Asia/Tokyo"]) {
      process.env.TZ = tz;
      const articles = await parseArticles(ALEPH_HTML, config({ dateFormat: "dd/MM/yyyy" }));
      expect(articles.map((a) => a.date?.toISOString())).toEqual(
        ALEPH_DATES.map((d) => `${d}T00:00:00.000Z`)
      );
    }
  });

  test("a wrong explicit format never falls back to a day/month guess", async () => {
    const articles = await parseArticles(ALEPH_HTML, config({ dateFormat: "MMMM d, yyyy" }));
    expect(isoDates(articles)).toEqual(new Array(10).fill(undefined));
  });
});

describe("date formats used by existing feeds", () => {
  const base = { url: "https://example.com/", selectors: { date: "p", link: { source: "attr:href" } } };

  test("MMMM d, yyyy with full and abbreviated month names", async () => {
    for (const text of ["October 8, 2026", "Oct 8, 2026"]) {
      const [a] = await parseArticles(card(text), config({ ...base, dateFormat: "MMMM d, yyyy" }));
      expect(a.date?.toISOString()).toBe("2026-10-08T00:00:00.000Z");
    }
  });

  test("MMMM d, yyyy inside surrounding words", async () => {
    const [a] = await parseArticles(
      card("Product · March 5, 2026"),
      config({ ...base, dateFormat: "MMMM d, yyyy" })
    );
    expect(a.date?.toISOString()).toBe("2026-03-05T00:00:00.000Z");
  });

  test("no format: ISO dates and timestamps keep their exact instant", async () => {
    process.env.TZ = "America/Los_Angeles";
    const [iso] = await parseArticles(card("2026-10-08"), config(base));
    expect(iso.date?.toISOString()).toBe("2026-10-08T00:00:00.000Z");
    const [stamp] = await parseArticles(card("2026-10-08T15:30:00Z"), config(base));
    expect(stamp.date?.toISOString()).toBe("2026-10-08T15:30:00.000Z");
  });

  test("no format: date-only text is UTC midnight in any timezone", async () => {
    for (const tz of ["UTC", "Europe/Brussels", "America/Los_Angeles"]) {
      process.env.TZ = tz;
      const [a] = await parseArticles(card("October 8, 2026"), config(base));
      expect(a.date?.toISOString()).toBe("2026-10-08T00:00:00.000Z");
    }
  });

  test("dd.MM.yyyy (German listings)", async () => {
    const [a] = await parseArticles(card("24.09.2026"), config({ ...base, dateFormat: "dd.MM.yyyy" }));
    expect(a.date?.toISOString()).toBe("2026-09-24T00:00:00.000Z");
  });
});
