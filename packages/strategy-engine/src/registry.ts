import type { Pool } from "@atrp/database";
import { type StrategySpec, validateStrategy } from "@atrp/strategy-dsl";

export interface StrategyVersionRecord {
  id: string;
  strategyId: string;
  version: string;
  spec: StrategySpec;
  specHash: string;
  author: string;
  validationStatus: string;
  createdAt: Date;
}

export class StrategyValidationError extends Error {
  constructor(readonly errors: string[]) {
    super(`Invalid strategy: ${errors.join("; ")}`);
    this.name = "StrategyValidationError";
  }
}

const toRecord = (r: Record<string, unknown>): StrategyVersionRecord => ({
  id: r.id as string,
  strategyId: r.strategy_id as string,
  version: r.version as string,
  spec: r.spec as StrategySpec,
  specHash: r.spec_hash as string,
  author: r.author as string,
  validationStatus: r.validation_status as string,
  createdAt: r.created_at as Date,
});

/** Strategy registry backed by `strategies` / `strategy_versions` (PRD 6.5). */
export class StrategyRegistry {
  constructor(private readonly pool: Pool) {}

  async createStrategy(input: { slug: string; name: string; description?: string; createdBy: string }): Promise<string> {
    const { rows } = await this.pool.query<{ id: string }>(
      "INSERT INTO strategies (slug, name, description, created_by) VALUES ($1, $2, $3, $4) RETURNING id",
      [input.slug, input.name, input.description ?? "", input.createdBy],
    );
    return rows[0]!.id;
  }

  /**
   * Validates and stores a new immutable version. A spec whose logic is
   * identical to an existing version of the same strategy is rejected.
   */
  async registerVersion(strategyId: string, spec: unknown, author: string): Promise<StrategyVersionRecord> {
    const result = validateStrategy(spec);
    if (!result.ok) throw new StrategyValidationError(result.errors);
    const existing = await this.pool.query<{ version: string }>(
      "SELECT version FROM strategy_versions WHERE strategy_id = $1 AND spec_hash = $2",
      [strategyId, result.hash],
    );
    if (existing.rows[0]) {
      throw new StrategyValidationError([`identical to existing version ${existing.rows[0].version}`]);
    }
    const { rows } = await this.pool.query(
      `INSERT INTO strategy_versions (strategy_id, version, spec, parameters, spec_hash, author, validation_status, validation_report)
       VALUES ($1, $2, $3, '{}', $4, $5, 'valid', $6) RETURNING *`,
      [
        strategyId,
        result.spec.version,
        JSON.stringify(result.spec),
        result.hash,
        author,
        JSON.stringify({ static: "passed", warmupBars: result.warmupBars }),
      ],
    );
    return toRecord(rows[0]);
  }

  async getVersion(id: string): Promise<StrategyVersionRecord | undefined> {
    const { rows } = await this.pool.query("SELECT * FROM strategy_versions WHERE id = $1", [id]);
    return rows[0] ? toRecord(rows[0]) : undefined;
  }

  async listVersions(strategyId: string): Promise<StrategyVersionRecord[]> {
    const { rows } = await this.pool.query("SELECT * FROM strategy_versions WHERE strategy_id = $1 ORDER BY created_at", [
      strategyId,
    ]);
    return rows.map(toRecord);
  }
}
