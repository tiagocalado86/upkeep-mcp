/**
 * Running many independent jobs without running them all at once.
 */

/**
 * Maps over items, keeping at most `limit` jobs in flight.
 *
 * The per-host limiter in `rate-limit.ts` paces requests to any one host; this
 * bounds how many *sites* a portfolio run works on at a time. They solve
 * different problems: without this, a portfolio of eighty sites would build
 * eighty result objects and hold eighty timers before the first one finished,
 * and a single slow host would not slow anything down for long enough to notice.
 *
 * Results come back in the order of the input, not the order they finished, so
 * a report reads the same way twice.
 *
 * @param items What to work on.
 * @param limit Most jobs in flight at once. Values below 1 are treated as 1.
 * @param job What to do with each item. A rejection propagates, so callers that
 *   want partial results catch inside the job.
 * @returns The results, in input order.
 * @throws Whatever `job` throws, from the first job to reject.
 */
export async function mapWithConcurrency<In, Out>(
  items: readonly In[],
  limit: number,
  job: (item: In, index: number) => Promise<Out>,
): Promise<Out[]> {
  const results = new Array<Out>(items.length);
  const width = Math.max(1, Math.min(Math.trunc(limit), items.length));
  let next = 0;

  const worker = async (): Promise<void> => {
    while (next < items.length) {
      const index = next;
      next += 1;
      const item = items[index];
      if (item === undefined) continue;
      results[index] = await job(item, index);
    }
  };

  await Promise.all(Array.from({ length: width }, () => worker()));
  return results;
}
