// projects.ts — Project registry and handoff state management
// Manages which project is active, per-project session IDs, and git sync operations

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import type { Config } from "./config";
import type { SessionManager } from "./session";
import type { MemoryStore } from "./memory";

// Registry schema — matches config/projects.json
export interface ProjectEntry {
  name: string;
  displayName: string;
  git: string;
  paths: {
    local: string | null;
    vps: string | null;
  };
  autoClone: boolean;
  active: boolean;
}

interface ProjectRegistry {
  version: number;
  projects: ProjectEntry[];
}

// Handoff state — persists across bridge restarts
interface HandoffState {
  activeProject: string | null;
  lastSwitch: string | null;
  sessions: Record<string, string>; // project name → session ID
}

export class ProjectManager {
  private registry: ProjectRegistry | null = null;
  private state: HandoffState = {
    activeProject: null,
    lastSwitch: null,
    sessions: {},
  };
  private memoryStore: MemoryStore | null = null;

  constructor(
    private config: Config,
    private sessions: SessionManager,
  ) {}

  /** Wire memory store for state persistence (replaces handoff-state.json). */
  setMemoryStore(store: MemoryStore): void {
    this.memoryStore = store;
  }

  // Load project registry from bundled config/projects.json
  async loadRegistry(): Promise<void> {
    try {
      const bundledPath = new URL("../config/projects.json", import.meta.url)
        .pathname;
      const raw = await readFile(bundledPath, "utf-8");
      this.registry = JSON.parse(raw) as ProjectRegistry;
      console.log(
        `[projects] Loaded registry: ${this.registry.projects.length} project(s)`,
      );
    } catch {
      console.warn(`[projects] No registry found, starting empty`);
      this.registry = { version: 1, projects: [] };
    }
  }

  // Load handoff state — prefer memory.db, fall back to file
  async loadState(): Promise<void> {
    // Try memory.db first
    if (this.memoryStore) {
      try {
        const activeProject = this.memoryStore.getSystemState("active_project");
        const sessionsJson = this.memoryStore.getSystemState("project_sessions");
        if (activeProject !== null || sessionsJson !== null) {
          this.state.activeProject = activeProject;
          this.state.sessions = sessionsJson ? JSON.parse(sessionsJson) : {};
          this.state.lastSwitch = this.memoryStore.getSystemState("last_switch");
          console.log(
            `[projects] Loaded state from memory.db: active=${this.state.activeProject || "none"}`,
          );
          return;
        }
      } catch (err) {
        console.warn(`[projects] Memory state read failed, falling back to file: ${err}`);
      }
    }

    // Fall back to file
    try {
      const raw = await readFile(this.config.handoffStateFile, "utf-8");
      this.state = JSON.parse(raw) as HandoffState;
      console.log(
        `[projects] Loaded state from file: active=${this.state.activeProject || "none"}`,
      );
      // Migrate to memory.db if available
      if (this.memoryStore) {
        this.saveStateToMemory();
        console.log("[projects] Migrated state from file to memory.db");
      }
    } catch {
      console.log("[projects] No handoff state found, starting fresh");
    }
  }

  // Save handoff state — prefer memory.db, fall back to file
  private async saveState(): Promise<void> {
    if (this.memoryStore) {
      this.saveStateToMemory();
      return;
    }
    // Fall back to file
    await mkdir(dirname(this.config.handoffStateFile), { recursive: true });
    await writeFile(
      this.config.handoffStateFile,
      JSON.stringify(this.state, null, 2) + "\n",
      "utf-8",
    );
  }

  // Write state to memory.db knowledge table
  private saveStateToMemory(): void {
    if (!this.memoryStore) return;
    this.memoryStore.setSystemState("active_project", this.state.activeProject || "");
    this.memoryStore.setSystemState("project_sessions", JSON.stringify(this.state.sessions));
    this.memoryStore.setSystemState("last_switch", this.state.lastSwitch || "");
  }

  // Get a project by name (case-insensitive partial match)
  getProject(name: string): ProjectEntry | null {
    if (!this.registry) return null;
    const lower = name.toLowerCase();
    return (
      this.registry.projects.find(
        (p) =>
          p.active &&
          (p.name.toLowerCase() === lower ||
            p.displayName.toLowerCase() === lower ||
            p.name.toLowerCase().includes(lower)),
      ) || null
    );
  }

  // List all active projects
  listProjects(): ProjectEntry[] {
    if (!this.registry) return [];
    return this.registry.projects.filter((p) => p.active);
  }

  // Clear active project (used when switching back to workspace mode)
  async clearActiveProject(): Promise<void> {
    if (this.state.activeProject) {
      // Save current session before clearing
      const currentSession = await this.sessions.current();
      if (currentSession) {
        this.state.sessions[this.state.activeProject] = currentSession;
      }
      this.state.activeProject = null;
      this.state.lastSwitch = new Date().toISOString();
      await this.saveState();
    }
  }

  // Get the currently active project name
  getActiveProjectName(): string | null {
    return this.state.activeProject;
  }

  // Get the currently active project entry
  getActiveProject(): ProjectEntry | null {
    if (!this.state.activeProject) return null;
    return this.getProject(this.state.activeProject);
  }

  // Get the path for a project on this machine (null if not available here)
  getProjectPath(project: ProjectEntry): string | null {
    // Detect if we're on the VPS or local by checking hostname or HOME
    const home = process.env.HOME || "";
    if (home.includes("isidore_cloud")) {
      return project.paths.vps;
    }
    return project.paths.local;
  }

  // Auto-detect project path when not configured for this machine.
  // Checks conventional ~/projects/<name> location. Returns detected path or null.
  private async autoDetectPath(project: ProjectEntry): Promise<string | null> {
    const home = process.env.HOME || "";
    const isVps = home.includes("isidore_cloud");

    // Only detect if the relevant path field is null
    if (isVps && project.paths.vps !== null) return null;
    if (!isVps && project.paths.local !== null) return null;

    const conventionalPath = `${home}/projects/${project.name}`;
    try {
      const exists = await Bun.file(`${conventionalPath}/.git/HEAD`).exists();
      if (!exists) return null;
    } catch {
      return null;
    }

    // Found a valid clone — save to registry
    if (isVps) {
      project.paths.vps = conventionalPath;
    } else {
      project.paths.local = conventionalPath;
    }
    await this.saveRegistry();
    console.log(`[projects] Auto-detected path: ${conventionalPath}`);
    return conventionalPath;
  }

  // Set the active project — saves state + updates session file
  // Returns null if project not found, or { project, path, autoDetected } on success.
  // path may be null if the project has no path on this instance.
  async setActiveProject(
    name: string,
  ): Promise<{ project: ProjectEntry; path: string | null; autoDetected: boolean } | null> {
    const project = this.getProject(name);
    if (!project) return null;

    // Save current project's session ID before switching
    if (this.state.activeProject) {
      const currentSession = await this.sessions.current();
      if (currentSession) {
        this.state.sessions[this.state.activeProject] = currentSession;
      }
    }

    // Switch to new project
    this.state.activeProject = project.name;
    this.state.lastSwitch = new Date().toISOString();

    // Restore the new project's session ID (or clear for fresh start)
    const savedSession = this.state.sessions[project.name];
    if (savedSession) {
      await this.sessions.saveSession(savedSession);
    } else {
      await this.sessions.newSession();
    }

    await this.saveState();

    let path = this.getProjectPath(project);
    let autoDetected = false;
    if (!path) {
      path = await this.autoDetectPath(project);
      autoDetected = path !== null;
    }

    console.log(`[projects] Switched to: ${project.displayName} (${path || "no local path"}${autoDetected ? " — auto-detected" : ""})`);
    return { project, path, autoDetected };
  }

  // Get session ID for a specific project
  getSessionForProject(name: string): string | null {
    return this.state.sessions[name] || null;
  }

  // Save session ID for a specific project
  async saveSessionForProject(name: string, sessionId: string): Promise<void> {
    this.state.sessions[name] = sessionId;
    await this.saveState();
  }

  // --- Project creation ---

  // GitHub org for new repos — matches mj-deving account
  private static readonly GITHUB_ORG = "mj-deving";
  // Base directory for VPS projects
  private static readonly VPS_PROJECTS_DIR = "/home/isidore_cloud/projects";

  // Validate project name: lowercase kebab-case only
  static isValidName(name: string): boolean {
    return /^[a-z0-9]+(-[a-z0-9]+)*$/.test(name);
  }

  // Derive display name from kebab-case slug: my-cool-project → My Cool Project
  static toDisplayName(name: string): string {
    return name
      .split("-")
      .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
      .join(" ");
  }

  // Create a new project: GitHub repo + VPS directory + scaffold + registry
  // Returns the new ProjectEntry on success, or { error: string } on failure.
  async createProject(
    name: string,
  ): Promise<{ project: ProjectEntry } | { error: string }> {
    // 1. Validate name format
    if (!ProjectManager.isValidName(name)) {
      return {
        error: `Invalid name "${name}". Use lowercase kebab-case (e.g. my-project).`,
      };
    }

    // 2. Check for duplicates
    if (!this.registry) {
      return { error: "Registry not loaded." };
    }
    const existing = this.registry.projects.find(
      (p) => p.name.toLowerCase() === name.toLowerCase(),
    );
    if (existing) {
      return { error: `Project "${name}" already exists.` };
    }

    const displayName = ProjectManager.toDisplayName(name);
    const gitUrl = `https://github.com/${ProjectManager.GITHUB_ORG}/${name}.git`;
    const vpsPath = `${ProjectManager.VPS_PROJECTS_DIR}/${name}`;
    const today = new Date().toISOString().split("T")[0];

    // 3. Create GitHub repo (private)
    console.log(`[projects] Creating GitHub repo: ${ProjectManager.GITHUB_ORG}/${name}`);
    const ghResult = await this.runCommand(
      "gh",
      ["repo", "create", `${ProjectManager.GITHUB_ORG}/${name}`, "--private", "--confirm"],
      60_000,
    );
    if (!ghResult.ok) {
      return { error: `GitHub repo creation failed: ${ghResult.output}` };
    }

    // 4. Clone into VPS projects directory
    console.log(`[projects] Cloning into ${vpsPath}`);
    const cloneResult = await this.runCommand(
      "git",
      ["clone", gitUrl, vpsPath],
      60_000,
    );
    if (!cloneResult.ok) {
      return { error: `Clone failed: ${cloneResult.output}` };
    }

    // 5. Write scaffold CLAUDE.md
    const claudeMd = `# CLAUDE.md — ${name}

## What This Is

${displayName}

**Owner:** Marius
**GitHub:** [${ProjectManager.GITHUB_ORG}/${name}](https://github.com/${ProjectManager.GITHUB_ORG}/${name})
**Created:** ${today}

## Tech Stack

<!-- Fill in as the project evolves -->

## Conventions

- Commit messages: clear "why", prefixed by area when helpful
- Every session should end with a commit capturing the work done
- Code comments: thorough — document interfaces and logic
- File naming: kebab-case

## Current State

**Status:** New project, just created
**Last session:** ${today}
`;
    try {
      await writeFile(`${vpsPath}/CLAUDE.md`, claudeMd, "utf-8");
    } catch (err) {
      return { error: `Failed to write CLAUDE.md: ${err}` };
    }

    // 6. Initial commit + push
    const commitResult = await this.runCommand(
      "git",
      ["-C", vpsPath, "add", "-A"],
      10_000,
    );
    if (commitResult.ok) {
      await this.runCommand(
        "git",
        ["-C", vpsPath, "commit", "-m", `init: scaffold ${displayName}`],
        10_000,
      );
      await this.runCommand(
        "git",
        ["-C", vpsPath, "push", "-u", "origin", "main"],
        30_000,
      );
    }

    // 7. Build registry entry
    const entry: ProjectEntry = {
      name,
      displayName,
      git: gitUrl,
      paths: {
        local: null, // Cloud-only until cloned locally
        vps: vpsPath,
      },
      autoClone: true,
      active: true,
    };

    // 8. Add to registry + save
    this.registry.projects.push(entry);
    await this.saveRegistry();

    console.log(`[projects] Created project: ${displayName}`);
    return { project: entry };
  }

  // Delete a project: remove from registry + clean handoff state
  // Does NOT delete VPS directory or GitHub repo (too destructive for Telegram).
  async deleteProject(
    name: string,
  ): Promise<{ project: ProjectEntry } | { error: string }> {
    if (!this.registry) {
      return { error: "Registry not loaded." };
    }

    // Exact case-insensitive match only — no partial matching for deletion
    const idx = this.registry.projects.findIndex(
      (p) => p.name.toLowerCase() === name.toLowerCase(),
    );
    if (idx === -1) {
      return { error: `Project "${name}" not found in registry.` };
    }

    const removed = this.registry.projects.splice(idx, 1)[0]!;

    // Clean handoff state
    if (this.state.sessions[removed.name]) {
      delete this.state.sessions[removed.name];
    }
    if (this.state.activeProject === removed.name) {
      this.state.activeProject = null;
      this.state.lastSwitch = new Date().toISOString();
    }
    await this.saveState();

    // Save updated registry to both locations
    await this.saveRegistry();

    console.log(`[projects] Deleted project: ${removed.displayName}`);
    return { project: removed };
  }

  // Save registry to bundled config/projects.json
  private async saveRegistry(): Promise<void> {
    if (!this.registry) return;

    const json = JSON.stringify(this.registry, null, 2) + "\n";
    const bundledPath = new URL("../config/projects.json", import.meta.url).pathname;
    try {
      await writeFile(bundledPath, json, "utf-8");
    } catch (err) {
      console.warn(`[projects] Failed to save registry: ${err}`);
    }
  }

  // Run a command with timeout, returning { ok, output }
  private async runCommand(
    cmd: string,
    args: string[],
    timeoutMs: number,
  ): Promise<{ ok: boolean; output: string }> {
    try {
      const proc = Bun.spawn([cmd, ...args], {
        stdout: "pipe",
        stderr: "pipe",
        env: process.env,
      });

      const timer = setTimeout(() => proc.kill(), timeoutMs);
      const stdout = await new Response(proc.stdout).text();
      const stderr = await new Response(proc.stderr).text();
      const exitCode = await proc.exited;
      clearTimeout(timer);

      return { ok: exitCode === 0, output: (stdout + stderr).trim() };
    } catch (err) {
      return { ok: false, output: `Command error: ${err}` };
    }
  }

  // --- Git sync operations (shell out to project-sync.sh) ---

  // Pull latest changes for a project
  async syncPull(project: ProjectEntry): Promise<{ ok: boolean; output: string }> {
    const dir = this.getProjectPath(project);
    if (!dir) return { ok: true, output: "No path on this instance — skipped" };
    return this.runSyncScript("pull", dir);
  }

  // Force pull — discard local changes and reset to origin/main
  async syncForcePull(project: ProjectEntry): Promise<{ ok: boolean; output: string }> {
    const dir = this.getProjectPath(project);
    if (!dir) return { ok: true, output: "No path on this instance — skipped" };
    return this.runSyncScript("force-pull", dir);
  }

  // Push changes for a project (git add -u + commit + push)
  async syncPush(project: ProjectEntry): Promise<{ ok: boolean; output: string }> {
    const dir = this.getProjectPath(project);
    if (!dir) return { ok: true, output: "No path on this instance — skipped" };
    return this.runSyncScript("push", dir);
  }

  // Ensure project directory exists, clone if needed
  async ensureCloned(
    project: ProjectEntry,
  ): Promise<{ ok: boolean; output: string; autoDetected?: boolean }> {
    let dir = this.getProjectPath(project);
    let autoDetected = false;
    if (!dir) {
      // Try auto-detection (finds existing clones at ~/projects/<name>)
      dir = await this.autoDetectPath(project);
      if (dir) {
        autoDetected = true;
      }
    }

    // Already cloned?
    if (dir) {
      try {
        const stat = await Bun.file(dir + "/.git/HEAD").exists();
        if (stat) {
          return { ok: true, output: "Already cloned", autoDetected };
        }
      } catch {
        // Directory doesn't exist — fall through to clone
      }
    }

    if (!project.autoClone) {
      return {
        ok: false,
        output: `Project directory missing: ${dir || "no path"} (autoClone is disabled)`,
      };
    }

    // Derive conventional clone target if no path configured
    if (!dir) {
      const home = process.env.HOME || "";
      dir = `${home}/projects/${project.name}`;
    }

    const result = await this.runSyncScript("clone", project.git, dir);
    if (result.ok) {
      // Persist the path in registry so future switches skip cloning
      const home = process.env.HOME || "";
      const isVps = home.includes("isidore_cloud");
      if (isVps) {
        project.paths.vps = dir;
      } else {
        project.paths.local = dir;
      }
      await this.saveRegistry();
      console.log(`[projects] Cloned and registered: ${dir}`);
    }
    return { ...result, autoDetected: true };
  }

  // Run the project-sync.sh script with given args
  private async runSyncScript(
    ...args: string[]
  ): Promise<{ ok: boolean; output: string }> {
    try {
      const proc = Bun.spawn(
        ["bash", this.config.projectSyncScript, ...args],
        {
          stdout: "pipe",
          stderr: "pipe",
          env: process.env,
        },
      );

      const timeout = setTimeout(() => proc.kill(), 90_000); // 90s total timeout
      const stdout = await new Response(proc.stdout).text();
      const stderr = await new Response(proc.stderr).text();
      const exitCode = await proc.exited;
      clearTimeout(timeout);

      const output = (stdout + stderr).trim();
      return { ok: exitCode === 0, output };
    } catch (err) {
      return { ok: false, output: `Sync script error: ${err}` };
    }
  }
}
