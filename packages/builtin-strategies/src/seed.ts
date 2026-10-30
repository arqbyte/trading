import type { Pool } from "@atrp/database";
import { validateStrategy } from "@atrp/strategy-dsl";
import { StrategyRegistry } from "@atrp/strategy-engine";
import { BUILTIN_AGENTS } from "./specs.js";

export interface SeedResult {
  slug: string;
  strategyId: string;
  versionId: string;
  agentId: string;
  created: boolean;
}

/**
 * Registers the built-in strategies and their agents. Idempotent: existing
 * strategies, versions and agents are reused. Agents are created paused;
 * starting them is an explicit administrator action.
 */
export async function seedBuiltinAgents(pool: Pool): Promise<SeedResult[]> {
  const registry = new StrategyRegistry(pool);
  const results: SeedResult[] = [];
  for (const { slug, agentName, spec } of BUILTIN_AGENTS) {
    const validated = validateStrategy(spec);
    if (!validated.ok) throw new Error(`Built-in strategy ${slug} is invalid: ${validated.errors.join("; ")}`);

    let created = false;
    let strategyId = (await pool.query<{ id: string }>("SELECT id FROM strategies WHERE slug = $1", [slug])).rows[0]?.id;
    if (!strategyId) {
      strategyId = await registry.createStrategy({
        slug,
        name: validated.spec.name,
        description: validated.spec.description,
        createdBy: "builtin",
      });
      created = true;
    }

    let versionId = (
      await pool.query<{ id: string }>("SELECT id FROM strategy_versions WHERE strategy_id = $1 AND spec_hash = $2", [
        strategyId,
        validated.hash,
      ])
    ).rows[0]?.id;
    if (!versionId) {
      versionId = (await registry.registerVersion(strategyId, spec, "builtin")).id;
      created = true;
    }

    const agent = await pool.query<{ id: string; inserted: boolean }>(
      `INSERT INTO agents (slug, name, strategy_id, status) VALUES ($1, $2, $3, 'paused')
       ON CONFLICT (slug) DO UPDATE SET name = EXCLUDED.name
       RETURNING id, (xmax = 0) AS inserted`,
      [slug, agentName, strategyId],
    );
    created ||= agent.rows[0]!.inserted;
    results.push({ slug, strategyId, versionId, agentId: agent.rows[0]!.id, created });
  }
  return results;
}
