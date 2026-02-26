// projects.ts — Project registry and handoff state management
// Manages which project is active, per-project session IDs, and git sync operations

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import type { Config } from "./config";
import type { SessionManager } from "./session";

// Registry schema — matches config/projects.json
export interface ProjectEntry {
  name: string;
  displayName: string;
  git: string;
  paths: {
    local: string;
    vps: string;
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

  constructor(
    private config: Config,
    private sessions: SessionManager,
  ) {}

  // Load project registry from disk
  async loadRegistry(): Promise<void> {
    try {
      const raw = await readFile(this.config.projectRegistryFile, "utf-8");
      this.registry = JSON.parse(raw) as ProjectRegistry;
      console.log(
        `[projects] Loaded registry: ${this.registry.projects.length} project(s)`,
      );
    } catch (err) {
      // Fall back to bundled config if pai-knowledge copy doesn't exist
      try {
        const bundledPath = new URL("../config/projects.json", import.meta.url)
          .pathname;
        const raw = await readFile(bundledPath, "utf-8");
        this.registry = JSON.parse(raw) as ProjectRegistry;
        console.log(
          `[projects] Loaded bundled registry: ${this.registry.projects.length} project(s)`,
        );
      } catch {
        console.warn(`[projects] No registry found, starting empty`);
        this.registry = { version: 1, projects: [] };
      }
    }
  }

  // Load handoff state from disk
  async loadState(): Promise<void> {
    try {
      const raw = await readFile(this.config.handoffStateFile, "utf-8");
      this.state = JSON.parse(raw) as HandoffState;
      console.log(
        `[projects] Loaded state: active=${this.state.activeProject || "none"}`,
      );
    } catch {
      console.log("[projects] No handoff state found, starting fresh");
    }
  }

  // Save handoff state to disk
  private async saveState(): Promise<void> {
    await mkdir(dirname(this.config.handoffStateFile), { recursive: true });
    await writeFile(
      this.config.handoffStateFile,
      JSON.stringify(this.state, null, 2) + "\n",
      "utf-8",
    );
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

  // Get the currently active project name
  getActiveProjectName(): string | null {
    return this.state.activeProject;
  }

  // Get the currently active project entry
  getActiveProject(): ProjectEntry | null {
    if (!this.state.activeProject) return null;
    return this.getProject(this.state.activeProject);
  }

  // Get the path for a project on this machine
  getProjectPath(project: ProjectEntry): string {
    // Detect if we're on the VPS or local by checking hostname or HOME
    const home = process.env.HOME || "";
    if (home.includes("isidore_cloud")) {
      return project.paths.vps;
    }
    return project.paths.local;
  }

  // Set the active project — saves state + updates session file
  async setActiveProject(
    name: string,
  ): Promise<{ project: ProjectEntry; path: string } | null> {
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

    const path = this.getProjectPath(project);
    console.log(`[projects] Switched to: ${project.displayName} (${path})`);
    return { project, path };
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

  // --- Knowledge sync (push/pull via sync-knowledge.sh) ---
  // Called explicitly by /project (pull) and /done (push).
  // NOT called per-message — bridge sets SKIP_KNOWLEDGE_SYNC to suppress hooks.

  async knowledgeSyncPull(): Promise<{ ok: boolean; output: string }> {
    return this.runKnowledgeSync("pull");
  }

  async knowledgeSyncPush(): Promise<{ ok: boolean; output: string }> {
    return this.runKnowledgeSync("push");
  }

  private async runKnowledgeSync(
    action: "push" | "pull",
  ): Promise<{ ok: boolean; output: string }> {
    try {
      const proc = Bun.spawn(
        ["bash", this.config.knowledgeSyncScript, action],
        {
          stdout: "pipe",
          stderr: "pipe",
          env: process.env,
        },
      );

      const timeout = setTimeout(() => proc.kill(), 30_000); // 30s timeout
      const stdout = await new Response(proc.stdout).text();
      const stderr = await new Response(proc.stderr).text();
      const exitCode = await proc.exited;
      clearTimeout(timeout);

      const output = (stdout + stderr).trim();
      if (exitCode === 0) {
        console.log(`[projects] Knowledge sync ${action} complete`);
      } else {
        console.warn(`[projects] Knowledge sync ${action} failed: ${output}`);
      }
      return { ok: exitCode === 0, output };
    } catch (err) {
      console.warn(`[projects] Knowledge sync ${action} error: ${err}`);
      return { ok: false, output: `Knowledge sync error: ${err}` };
    }
  }

  // --- Git sync operations (shell out to project-sync.sh) ---

  // Pull latest changes for a project
  async syncPull(project: ProjectEntry): Promise<{ ok: boolean; output: string }> {
    const dir = this.getProjectPath(project);
    return this.runSyncScript("pull", dir);
  }

  // Push changes for a project (git add -u + commit + push)
  async syncPush(project: ProjectEntry): Promise<{ ok: boolean; output: string }> {
    const dir = this.getProjectPath(project);
    return this.runSyncScript("push", dir);
  }

  // Ensure project directory exists, clone if needed
  async ensureCloned(
    project: ProjectEntry,
  ): Promise<{ ok: boolean; output: string }> {
    const dir = this.getProjectPath(project);

    try {
      // Check if directory exists
      const stat = await Bun.file(dir + "/.git/HEAD").exists();
      if (stat) {
        return { ok: true, output: "Already cloned" };
      }
    } catch {
      // Directory doesn't exist
    }

    if (!project.autoClone) {
      return {
        ok: false,
        output: `Project directory missing: ${dir} (autoClone is disabled)`,
      };
    }

    return this.runSyncScript("clone", project.git, dir);
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
