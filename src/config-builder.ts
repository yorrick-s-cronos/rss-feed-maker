/**
 * Build a working FeedConfig for a blog page: ask the LLM for selectors, then
 * verify them deterministically against the real HTML (selector syntax →
 * parse → validation) and feed every failure back to the LLM.
 *
 * Shared by add-feed (new feeds) and heal-feed (broken feeds).
 */

import { generateConfig } from "./llm.js";
import { parseArticles, validateSelectorSyntax } from "./parser.js";
import { validateQuick } from "./validator.js";
import type { Article, FeedConfig } from "./types.js";

export const MAX_BUILD_ATTEMPTS = 3;

export type ConfigGenerator = (
  url: string,
  html: string,
  feedback?: string
) => Promise<FeedConfig>;

export interface BuildResult {
  config: FeedConfig;
  articles: Article[];
}

/** Slug derived from the hostname, e.g. "aleph-alpha-com". */
export function deriveConfigName(url: string): string {
  const parsed = new URL(url);
  const parts = parsed.hostname.split(".");
  const slug = parts.length > 2 ? parts.slice(-2).join("-") : parts.join("-");
  return slug.replace(/[^a-z0-9]/gi, "-").replace(/-+/g, "-").replace(/^-|-$/g, "");
}

/** Make an LLM-proposed name safe to use as a file name: [a-z0-9-] only. */
export function sanitizeName(name: unknown): string {
  return String(name ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60)
    .replace(/-+$/g, "");
}

const NUMERIC_DATE = /(?<!\d)(\d{1,2})([\/.\-])(\d{1,2})\2(\d{4})(?!\d)/;

/**
 * Infer the day/month order of numeric dates from the dates on the listing.
 * Returns e.g. "dd/MM/yyyy" when some first number is above 12, "MM/dd/yyyy"
 * when some second number is above 12, and undefined when the evidence is
 * missing, ambiguous or the dates are not mostly numeric (e.g. "Oct 8, 2026").
 */
export function inferNumericDateFormat(samples: (string | undefined)[]): string | undefined {
  const present = samples.filter((s): s is string => !!s?.trim());
  const matches = present
    .map((s) => s.match(NUMERIC_DATE))
    .filter((m): m is RegExpMatchArray => m !== null);
  if (matches.length === 0 || matches.length * 2 < present.length) return undefined;

  const separator = matches[0][2];
  if (matches.some((m) => m[2] !== separator)) return undefined;

  const dayFirst = matches.some((m) => Number(m[1]) > 12);
  const monthFirst = matches.some((m) => Number(m[3]) > 12);
  if (dayFirst && !monthFirst) return `dd${separator}MM${separator}yyyy`;
  if (monthFirst && !dayFirst) return `MM${separator}dd${separator}yyyy`;
  return undefined;
}

/** Pin the fields the LLM must not control and fill safe defaults. */
function normalizeConfig(config: FeedConfig, url: string): FeedConfig {
  config.url = url;
  config.name = sanitizeName(config.name) || deriveConfigName(url);
  if (config.parserMode && !["css", "json", "changelog"].includes(config.parserMode)) {
    config.parserMode = "css";
  }
  config.feed = {
    ...config.feed,
    title: config.feed?.title?.trim() || new URL(url).hostname,
    description: config.feed?.description?.trim() || "",
    language: config.feed?.language?.trim() || "en",
  };
  config.selectors.link ??= { source: "attr:href" };
  return config;
}

function selectorFeedback(config: FeedConfig, errors: string[]): string {
  return (
    `Your previous FeedConfig used invalid CSS selector syntax.\n` +
    `Selector errors:\n${errors.map((e) => `- ${e}`).join("\n")}\n\n` +
    `Selectors used: ${JSON.stringify(config.selectors)}.\n` +
    `Selectors must be valid Cheerio/css-select syntax. If you use a class name ` +
    `containing ":" (for example Tailwind "hover:underline"), escape the colon ` +
    `as "\\:" in the JSON string, or choose a more stable structural selector ` +
    `such as article, a[href], h1-h3, time, or data-* attributes.`
  );
}

function parseFeedback(config: FeedConfig, err: unknown): string {
  return (
    `Your previous FeedConfig crashed the deterministic parser.\n` +
    `Parser error: ${(err as Error).message}\n\n` +
    `Selectors used: ${JSON.stringify(config.selectors)}.\n` +
    `Return a corrected FeedConfig whose selectors can be executed by Cheerio. ` +
    `Avoid raw Tailwind variant classes such as ".hover:underline"; escape ":" ` +
    `as "\\:" or use stable structural selectors.`
  );
}

function emptyArticlesFeedback(config: FeedConfig): string {
  return (
    `Your previous selectors produced 0 articles when applied to this exact HTML. ` +
    `Selectors used: ${JSON.stringify(config.selectors)}. ` +
    `The articleList selector "${config.selectors.articleList}" matched no usable articles. ` +
    `Pick selectors that actually exist in the HTML below; avoid hashed CSS-Modules class names ` +
    `(e.g. "Foo-module-scss-module__abc123__bar"), prefer stable tags/attributes (article, h1-h3, ` +
    `data-* attributes, or simple class names). If the page is a JavaScript-rendered SPA with no ` +
    `article markup in the static HTML, return parserMode "json" with jsonExtraction targeting ` +
    `the __NEXT_DATA__ script and the appropriate dataPath.`
  );
}

function validationFeedback(config: FeedConfig, articles: Article[], errors: string[]): string {
  const sample = articles.slice(0, 3).map((a) => ({
    title: a.title,
    link: a.link,
    date: a.date?.toISOString(),
  }));
  return (
    `Your previous FeedConfig parsed articles, but they failed validation.\n` +
    `Validation errors:\n${errors.map((e) => `- ${e}`).join("\n")}\n\n` +
    `Selectors used: ${JSON.stringify(config.selectors)}.\n` +
    `Sample parsed articles: ${JSON.stringify(sample)}.\n` +
    `Return corrected selectors that produce non-empty titles and absolute http(s) links without duplicates.`
  );
}

/**
 * Generate a config with the LLM and verify it against `html`. Each failed
 * stage becomes feedback for the next attempt. Throws after `attempts`
 * unsuccessful attempts; LLM transport/auth errors propagate immediately.
 */
export async function buildConfig(
  url: string,
  html: string,
  options: { generate?: ConfigGenerator; attempts?: number } = {}
): Promise<BuildResult> {
  const generate = options.generate ?? generateConfig;
  const attempts = options.attempts ?? MAX_BUILD_ATTEMPTS;
  let feedback: string | undefined;
  let lastFailure = "";
  let lastSelectors = "";

  for (let attempt = 1; attempt <= attempts; attempt++) {
    console.log(`🤖 Generating config via LLM (attempt ${attempt}/${attempts})...`);
    const config = normalizeConfig(await generate(url, html, feedback), url);
    lastSelectors = JSON.stringify(config.selectors);
    console.log(`✅ Config generated: "${config.name}" ${lastSelectors}`);

    const selectorErrors = validateSelectorSyntax(config);
    if (selectorErrors.length > 0) {
      lastFailure = selectorErrors.join("; ");
      feedback = selectorFeedback(config, selectorErrors);
      console.warn("⚠️  Config has invalid selector syntax; retrying with feedback to LLM...");
      continue;
    }

    let articles: Article[];
    try {
      articles = await parseArticles(html, config);
    } catch (err) {
      lastFailure = (err as Error).message;
      feedback = parseFeedback(config, err);
      console.warn(`⚠️  Parser failed: ${lastFailure}; retrying with feedback to LLM...`);
      continue;
    }
    console.log(`   Found ${articles.length} articles`);

    if (articles.length === 0) {
      lastFailure = "No articles found";
      feedback = emptyArticlesFeedback(config);
      console.warn("⚠️  No articles parsed; retrying with feedback to LLM...");
      continue;
    }

    // The listing itself is the evidence for the day/month order of numeric
    // dates; it overrides whatever the LLM guessed.
    const inferred = inferNumericDateFormat(articles.map((a) => a.rawDate));
    if (inferred && inferred !== config.dateFormat) {
      console.log(
        `📅 Date order inferred from the listing: ${inferred} (LLM said: ${config.dateFormat ?? "none"})`
      );
      config.dateFormat = inferred;
      articles = await parseArticles(html, config);
    }

    const validation = validateQuick(articles);
    if (!validation.valid) {
      lastFailure = validation.errors.join("; ");
      feedback = validationFeedback(config, articles, validation.errors);
      console.warn("⚠️  Parsed articles failed validation; retrying with feedback to LLM...");
      continue;
    }
    for (const w of validation.warnings) {
      console.warn(`⚠️  ${w}`);
    }

    return { config, articles };
  }

  throw new Error(
    `Failed to generate a valid feed config after ${attempts} attempts. ` +
      `Last failure: ${lastFailure}. Last selectors: ${lastSelectors}`
  );
}
