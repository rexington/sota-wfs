import type { AzQueueDO } from "./az/queue-do";

export interface Env {
  DATA: R2Bucket;
  AZ_CACHE: KVNamespace;
  AZ_QUEUE: DurableObjectNamespace<AzQueueDO>;
  NREL_API_KEY?: string;
}
