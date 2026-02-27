// verifier.ts — Phase 6B: Independent verification of pipeline/orchestrator results
// Spawns a separate Claude one-shot to verify task output against the original prompt.
// FAIL-OPEN: On verifier error or timeout, returns { passed: true } — never blocks on broken verifier.

import type { Config } from "./config";

export interface VerificationResult {
  passed: boolean;
  verdict?: string;
  concerns?: string;
}

export class Verifier {
  private claudeBinary: string;
  private timeoutMs: number;

  constructor(config: Config) {
    this.claudeBinary = config.claudeBinary;
    this.timeoutMs = config.verifierTimeoutMs;
  }

  // Verify a task result against the original prompt
  // cwd is optional — used to get git diff for context
  async verify(
    taskPrompt: string,
    resultText: string,
    cwd?: string,
  ): Promise<VerificationResult> {
    try {
      // Get git diff for additional context (best-effort)
      let diffContext = "";
      if (cwd) {
        try {
          const diffProc = Bun.spawn(
            ["git", "diff", "HEAD~1", "--stat", "-p"],
            {
              stdout: "pipe",
              stderr: "pipe",
              cwd,
            },
          );
          const diffTimeout = setTimeout(() => diffProc.kill(), 5000);
          const diffOutput = await new Response(diffProc.stdout).text();
          await diffProc.exited;
          clearTimeout(diffTimeout);
          // Cap diff at 8KB
          diffContext = diffOutput.slice(0, 8192);
        } catch {
          // No diff available — that's fine
        }
      }

      // Build verification prompt
      const prompt = this.buildPrompt(taskPrompt, resultText, diffContext);

      // Spawn separate Claude one-shot (no session, suppressed hooks)
      const proc = Bun.spawn(
        [this.claudeBinary, "-p", prompt, "--output-format", "json"],
        {
          stdout: "pipe",
          stderr: "pipe",
          cwd,
          env: {
            ...process.env,
            ANTHROPIC_API_KEY: undefined,
            SKIP_KNOWLEDGE_SYNC: "1",
          },
        },
      );

      const timeout = setTimeout(() => proc.kill(), this.timeoutMs);
      const stdout = await new Response(proc.stdout).text();
      const exitCode = await proc.exited;
      clearTimeout(timeout);

      if (exitCode !== 0) {
        // Fail-open: verifier error → pass
        console.warn(`[verifier] Verifier exited ${exitCode}, fail-open → pass`);
        return { passed: true };
      }

      // Parse Claude response
      let resultContent: string;
      try {
        const parsed = JSON.parse(stdout);
        resultContent = parsed.result || stdout;
      } catch {
        resultContent = stdout.trim();
      }

      // Parse verdict: "PASS: reason" or "FAIL: reason"
      return this.parseVerdict(resultContent);
    } catch (err) {
      // Fail-open: any error → pass
      console.warn(`[verifier] Verification error, fail-open → pass: ${err}`);
      return { passed: true };
    }
  }

  private buildPrompt(
    taskPrompt: string,
    resultText: string,
    diffContext: string,
  ): string {
    let prompt = `You are a code verification agent. Review the following task and its result.

TASK:
${taskPrompt.slice(0, 2000)}

RESULT:
${resultText.slice(0, 4000)}`;

    if (diffContext) {
      prompt += `

GIT DIFF:
${diffContext}`;
    }

    prompt += `

INSTRUCTIONS:
1. Does the result address the task prompt?
2. Are there obvious errors, security issues, or missing requirements?
3. Does the git diff (if present) align with the claimed result?

Respond with EXACTLY one line:
- "PASS: <brief reason>" if the result looks correct
- "FAIL: <brief reason>" if there are clear problems

Do not explain further. One line only.`;

    return prompt;
  }

  private parseVerdict(content: string): VerificationResult {
    const lines = content.trim().split("\n");
    // Find the first line that starts with PASS or FAIL
    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed.startsWith("PASS:")) {
        return { passed: true, verdict: trimmed };
      }
      if (trimmed.startsWith("FAIL:")) {
        return {
          passed: false,
          verdict: trimmed,
          concerns: trimmed.slice(5).trim(),
        };
      }
    }

    // No clear verdict — fail-open
    console.warn("[verifier] No PASS/FAIL verdict found, fail-open → pass");
    return { passed: true, verdict: content.slice(0, 200) };
  }
}
