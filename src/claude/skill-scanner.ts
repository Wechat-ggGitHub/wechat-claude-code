import { readdirSync, readFileSync, existsSync, statSync, type Dirent } from 'node:fs';
import { join, basename } from 'node:path';
import { homedir } from 'node:os';
import { logger } from '../logger.js';

export interface SkillInfo {
  name: string;
  description: string;
  path: string;
}

/**
 * Parse YAML-like frontmatter from a SKILL.md or .md file.
 * Only extracts `name` and `description` fields.
 */
function parseSkillMd(filePath: string): { name: string; description: string } | null {
  try {
    const content = readFileSync(filePath, 'utf-8');
    const match = content.match(/^---\n([\s\S]*?)\n---/);
    if (!match) return null;

    const frontmatter = match[1];
    const nameMatch = frontmatter.match(/^name:\s*(.+)$/m);
    const descMatch = frontmatter.match(/^description:\s*(.+)$/m);

    if (!nameMatch) return null;

    return {
      name: nameMatch[1].trim().replace(/^["']|["']$/g, ''),
      description: descMatch ? descMatch[1].trim().replace(/^["']|["']$/g, '') : '',
    };
  } catch {
    logger.warn(`Failed to read skill file: ${filePath}`);
    return null;
  }
}

/**
 * Recursively find all SKILL.md files in a directory tree.
 */
function findSkillFiles(dir: string, maxDepth: number = 5, currentDepth: number = 0): string[] {
  const files: string[] = [];

  if (currentDepth >= maxDepth || !existsSync(dir)) return files;

  let entries: Dirent[];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return files;
  }

  for (const entry of entries) {
    const fullPath = join(dir, entry.name);

    if (entry.isDirectory()) {
      // Recurse into subdirectories
      files.push(...findSkillFiles(fullPath, maxDepth, currentDepth + 1));
    } else if (entry.name === 'SKILL.md') {
      files.push(fullPath);
    }
  }

  return files;
}

/**
 * Scan ~/.claude/commands/ for .md files (user commands are also skills).
 */
function scanCommandsDir(commandsDir: string): SkillInfo[] {
  const skills: SkillInfo[] = [];

  if (!existsSync(commandsDir)) return skills;

  let entries: Dirent[];
  try {
    entries = readdirSync(commandsDir, { withFileTypes: true });
  } catch {
    return skills;
  }

  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.md')) continue;

    const filePath = join(commandsDir, entry.name);
    const info = parseSkillMd(filePath);
    if (info) {
      skills.push({ ...info, path: filePath });
    }
  }

  return skills;
}

/**
 * Scan ~/.claude/skills/ for SKILL.md files (each subdirectory is a skill).
 */
function scanSkillsDir(skillsDir: string): SkillInfo[] {
  const skills: SkillInfo[] = [];

  if (!existsSync(skillsDir)) return skills;

  let entries: Dirent[];
  try {
    entries = readdirSync(skillsDir, { withFileTypes: true });
  } catch {
    return skills;
  }

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;

    const skillFile = join(skillsDir, entry.name, 'SKILL.md');
    if (existsSync(skillFile)) {
      const info = parseSkillMd(skillFile);
      if (info) {
        skills.push({ ...info, path: join(skillsDir, entry.name) });
      }
    }
  }

  return skills;
}

/**
 * Scan all known skill directories for installed Claude Code skills.
 *
 * Locations scanned:
 * 1. ~/.claude/skills/<name>/SKILL.md (user skills)
 * 2. ~/.claude/commands/<name>.md (user commands)
 * 3. ~/.claude/plugins/cache/<...>/SKILL.md (plugin skills, recursive)
 */
export function scanAllSkills(): SkillInfo[] {
  const home = homedir();
  const claudeDir = join(home, '.claude');
  const skills: SkillInfo[] = [];
  const seen = new Set<string>();

  // 1. ~/.claude/skills/*/
  const userSkillsDir = join(claudeDir, 'skills');
  for (const skill of scanSkillsDir(userSkillsDir)) {
    if (!seen.has(skill.name)) {
      seen.add(skill.name);
      skills.push(skill);
    }
  }

  // 2. ~/.claude/commands/*.md
  const userCommandsDir = join(claudeDir, 'commands');
  for (const skill of scanCommandsDir(userCommandsDir)) {
    if (!seen.has(skill.name)) {
      seen.add(skill.name);
      skills.push(skill);
    }
  }

  // 3. ~/.claude/plugins/cache/**/SKILL.md (recursive search)
  const pluginsCacheDir = join(claudeDir, 'plugins', 'cache');
  if (existsSync(pluginsCacheDir)) {
    const skillFiles = findSkillFiles(pluginsCacheDir, 6);
    for (const filePath of skillFiles) {
      const info = parseSkillMd(filePath);
      if (info && !seen.has(info.name)) {
        seen.add(info.name);
        skills.push({ ...info, path: filePath });
      }
    }
  }

  logger.info(`Scanned ${skills.length} skills`);
  return skills;
}

/**
 * Format a list of skills into a readable string for display.
 */
export function formatSkillList(skills: SkillInfo[]): string {
  if (skills.length === 0) {
    return 'No skills found.';
  }

  const lines = skills.map((s, i) => {
    const desc = s.description ? ` - ${s.description}` : '';
    return `  ${i + 1}. ${s.name}${desc}`;
  });

  return `Available skills (${skills.length}):\n${lines.join('\n')}`;
}

/**
 * Find a skill by name (case-insensitive match).
 */
export function findSkill(skills: SkillInfo[], name: string): SkillInfo | undefined {
  const lower = name.toLowerCase();
  return skills.find(
    (s) => s.name.toLowerCase() === lower || s.name.toLowerCase().replace(/\s+/g, '-') === lower,
  );
}
