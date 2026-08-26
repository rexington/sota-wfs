/**
 * AzQueueDO — replaces the thread+queue AZ background worker from
 * sota_wfs/az.py with a single global Durable Object. One instance
 * (idFromName("global")) coordinates the two things that genuinely need a
 * single owner: the opentopodata rate limit (~1 req/s) and its daily call
 * budget — not the dataset itself, which stays in R2/KV.
 */
import { DurableObject } from "cloudflare:workers";
import { computeAz } from "./compute";
import { writeCache, isAlreadyCached } from "./serving";

const DAILY_CALL_BUDGET = 900; // opentopodata public limit is 1000 calls/day
const RATE_LIMIT_MS = 1100;
const BUDGET_RETRY_MS = 30 * 60 * 1000;

interface QueueItem {
  ref: string;
  lat: number;
  lon: number;
  alt: number;
}

interface Budget {
  day: string;
  calls: number;
}

interface Env {
  AZ_CACHE: KVNamespace;
}

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

export class AzQueueDO extends DurableObject<Env> {
  /** Batched so one GetFeature request enqueues its whole page of cache
   * misses in a single RPC call, instead of one call per summit. */
  async enqueue(items: QueueItem[]): Promise<void> {
    if (items.length === 0) return;
    const pending = (await this.ctx.storage.get<QueueItem[]>("pending")) ?? [];
    const known = new Set(pending.map((p) => p.ref));
    for (const item of items) {
      if (known.has(item.ref)) continue;
      known.add(item.ref);
      pending.push(item);
    }
    await this.ctx.storage.put("pending", pending);
    if ((await this.ctx.storage.getAlarm()) === null) {
      await this.ctx.storage.setAlarm(Date.now());
    }
  }

  /** Read-only introspection for debugging — not exposed publicly, just
   * callable from an ops script/temporary route. */
  async debugState(): Promise<{ pending: QueueItem[]; budget: Budget | null; nextAlarm: number | null }> {
    return {
      pending: (await this.ctx.storage.get<QueueItem[]>("pending")) ?? [],
      budget: (await this.ctx.storage.get<Budget>("budget")) ?? null,
      nextAlarm: await this.ctx.storage.getAlarm(),
    };
  }

  private async budgetOk(): Promise<boolean> {
    const budget = await this.ctx.storage.get<Budget>("budget");
    return !budget || budget.day !== today() || budget.calls < DAILY_CALL_BUDGET;
  }

  private async spend(calls: number): Promise<void> {
    let budget = await this.ctx.storage.get<Budget>("budget");
    if (!budget || budget.day !== today()) budget = { day: today(), calls: 0 };
    budget.calls += calls;
    await this.ctx.storage.put("budget", budget);
  }

  async alarm(): Promise<void> {
    const pending = (await this.ctx.storage.get<QueueItem[]>("pending")) ?? [];
    if (pending.length === 0) return;

    if (!(await this.budgetOk())) {
      console.log("az: daily elevation budget spent; retrying later");
      await this.ctx.storage.setAlarm(Date.now() + BUDGET_RETRY_MS);
      return;
    }

    const [item, ...rest] = pending as [QueueItem, ...QueueItem[]];
    await this.ctx.storage.put("pending", rest);

    if (await isAlreadyCached(this.env.AZ_CACHE, item.ref)) {
      // e.g. a bulk-precompute run (scripts/bulk-az.ts) landed while this
      // was still sitting in the queue — don't spend budget redoing it.
      console.log(`az: ${item.ref} already cached, skipping`);
    } else {
      try {
        const ring = await computeAz(item.ref, item.lat, item.lon, item.alt, (n) => this.spend(n));
        await writeCache(this.env.AZ_CACHE, item.ref, { ok: ring !== null, ring: ring ?? undefined });
        if (ring) console.log(`az: ${item.ref} cached (${ring.length} pts)`);
      } catch (exc) {
        console.log(`az: ${item.ref} failed: ${exc}`);
        await writeCache(this.env.AZ_CACHE, item.ref, { ok: false, error: String(exc) });
      }
    }

    if (rest.length > 0) {
      await this.ctx.storage.setAlarm(Date.now() + RATE_LIMIT_MS);
    }
  }
}
