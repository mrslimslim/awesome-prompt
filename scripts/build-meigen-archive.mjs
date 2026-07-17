import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { cp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import sharp from 'sharp';

const cwd = process.cwd();
const defaultSourceDir = 'E:/image-garllery-wesite/meigen_export';

const options = parseArgs(process.argv.slice(2));
const sourceDir = path.resolve(options.source ?? process.env.MEIGEN_EXPORT_DIR ?? defaultSourceDir);
const outputDir = path.resolve(options.output ?? cwd);
const imageDir = path.join(outputDir, 'images');
const videoThumbDir = path.join(outputDir, 'video-thumbnails');
const dataDir = path.join(outputDir, 'data');
const maxDimension = Number(options.max ?? 1280);
const quality = Number(options.quality ?? 76);
const concurrency = Math.max(1, Number(options.concurrency ?? 8));
const clean = options.clean !== 'false';
const rawBase = normalizeRawBase(options['raw-base'] ?? detectRawBase());

function parseArgs(args) {
  const parsed = {};
  for (const arg of args) {
    if (!arg.startsWith('--')) continue;
    const [key, ...valueParts] = arg.slice(2).split('=');
    parsed[key] = valueParts.length ? valueParts.join('=') : 'true';
  }
  return parsed;
}

function detectRawBase() {
  try {
    const execOptions = { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] };
    const remote = execFileSync('git', ['remote', 'get-url', 'origin'], execOptions).trim();
    const branch = execFileSync('git', ['branch', '--show-current'], execOptions).trim() || 'main';
    const httpsMatch = remote.match(/github\.com[:/](.+?)\/(.+?)(?:\.git)?$/i);
    if (!httpsMatch) return '';
    return `https://raw.githubusercontent.com/${httpsMatch[1]}/${httpsMatch[2]}/${branch}`;
  } catch {
    return '';
  }
}

function normalizeRawBase(value) {
  if (!value || value === 'true') return '';
  return String(value).replace(/\/+$/, '');
}

function toPosix(filePath) {
  return filePath.split(path.sep).join('/');
}

function rawUrl(relativePath) {
  return rawBase ? `${rawBase}/${relativePath.split('/').map(encodeURIComponent).join('/')}` : '';
}

function sourceAssetPath(relativePath) {
  return path.join(sourceDir, relativePath.replace(/\//g, path.sep));
}

async function fileSize(filePath) {
  return (await stat(filePath)).size;
}

function csvEscape(value) {
  const text = value == null ? '' : String(value);
  return `"${text.replace(/"/g, '""')}"`;
}

function collectSourceAssets(item) {
  const localImages = Array.isArray(item.localImages) ? item.localImages : [];
  return localImages.map((relativePath, index) => ({ relativePath, index }));
}

function outputAssetRelativePath(item, index) {
  if (item.sourceCollection === 'videos') return `video-thumbnails/${item.id}.webp`;
  return `images/${item.id}/${index}.webp`;
}

function assetMapKey(item) {
  return `${item.sourceCollection}:${item.id}`;
}

async function compressOne(task) {
  const sourceSize = await fileSize(task.sourcePath);
  await mkdir(path.dirname(task.outputPath), { recursive: true });

  if (existsSync(task.outputPath)) {
    const outputSize = await fileSize(task.outputPath);
    return { ...task, sourceSize, outputSize, skipped: true };
  }

  await sharp(task.sourcePath, { limitInputPixels: false })
    .rotate()
    .resize({
      width: maxDimension,
      height: maxDimension,
      fit: 'inside',
      withoutEnlargement: true,
    })
    .webp({
      quality,
      effort: 4,
      smartSubsample: true,
    })
    .toFile(task.outputPath);

  const outputSize = await fileSize(task.outputPath);
  return { ...task, sourceSize, outputSize, skipped: false };
}

async function runPool(tasks) {
  let cursor = 0;
  let completed = 0;
  let failed = 0;
  let sourceBytes = 0;
  let outputBytes = 0;
  let skipped = 0;
  const failures = [];

  async function worker() {
    while (cursor < tasks.length) {
      const task = tasks[cursor];
      cursor += 1;
      try {
        const result = await compressOne(task);
        sourceBytes += result.sourceSize;
        outputBytes += result.outputSize;
        if (result.skipped) skipped += 1;
      } catch (error) {
        failed += 1;
        failures.push({ id: task.id, source: task.sourceRelativePath, output: task.outputRelativePath, error: error.message });
      }
      completed += 1;
      if (completed % 100 === 0 || completed === tasks.length) {
        const mb = (outputBytes / 1024 / 1024).toFixed(1);
        console.log(`compressed ${completed}/${tasks.length} failed=${failed} skipped=${skipped} out=${mb}MB`);
      }
    }
  }

  await Promise.all(Array.from({ length: concurrency }, () => worker()));
  return { completed, failed, skipped, sourceBytes, outputBytes, failures };
}

function normalizeItem(item, assetMap) {
  const cdnImages = assetMap.get(assetMapKey(item)) ?? [];
  const next = {
    ...item,
    localImages: cdnImages,
    cdnImages,
    cdnImage: cdnImages[0] ?? '',
  };

  if (rawBase) {
    next.rawImages = cdnImages.map(rawUrl);
    next.rawImage = next.rawImages[0] ?? '';
  }

  return next;
}

function buildCsv(items) {
  const header = [
    'sourceCollection',
    'id',
    'model',
    'mediaType',
    'title',
    'prompt',
    'authorName',
    'authorUsername',
    'likes',
    'views',
    'retweets',
    'postedAt',
    'cdnImage',
    'cdnImages',
    'rawImage',
    'rawImages',
    'sourceUrl',
  ];

  const rows = items.map((item) => {
    const sourceUrl = item.author?.username ? `https://x.com/${item.author.username}/status/${item.id}` : '';
    return [
      item.sourceCollection,
      item.id,
      item.model,
      item.mediaType,
      item.title,
      item.prompt,
      item.author?.name,
      item.author?.username,
      item.stats?.likes,
      item.stats?.views,
      item.stats?.retweets,
      item.postedAt,
      item.cdnImage,
      JSON.stringify(item.cdnImages ?? []),
      item.rawImage ?? '',
      JSON.stringify(item.rawImages ?? []),
      sourceUrl,
    ].map(csvEscape).join(',');
  });

  return `${header.map(csvEscape).join(',')}\n${rows.join('\n')}\n`;
}

function checksum(text) {
  return createHash('sha256').update(text).digest('hex');
}

async function main() {
  const promptsPath = path.join(sourceDir, 'prompts-all.json');
  const sourceSummaryPath = path.join(sourceDir, 'summary.json');
  const sourcePrompts = JSON.parse(await readFile(promptsPath, 'utf8'));
  const sourceSummary = JSON.parse(await readFile(sourceSummaryPath, 'utf8'));

  if (clean) {
    await rm(imageDir, { recursive: true, force: true });
    await rm(videoThumbDir, { recursive: true, force: true });
    await rm(dataDir, { recursive: true, force: true });
  }

  await mkdir(imageDir, { recursive: true });
  await mkdir(videoThumbDir, { recursive: true });
  await mkdir(dataDir, { recursive: true });

  const assetMap = new Map();
  const tasks = [];

  for (const item of sourcePrompts) {
    for (const asset of collectSourceAssets(item)) {
      const sourcePath = sourceAssetPath(asset.relativePath);
      if (!existsSync(sourcePath)) {
        console.warn(`missing source asset: ${asset.relativePath}`);
        continue;
      }

      const outputRelativePath = outputAssetRelativePath(item, asset.index);
      const outputPath = path.join(outputDir, outputRelativePath.replace(/\//g, path.sep));
      const mapKey = assetMapKey(item);
      if (!assetMap.has(mapKey)) assetMap.set(mapKey, []);
      assetMap.get(mapKey).push(outputRelativePath);
      tasks.push({
        id: item.id,
        sourceRelativePath: asset.relativePath,
        sourcePath,
        outputRelativePath,
        outputPath,
      });
    }
  }

  console.log(`source: ${sourceDir}`);
  console.log(`output: ${outputDir}`);
  console.log(`items: ${sourcePrompts.length}`);
  console.log(`assets: ${tasks.length}`);
  console.log(`webp quality=${quality} max=${maxDimension} concurrency=${concurrency}`);
  if (rawBase) console.log(`raw base: ${rawBase}`);
  else console.log('raw base: not set; add a GitHub origin or pass --raw-base=...');

  const compression = await runPool(tasks);
  const prompts = sourcePrompts.map((item) => normalizeItem(item, assetMap));
  const imagePrompts = prompts.filter((item) => item.sourceCollection === 'images');
  const videoPrompts = prompts.filter((item) => item.sourceCollection === 'videos');

  await writeFile(path.join(dataDir, 'prompts-all.json'), `${JSON.stringify(prompts, null, 2)}\n`, 'utf8');
  await writeFile(path.join(dataDir, 'prompts-images.json'), `${JSON.stringify(imagePrompts, null, 2)}\n`, 'utf8');
  await writeFile(path.join(dataDir, 'prompts-videos.json'), `${JSON.stringify(videoPrompts, null, 2)}\n`, 'utf8');
  await writeFile(path.join(dataDir, 'prompts-all.csv'), buildCsv(prompts), 'utf8');
  await cp(sourceSummaryPath, path.join(dataDir, 'source-summary.json'));

  const dataJson = JSON.stringify(prompts);
  const summary = {
    builtAt: new Date().toISOString(),
    sourceDir,
    rawBase,
    quality,
    maxDimension,
    promptCount: prompts.length,
    imagePromptCount: imagePrompts.length,
    videoPromptCount: videoPrompts.length,
    assetCount: tasks.length,
    compression: {
      completed: compression.completed,
      failed: compression.failed,
      skipped: compression.skipped,
      sourceBytes: compression.sourceBytes,
      outputBytes: compression.outputBytes,
      savedBytes: compression.sourceBytes - compression.outputBytes,
      outputRatio: Number((compression.outputBytes / compression.sourceBytes).toFixed(4)),
    },
    sourceSummary,
    dataSha256: checksum(dataJson),
  };

  await writeFile(path.join(dataDir, 'summary.json'), `${JSON.stringify(summary, null, 2)}\n`, 'utf8');
  if (compression.failures.length) {
    await writeFile(path.join(dataDir, 'compression-failures.json'), `${JSON.stringify(compression.failures, null, 2)}\n`, 'utf8');
  }

  console.log(JSON.stringify(summary, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
