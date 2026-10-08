/**
 * LLM integration: HTML → FeedConfig via any OpenAI-compatible
 * chat-completions API (Route33 by default).
 *
 * Environment:
 *   LLM_API_KEY   required — API key for the endpoint
 *   LLM_BASE_URL  optional — default https://api.route33.ai/v1
 *   LLM_MODEL     optional — default deepseek/deepseek-v4-flash-0731
 */

import * as cheerio from "cheerio";
import type { FeedConfig } from "./types.js";

const DEFAULT_BASE_URL = "https://api.route33.ai/v1";
const DEFAULT_MODEL = "deepseek/deepseek-v4-flash-0731";
const MAX_RETRIES = 3;
const MAX_HTML_CHARS = 60_000;
// Reasoning models spend part of the budget on hidden reasoning tokens.
const MAX_TOKENS = 8_000;
const REQUEST_TIMEOUT_MS = 180_000;

const SYSTEM_PROMPT = `You are an expert at analyzing HTML structure to extract blog article listings.

Given an HTML page of a blog index, output a JSON object matching this exact TypeScript interface:

\`\`\`typescript
interface FeedConfig {
  name: string;              // lowercase slug, e.g. "ollama"
  url: string;               // the blog URL provided
  feed: {
    title: string;           // e.g. "Ollama Blog"
    description: string;     // brief description
    language: string;        // ISO 639-1, e.g. "en"
    author?: string;         // optional
  };
  selectors: {
    articleList: string;     // CSS selector matching EACH article entry
    title: string;           // CSS selector for title RELATIVE to articleList
    date?: string;           // CSS selector for date RELATIVE to articleList
    description?: string;    // CSS selector for description RELATIVE to articleList
    link: {
      source: string;        // "attr:href" to get href from the title's <a> tag
      prefix?: string;       // base URL to prepend to relative links, e.g. "https://ollama.com"
    };
  };
  parserMode?: "css" | "json" | "changelog"; // default: "css"
  changelogExtraction?: {
    linkTemplate?: string;     // e.g., "https://github.com/org/repo/releases/tag/v{version}"
    sections?: string[];       // which ### sections to include, default: all
  };
  dateFormat?: string;        // date-fns format string if dates are in unusual format
  createdAt: string;          // ISO date string
}
\`\`\`

Rules:
1. The \`articleList\` selector should match EACH individual article/post entry.
2. \`title\` selector is RELATIVE to the articleList element.
3. For \`link.source\`, use "attr:href" — the parser will find the nearest <a> tag.
4. If URLs are relative (e.g. "/blog/post-1"), set \`link.prefix\` to the site origin.
5. Only output valid JSON. No markdown, no explanation, no code fences.
6. Set \`createdAt\` to today's date in ISO format.
7. If the page is a CHANGELOG or release notes in "Keep a Changelog" format (## headings for versions, ### for categories), set \`parserMode\` to "changelog" and provide \`changelogExtraction\` with \`linkTemplate\` if the source is a GitHub repo.
8. Selectors must be valid Cheerio/css-select syntax. If a class name contains ":" (for example Tailwind "hover:underline"), escape the colon as "\\\\:" in JSON, or prefer a stable structural selector such as article, a[href], h1-h3, time, or data-* attributes.
9. Avoid Tailwind utility classes and generated/hash-like classes when stable tags or attributes are available.
10. Point \`date\` at the element holding the publication date. For numeric dates, set \`dateFormat\` and read the day/month order from the listing itself: a first number above 12 (e.g. 30/09/2026) means day-first ("dd/MM/yyyy"), a second number above 12 means month-first ("MM/dd/yyyy"). Use the separator the page uses (e.g. "dd.MM.yyyy").`;

interface LlmSettings {
  apiKey: string | undefined;
  baseUrl: string;
  model: string;
}

function envValue(name: string): string | undefined {
  const value = process.env[name]?.trim();
  return value ? value : undefined;
}

export function llmSettings(): LlmSettings {
  return {
    apiKey: envValue("LLM_API_KEY"),
    baseUrl: (envValue("LLM_BASE_URL") ?? DEFAULT_BASE_URL).replace(/\/+$/, ""),
    model: envValue("LLM_MODEL") ?? DEFAULT_MODEL,
  };
}

export interface PreparedHtml {
  html: string;
  scope: "main" | "body";
  title: string;
  description: string;
  lang: string;
  truncated: boolean;
}

const NOISE_ELEMENTS = "script, style, noscript, svg, template, iframe, link, meta";
const NOISE_ATTRIBUTE = /^(srcset|sizes|style|loading|decoding|width|height|on\w+)$|^data-astro-cid-/i;

/**
 * Reduce a page to the part that holds the article list: the <main> element
 * when it has links, otherwise <body>. Scripts, styles, SVGs and bulky
 * attributes (srcset, inline styles, …) are removed so the listing fits in
 * the prompt even when the site header is large.
 */
export function prepareHtmlForLLM(html: string, maxChars = MAX_HTML_CHARS): PreparedHtml {
  const $ = cheerio.load(html);
  const title = $("title").first().text().trim();
  const description = $('meta[name="description"]').attr("content")?.trim() ?? "";
  const lang = $("html").attr("lang")?.trim() ?? "";

  $(NOISE_ELEMENTS).remove();
  const main = $("main").first();
  const useMain = main.length > 0 && main.find("a[href]").length >= 3;
  const root = useMain ? main : $("body");

  root.find("*").each((_, el) => {
    const attribs = (el as { attribs?: Record<string, string> }).attribs;
    if (!attribs) return;
    for (const name of Object.keys(attribs)) {
      if (NOISE_ATTRIBUTE.test(name)) delete attribs[name];
    }
  });

  const markup = ($.html(root) || $.html()).replace(/\s{2,}/g, " ").trim();
  const truncated = markup.length > maxChars;
  return {
    html: truncated ? markup.slice(0, maxChars) + "\n<!-- truncated -->" : markup,
    scope: useMain ? "main" : "body",
    title,
    description,
    lang,
    truncated,
  };
}

/** Parse the JSON object in a model reply, tolerating code fences or prose around it. */
export function extractJsonObject(text: string): unknown {
  const trimmed = text.trim();
  try {
    return JSON.parse(trimmed);
  } catch {
    const start = trimmed.indexOf("{");
    const end = trimmed.lastIndexOf("}");
    if (start === -1 || end <= start) {
      throw new Error(`LLM reply contains no JSON object: ${trimmed.slice(0, 120)}`);
    }
    return JSON.parse(trimmed.slice(start, end + 1));
  }
}

class FatalLlmError extends Error {}

/**
 * Generate a FeedConfig from a blog URL's HTML using the LLM.
 *
 * @param feedback Optional message describing why the previous config failed
 *                 (e.g. selectors matched 0 articles), surfaced to the LLM so
 *                 it can correct itself instead of repeating the mistake.
 */
export async function generateConfig(
  url: string,
  html: string,
  feedback?: string
): Promise<FeedConfig> {
  const { apiKey, baseUrl, model } = llmSettings();
  if (!apiKey) {
    throw new Error(
      "LLM_API_KEY not set. Required to generate feed configs (OpenAI-compatible API, default Route33)."
    );
  }

  const page = prepareHtmlForLLM(html);
  const scope =
    page.scope === "main" ? "the page's <main> element" : "the page <body>";
  const pageContext =
    `URL: ${url}\n` +
    `Page title: ${page.title || "(none)"}\n` +
    `Meta description: ${page.description || "(none)"}\n` +
    `<html lang>: ${page.lang || "(none)"}\n\n` +
    `HTML (${scope}, simplified: scripts, styles, SVGs and image srcset/size ` +
    `attributes removed${page.truncated ? "; truncated" : ""}). Your selectors ` +
    `are evaluated against the full original page:\n${page.html}`;

  let lastError = "";
  let replyProblem = ""; // why the model's previous answer was unusable
  let minimalRequest = false;

  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    const parts: string[] = [];
    if (feedback) parts.push(feedback);
    if (replyProblem) parts.push(`Your previous reply was unusable: ${replyProblem}`);
    parts.push(
      feedback || replyProblem
        ? "Analyze this blog page and output a corrected FeedConfig JSON."
        : "Analyze this blog page and output a FeedConfig JSON."
    );
    const preamble = parts.join("\n\n");

    const body: Record<string, unknown> = {
      model,
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: `${preamble}\n\n${pageContext}` },
      ],
      max_tokens: MAX_TOKENS,
    };
    if (!minimalRequest) {
      // Optional parameters; some models reject them (e.g. a fixed temperature).
      body.temperature = 0.1;
      body.response_format = { type: "json_object" };
    }

    try {
      const res = await fetch(`${baseUrl}/chat/completions`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      const raw = await res.text();

      if (res.status === 401 || res.status === 403) {
        throw new FatalLlmError(
          `LLM API rejected the request (${res.status}) — check LLM_API_KEY and that model "${model}" is allowed: ${raw.slice(0, 200)}`
        );
      }
      if (res.status === 400 && !minimalRequest) {
        minimalRequest = true;
        throw new Error(
          `API error 400 (retrying without temperature/response_format): ${raw.slice(0, 200)}`
        );
      }
      if (!res.ok) {
        throw new Error(`API error ${res.status}: ${raw.slice(0, 200)}`);
      }

      let data: {
        choices?: { message?: { content?: string | null }; finish_reason?: string }[];
      };
      try {
        data = JSON.parse(raw);
      } catch {
        throw new Error(
          `LLM endpoint returned non-JSON (${res.headers.get("content-type") ?? "unknown content-type"}): ${raw.slice(0, 120)}`
        );
      }

      const choice = data.choices?.[0];
      const content = choice?.message?.content;
      if (!content?.trim()) {
        throw new Error(
          choice?.finish_reason === "length"
            ? `LLM ran out of tokens before answering (max_tokens=${MAX_TOKENS})`
            : "Empty response from LLM"
        );
      }

      let config: FeedConfig;
      try {
        config = extractJsonObject(content) as FeedConfig;
      } catch (err) {
        replyProblem = `it was not valid JSON (${(err as Error).message})`;
        throw err;
      }

      // Basic validation
      if (!config.name || !config.url || !config.selectors?.articleList) {
        replyProblem = "missing required fields (name, url, selectors.articleList)";
        throw new Error(
          "Invalid config: missing required fields (name, url, selectors.articleList)"
        );
      }

      return config;
    } catch (err) {
      if (err instanceof FatalLlmError) throw err;
      lastError = (err as Error).message;
      console.error(
        `  ⚠️ LLM attempt ${attempt + 1}/${MAX_RETRIES} (${model}) failed: ${lastError}`
      );
      if (attempt < MAX_RETRIES - 1) {
        await new Promise((r) => setTimeout(r, 2000));
      }
    }
  }

  throw new Error(
    `Failed to generate config after ${MAX_RETRIES} attempts: ${lastError}`
  );
}
