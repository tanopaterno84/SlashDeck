/**
 * Scans the files on disk for custom commands, skills and plugins. Used to attribute kind and
 * source file to the commands returned by the CLI, and as the fallback when the CLI is not
 * available. Never throws for missing folders or malformed files: it records warnings.
 */
import { readFile, readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import type { CommandKind, ScanWarning } from '../types.js';
import { errorMessage, sha256, stripBom, toPosixPath } from '../util.js';
import { argumentHintField, isFalse, parseFrontmatter, stringField } from './frontmatter.js';

export type FileKind = Exclude<CommandKind, 'builtin' | 'unknown'>;

export interface FileItem {
  kind: FileKind;
  /** Name without the leading "/", as used in file-only mode. */
  name: string;
  /** Names this item may appear under in the CLI list (without "/"). */
  matchNames: string[];
  plugin?: string;
  /** Absolute path with forward slashes. */
  sourcePath: string;
  hash: string;
  description?: string;
  argumentHint?: string;
  /** False when a skill declares `user-invocable: false`. */
  userInvocable: boolean;
}

export interface FileScanResult {
  /** In priority order: the first item wins when two share a name. */
  items: FileItem[];
  /** Names of the installed plugins (registry and synced). */
  plugins: string[];
  warnings: ScanWarning[];
}

export interface FileScanOptions {
  workspace: string;
  homeDir: string;
  /** User config dir; defaults to `<homeDir>/.claude`. */
  claudeDir?: string;
}

interface Ctx {
  warnings: ScanWarning[];
}

// ---------------------------------------------------------------------------
// fs helpers
// ---------------------------------------------------------------------------

async function isDirectory(p: string): Promise<boolean> {
  try {
    return (await stat(p)).isDirectory();
  } catch {
    return false;
  }
}

async function isFile(p: string): Promise<boolean> {
  try {
    return (await stat(p)).isFile();
  } catch {
    return false;
  }
}

/** Entry names of a directory, without dot-entries (`.staging`, `.bucket-*`…). Missing → []. */
async function listEntries(dir: string, ctx: Ctx): Promise<string[]> {
  try {
    const names = await readdir(dir);
    return names.filter((n) => !n.startsWith('.')).sort();
  } catch (err) {
    const code = (err as { code?: string }).code;
    if (code !== 'ENOENT' && code !== 'ENOTDIR') {
      ctx.warnings.push({
        code: 'read-failed',
        message: `Cannot read ${toPosixPath(dir)}: ${code ?? errorMessage(err)}`,
      });
    }
    return [];
  }
}

async function listSubdirs(dir: string, ctx: Ctx): Promise<string[]> {
  const out: string[] = [];
  for (const name of await listEntries(dir, ctx)) {
    if (await isDirectory(path.join(dir, name))) out.push(name);
  }
  return out;
}

/** Relative path segments of every `*.md` file under `dir`, recursively. */
async function findMarkdown(dir: string, ctx: Ctx, prefix: string[] = []): Promise<string[][]> {
  const out: string[][] = [];
  for (const name of await listEntries(dir, ctx)) {
    const full = path.join(dir, name);
    if (await isDirectory(full)) {
      out.push(...(await findMarkdown(full, ctx, [...prefix, name])));
    } else if (name.toLowerCase().endsWith('.md') && (await isFile(full))) {
      out.push([...prefix, name]);
    }
  }
  return out;
}

interface SourceFile {
  sourcePath: string;
  hash: string;
  frontmatter: ReturnType<typeof parseFrontmatter>;
}

async function readSource(file: string, ctx: Ctx): Promise<SourceFile | undefined> {
  let bytes: Buffer;
  try {
    bytes = await readFile(file);
  } catch (err) {
    ctx.warnings.push({
      code: 'read-failed',
      message: `Cannot read ${toPosixPath(file)}: ${(err as { code?: string }).code ?? errorMessage(err)}`,
    });
    return undefined;
  }
  const frontmatter = parseFrontmatter(bytes.toString('utf8'));
  if (frontmatter.error !== undefined) {
    ctx.warnings.push({
      code: 'frontmatter-malformed',
      message: `Malformed frontmatter in ${toPosixPath(file)}: ${frontmatter.error}`,
    });
  }
  return { sourcePath: toPosixPath(path.resolve(file)), hash: sha256(bytes), frontmatter };
}

function unique(values: string[]): string[] {
  return [...new Set(values.filter((v) => v !== ''))];
}

function withMetadata(item: FileItem, source: SourceFile): FileItem {
  const description = stringField(source.frontmatter.data, 'description');
  const argumentHint = argumentHintField(source.frontmatter);
  if (description !== undefined) item.description = description;
  if (argumentHint !== undefined) item.argumentHint = argumentHint;
  return item;
}

// ---------------------------------------------------------------------------
// Sources
// ---------------------------------------------------------------------------

/** `<dir>/**\/*.md`. `a/b.md` may be listed as `b` or `a:b` (see open questions in CLAUDE.md). */
async function scanCommands(
  dir: string,
  kind: FileKind,
  ctx: Ctx,
  plugin?: string,
): Promise<FileItem[]> {
  const items: FileItem[] = [];
  for (const segments of await findMarkdown(dir, ctx)) {
    const source = await readSource(path.join(dir, ...segments), ctx);
    if (!source) continue;
    const base = (segments.at(-1) ?? '').replace(/\.md$/i, '');
    const nested = [...segments.slice(0, -1), base].join(':');
    const ns = plugin === undefined ? '' : `${plugin}:`;
    const item: FileItem = {
      kind,
      name: ns + base,
      matchNames: unique([ns + base, ns + nested]),
      sourcePath: source.sourcePath,
      hash: source.hash,
      userInvocable: true,
    };
    if (plugin !== undefined) item.plugin = plugin;
    items.push(withMetadata(item, source));
  }
  return items;
}

/** `<dir>/<name>/SKILL.md`. */
async function scanSkills(
  dir: string,
  kind: FileKind,
  ctx: Ctx,
  options: { plugin?: string; skipDirs?: string[] } = {},
): Promise<FileItem[]> {
  const items: FileItem[] = [];
  for (const sub of await listSubdirs(dir, ctx)) {
    const file = path.join(dir, sub, 'SKILL.md');
    if (!(await isFile(file))) continue;
    if (options.skipDirs?.includes(sub)) continue;
    const source = await readSource(file, ctx);
    if (!source) continue;
    const ns = options.plugin === undefined ? '' : `${options.plugin}:`;
    const declared = stringField(source.frontmatter.data, 'name');
    const name = ns + (declared ?? sub);
    const item: FileItem = {
      kind,
      name,
      matchNames: unique([name, ns + sub]),
      sourcePath: source.sourcePath,
      hash: source.hash,
      userInvocable: !isFalse(source.frontmatter.data['user-invocable']),
    };
    if (options.plugin !== undefined) item.plugin = options.plugin;
    items.push(withMetadata(item, source));
  }
  return items;
}

const pluginManifestSchema = z.object({ name: z.string().min(1) });

async function readPluginName(root: string, ctx: Ctx): Promise<string | undefined> {
  const file = path.join(root, '.claude-plugin', 'plugin.json');
  let text: string;
  try {
    text = await readFile(file, 'utf8');
  } catch {
    return undefined;
  }
  try {
    const parsed = pluginManifestSchema.safeParse(JSON.parse(stripBom(text)));
    if (parsed.success) return parsed.data.name;
  } catch {
    // fall through to the warning
  }
  ctx.warnings.push({
    code: 'plugin-manifest-malformed',
    message: `Malformed plugin manifest ${toPosixPath(file)}`,
  });
  return undefined;
}

const installedPluginsSchema = z.object({
  plugins: z.record(
    z.string(),
    z.array(
      z.object({
        scope: z.string().optional(),
        installPath: z.string().min(1),
        projectPath: z.string().optional(),
      }),
    ),
  ),
});

function samePath(a: string, b: string): boolean {
  const norm = (p: string) => {
    const resolved = toPosixPath(path.resolve(p)).replace(/\/+$/, '');
    return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
  };
  return norm(a) === norm(b);
}

interface PluginRoot {
  name: string;
  root: string;
}

/** Plugins from `plugins/installed_plugins.json` (marketplace installs). */
async function registryPlugins(
  claudeDir: string,
  workspace: string,
  ctx: Ctx,
): Promise<PluginRoot[]> {
  const file = path.join(claudeDir, 'plugins', 'installed_plugins.json');
  let text: string;
  try {
    text = await readFile(file, 'utf8');
  } catch {
    return [];
  }
  let registry: z.infer<typeof installedPluginsSchema>;
  try {
    const parsed = installedPluginsSchema.safeParse(JSON.parse(stripBom(text)));
    if (!parsed.success) throw new Error('invalid shape');
    registry = parsed.data;
  } catch {
    ctx.warnings.push({
      code: 'plugin-registry-malformed',
      message: `Malformed plugin registry ${toPosixPath(file)}`,
    });
    return [];
  }

  const roots: PluginRoot[] = [];
  for (const [key, installs] of Object.entries(registry.plugins)) {
    // Project/local installs only apply to their own project.
    const install = installs.find(
      (i) =>
        i.projectPath === undefined || i.scope === 'user' || samePath(i.projectPath, workspace),
    );
    if (!install) continue;
    if (!(await isDirectory(install.installPath))) {
      ctx.warnings.push({
        code: 'plugin-path-missing',
        message: `Install path of plugin ${key} not found: ${toPosixPath(install.installPath)}`,
      });
      continue;
    }
    const name = (await readPluginName(install.installPath, ctx)) ?? key.split('@')[0] ?? key;
    roots.push({ name, root: install.installPath });
  }
  return roots;
}

/**
 * Plugins synced from the account: `plugins/synced/<group>/<dir>/.claude-plugin/plugin.json`.
 * Not listed in CLAUDE.md; observed on Claude Code 2.1.318.
 */
async function syncedPlugins(claudeDir: string, ctx: Ctx): Promise<PluginRoot[]> {
  const base = path.join(claudeDir, 'plugins', 'synced');
  const roots: PluginRoot[] = [];
  for (const group of await listSubdirs(base, ctx)) {
    for (const dir of await listSubdirs(path.join(base, group), ctx)) {
      const root = path.join(base, group, dir);
      if (!(await isFile(path.join(root, '.claude-plugin', 'plugin.json')))) continue;
      const name = await readPluginName(root, ctx);
      if (name !== undefined) roots.push({ name, root });
    }
  }
  return roots;
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

export function defaultClaudeDir(homeDir: string): string {
  return path.join(homeDir, '.claude');
}

export async function scanFiles(options: FileScanOptions): Promise<FileScanResult> {
  const ctx: Ctx = { warnings: [] };
  const workspace = path.resolve(options.workspace);
  const claudeDir = path.resolve(options.claudeDir ?? defaultClaudeDir(options.homeDir));
  const projectDir = path.join(workspace, '.claude');
  // When the workspace is the home folder, the project folder is the user folder.
  const scanProject = !samePath(projectDir, claudeDir);

  const userSkillsDir = path.join(claudeDir, 'skills');
  const syncedRoot = path.join(userSkillsDir, 'synced');
  // `skills/synced` is the synced-skills container, unless it is itself a skill.
  const syncedIsContainer = !(await isFile(path.join(syncedRoot, 'SKILL.md')));

  // Sequential on purpose: keeps the order of warnings deterministic.
  const skillUser = await scanSkills(
    userSkillsDir,
    'skill-user',
    ctx,
    syncedIsContainer ? { skipDirs: ['synced'] } : {},
  );
  const skillProject = scanProject
    ? await scanSkills(path.join(projectDir, 'skills'), 'skill-project', ctx)
    : [];
  const customUser = await scanCommands(path.join(claudeDir, 'commands'), 'custom-user', ctx);
  const customProject = scanProject
    ? await scanCommands(path.join(projectDir, 'commands'), 'custom-project', ctx)
    : [];

  const skillSynced: FileItem[] = [];
  if (syncedIsContainer) {
    for (const group of await listSubdirs(syncedRoot, ctx)) {
      skillSynced.push(...(await scanSkills(path.join(syncedRoot, group), 'skill-synced', ctx)));
    }
  }

  const plugins: string[] = [];
  const pluginItems: FileItem[] = [];
  const roots = [
    ...(await registryPlugins(claudeDir, workspace, ctx)),
    ...(await syncedPlugins(claudeDir, ctx)),
  ];
  for (const { name, root } of roots) {
    if (plugins.includes(name)) continue;
    plugins.push(name);
    pluginItems.push(
      ...(await scanSkills(path.join(root, 'skills'), 'plugin', ctx, { plugin: name })),
      ...(await scanCommands(path.join(root, 'commands'), 'plugin', ctx, name)),
    );
  }

  return {
    // Priority on name clashes: user skills, project skills, user commands, project commands,
    // synced skills; plugins are namespaced.
    items: [
      ...skillUser,
      ...skillProject,
      ...customUser,
      ...customProject,
      ...skillSynced,
      ...pluginItems,
    ],
    plugins,
    warnings: ctx.warnings,
  };
}
