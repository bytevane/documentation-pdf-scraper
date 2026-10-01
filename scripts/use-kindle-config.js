#!/usr/bin/env node

/**
 * PDF 设备配置（config-profiles/*.json）查看工具
 *
 * 配置档按次选择：`PDF_PROFILE=<name> npm start`（或 `make kindle-oasis` 等）。
 * 本脚本只读，不会修改 config.json。
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { isPathInside } from '../src/utils/paths.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, '..');
const CONFIG_FILE = path.resolve(rootDir, 'config.json');
const PROFILES_DIR = path.resolve(rootDir, 'config-profiles');

// 旧命令使用的设备短名
const PROFILE_ALIASES = {
  paperwhite: 'kindle-paperwhite',
  oasis: 'kindle-oasis',
  scribe: 'kindle-scribe',
};

// 旧版 `use` 命令写入 config.json 的设备专属字段
const LEGACY_PROFILE_KEYS = ['kindleOptimized', 'deviceProfile'];

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function listProfileNames() {
  return fs
    .readdirSync(PROFILES_DIR)
    .filter((file) => file.endsWith('.json'))
    .map((file) => path.basename(file, '.json'))
    .sort((a, b) => a.localeCompare(b));
}

function resolveProfileName(name) {
  const resolved = PROFILE_ALIASES[name] || name;
  const profileFile = path.resolve(PROFILES_DIR, `${resolved}.json`);
  if (!/^[a-z0-9-]+$/.test(resolved) || !isPathInside(PROFILES_DIR, profileFile)) {
    return null;
  }
  return fs.existsSync(profileFile) ? resolved : null;
}

function showHelp() {
  console.log(`
PDF 设备配置查看工具（只读）

用法:
  node scripts/use-kindle-config.js <command> [profile]

命令:
  list              列出 config-profiles/ 中的配置档
  use <profile>     显示使用该配置档运行的命令（不修改 config.json）
  current           显示当前 PDF_PROFILE 与 config.json 状态
  help              查看帮助

运行示例:
  PDF_PROFILE=kindle-oasis npm start
  make kindle-oasis
`);
}

function listProfiles() {
  console.log('\n可用配置档 (config-profiles/*.json):');
  for (const name of listProfileNames()) {
    const profile = readJson(path.join(PROFILES_DIR, `${name}.json`));
    const details = [
      profile.pdf?.layoutPreset && `layout=${profile.pdf.layoutPreset}`,
      profile.pdf?.fontSize && `font=${profile.pdf.fontSize}`,
      profile.output?.finalPdfDirectory && `output=${profile.output.finalPdfDirectory}`,
    ].filter(Boolean);
    console.log(`  - ${name}${details.length ? ` (${details.join(', ')})` : ''}`);
  }
  console.log('\n使用: PDF_PROFILE=<name> npm start');
}

function useProfile(name) {
  const profile = name && resolveProfileName(name);
  if (!profile) {
    console.error(`❌ 未知配置档: ${name || '(未指定)'}`);
    listProfiles();
    process.exitCode = 1;
    return;
  }
  console.log('配置档按次生效，config.json 不会被修改。运行:');
  console.log(`  PDF_PROFILE=${profile} npm start`);
}

function showCurrent() {
  const profile = process.env.PDF_PROFILE?.trim();
  console.log(`\nPDF_PROFILE: ${profile || '(未设置，使用基础配置)'}`);

  if (!fs.existsSync(CONFIG_FILE)) {
    console.error('❌ 找不到 config.json');
    process.exitCode = 1;
    return;
  }

  const basePdf = readJson(CONFIG_FILE).pdf;
  const legacyKeys = LEGACY_PROFILE_KEYS.filter((key) => basePdf?.[key] !== undefined);
  if (legacyKeys.length) {
    console.warn(
      `⚠️  config.json 含有旧版 use 命令写入的设备字段 (pdf.${legacyKeys.join(', pdf.')})。` +
        '请移除这些字段，改用 PDF_PROFILE 按次选择配置档。'
    );
  } else {
    console.log('config.json: 未包含设备专属设置');
  }
}

function main() {
  const [command, profile] = process.argv.slice(2);
  switch (command) {
    case 'list':
      listProfiles();
      break;
    case 'use':
      useProfile(profile);
      break;
    case 'current':
      showCurrent();
      break;
    case 'reset':
      console.log('config.json 不再被配置档修改，无需重置。不设置 PDF_PROFILE 即使用基础配置。');
      showCurrent();
      break;
    case 'help':
    case undefined:
      showHelp();
      break;
    default:
      console.error(`❌ 未知命令: ${command}`);
      showHelp();
      process.exitCode = 1;
  }
}

main();
