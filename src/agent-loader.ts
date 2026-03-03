import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";

export interface AgentDefinition {
  id: string;
  name: string;
  description: string;
  executionTier: 1 | 2 | 3;
  memoryScope: "project" | "global" | "none";
  constraints: string[];
  delegationPermissions: string[];
  toolRestrictions: string[];
  selfRegister: boolean;
  systemPrompt: string;
}

export class AgentLoader {
  private agents: Map<string, AgentDefinition> = new Map();
  private agentsDir: string;

  constructor(agentsDir: string) {
    this.agentsDir = agentsDir;
  }

  async loadAll(): Promise<AgentDefinition[]> {
    const results: AgentDefinition[] = [];
    let files: string[];
    try {
      files = await readdir(this.agentsDir);
    } catch (err) {
      console.warn(`[agent-loader] Could not read agents directory: ${this.agentsDir}`, err);
      return results;
    }

    const mdFiles = files.filter((f) => f.endsWith(".md"));

    for (const file of mdFiles) {
      const id = file.replace(/\.md$/, "");
      const agent = await this.load(id);
      if (agent) {
        results.push(agent);
      }
    }

    console.log(`[agent-loader] Loaded ${results.length} agent definition(s) from ${this.agentsDir}`);
    return results;
  }

  async load(id: string): Promise<AgentDefinition | null> {
    const filePath = join(this.agentsDir, `${id}.md`);
    let content: string;
    try {
      content = await readFile(filePath, "utf-8");
    } catch (err) {
      console.warn(`[agent-loader] Could not read file: ${filePath}`, err);
      return null;
    }

    try {
      const agent = this.parseAgentFile(id, content);
      if (agent) {
        this.agents.set(id, agent);
      }
      return agent;
    } catch (err) {
      console.warn(`[agent-loader] Failed to parse agent file: ${filePath}`, err);
      return null;
    }
  }

  getAgent(id: string): AgentDefinition | undefined {
    return this.agents.get(id);
  }

  getAllAgents(): AgentDefinition[] {
    return Array.from(this.agents.values());
  }

  registerAll(registry: { register(id: string, name: string, capabilities: string[]): void }): void {
    for (const agent of this.agents.values()) {
      if (agent.selfRegister) {
        registry.register(agent.id, agent.name, []);
        console.log(`[agent-loader] Registered agent: ${agent.id} (${agent.name})`);
      }
    }
  }

  private parseAgentFile(id: string, content: string): AgentDefinition | null {
    if (!content.startsWith("---")) {
      console.warn(`[agent-loader] File ${id}.md has no frontmatter (missing opening ---)`);
      return null;
    }

    const closingIndex = content.indexOf("---", 3);
    if (closingIndex === -1) {
      console.warn(`[agent-loader] File ${id}.md has no closing --- for frontmatter`);
      return null;
    }

    const yamlStr = content.slice(3, closingIndex);
    const body = content.slice(closingIndex + 3).trim();

    let frontmatter: Record<string, unknown>;
    try {
      frontmatter = parseYaml(yamlStr) ?? {};
    } catch (err) {
      console.warn(`[agent-loader] Invalid YAML in ${id}.md`, err);
      return null;
    }

    if (typeof frontmatter !== "object" || frontmatter === null) {
      console.warn(`[agent-loader] Frontmatter in ${id}.md is not an object`);
      return null;
    }

    const name = frontmatter.name;
    if (typeof name !== "string" || name.length === 0) {
      console.warn(`[agent-loader] File ${id}.md missing required 'name' field in frontmatter`);
      return null;
    }

    const description = typeof frontmatter.description === "string" ? frontmatter.description : "";

    let executionTier = typeof frontmatter.execution_tier === "number" ? frontmatter.execution_tier : 3;
    executionTier = Math.max(1, Math.min(3, Math.round(executionTier))) as 1 | 2 | 3;

    const memoryScope = (["project", "global", "none"].includes(frontmatter.memory_scope as string)
      ? frontmatter.memory_scope
      : "project") as "project" | "global" | "none";

    const constraints = Array.isArray(frontmatter.constraints)
      ? frontmatter.constraints.filter((c: unknown) => typeof c === "string")
      : [];

    const delegationPermissions = Array.isArray(frontmatter.delegation_permissions)
      ? frontmatter.delegation_permissions.filter((d: unknown) => typeof d === "string")
      : [];

    const toolRestrictions = Array.isArray(frontmatter.tool_restrictions)
      ? frontmatter.tool_restrictions.filter((t: unknown) => typeof t === "string")
      : [];

    const selfRegister = typeof frontmatter.self_register === "boolean" ? frontmatter.self_register : true;

    return {
      id,
      name,
      description,
      executionTier: executionTier as 1 | 2 | 3,
      memoryScope,
      constraints,
      delegationPermissions,
      toolRestrictions,
      selfRegister,
      systemPrompt: body,
    };
  }
}
