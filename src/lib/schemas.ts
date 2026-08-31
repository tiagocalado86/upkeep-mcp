import * as z from 'zod/v4';

/**
 * Schema fragments every check shares.
 *
 * Sharing them is not just tidiness: `portfolio_report` (Phase 3) sorts findings
 * from all three checks into one list, and it can only do that if they are
 * literally the same shape.
 */

/** How much attention something needs. */
export const severitySchema = z
  .enum(['ok', 'info', 'warning', 'critical', 'unknown'])
  .describe(
    'How much attention this needs. "critical" means act now; "warning" means act this month; ' +
      '"unknown" means the check could not establish the fact, which is not the same as it being fine.',
  );

/** One actionable observation. */
export const findingSchema = z
  .object({
    code: z
      .string()
      .describe('Stable identifier for this kind of observation, e.g. "cert_expires_soon".'),
    severity: severitySchema,
    message: z.string().describe('One sentence explaining the observation in plain words.'),
  })
  .describe('One actionable observation about the target.');
