#!/usr/bin/env bun
/**
 * Add a new feed: fetch HTML → LLM generates config → validate → save.
 *
 * Usage:
 *   LLM_API_KEY=xxx bun run src/add-feed.ts https://example.com/blog
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { fetchHTML } from "./fetcher.js";
import { buildConfig, deriveConfigName } from "./config-builder.js";
import { generateRSS } from "./generator.js";
import { saveSnapshot } from "./snapshot.js";
import type { FeedConfig } from "./types.js";

const CONFIGS_DIR = join(import.meta.dir, "..", "configs");
const FEEDS_DIR = join(import.meta.dir, "..", "feeds");

/**
 * Never overwrite another feed's config: if the name is taken by a config for
 * a different URL, append the hostname slug.
 */
function resolveConfigName(config: FeedConfig): string {
  const candidates = [config.name, `${config.name}-${deriveConfigName(config.url)}`];
  for (const name of candidates) {
    const path = join(CONFIGS_DIR, `${name}.json`);
    if (!existsSync(path)) return name;
    const existing = JSON.parse(readFileSync(path, "utf-8")) as FeedConfig;
    if (existing.url === config.url) return name; // re-adding the same feed
  }
  throw new Error(
    `Config name "${config.name}" is already used by a feed for another URL`
  );
}

async function main() {
  const url = process.argv[2];
  if (!url || !url.startsWith("http")) {
    console.error("Usage: bun run src/add-feed.ts <blog-url>");
    console.error("Example: bun run src/add-feed.ts https://ollama.com/blog");
    process.exit(1);
  }

  console.log(`\n🆕 Adding feed for: ${url}\n`);

  // 1. Fetch HTML
  console.log("⬇️  Fetching HTML...");
  const html = await fetchHTML(url);
  console.log(`✅ Fetched ${(html.length / 1024).toFixed(1)}KB`);

  // 2. Generate a config and verify it against the page
  let config: FeedConfig;
  let articles;
  try {
    ({ config, articles } = await buildConfig(url, html));
  } catch (err) {
    console.error(`❌ ${(err as Error).message}`);
    console.error(
      "   This site may be a JavaScript-rendered SPA, or use unusual structure."
    );
    process.exit(1);
  }
  config.createdAt = new Date().toISOString();
  config.name = resolveConfigName(config);

  // 3. Generate RSS
  const xml = generateRSS(articles, config);

  // 4. Save config, feed, and snapshot
  mkdirSync(CONFIGS_DIR, { recursive: true });
  mkdirSync(FEEDS_DIR, { recursive: true });

  writeFileSync(
    join(CONFIGS_DIR, `${config.name}.json`),
    JSON.stringify(config, null, 2)
  );
  writeFileSync(join(FEEDS_DIR, `${config.name}.xml`), xml);
  saveSnapshot(config.name, articles);

  console.log(`\n✅ Feed added successfully!`);
  console.log(`   Config: configs/${config.name}.json`);
  console.log(`   Feed:   feeds/${config.name}.xml`);
  console.log(`   Items:  ${articles.length}`);
  console.log(
    `\n📖 Subscribe: https://raw.githubusercontent.com/yorrick-s-cronos/rss-feed-maker/main/feeds/${config.name}.xml`
  );
  // Machine-readable line for the add_feed workflow.
  process.stdout.write(`config_name=${config.name}\n`);
}

main().catch((err) => {
  console.error("Fatal:", err.message);
  process.exit(1);
});
