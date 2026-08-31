import type { McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';

/**
 * Registers the `quarterly_report` prompt.
 *
 * The brief called this `relatorio-trimestral`. It is named in English like
 * everything else the repository publishes, because the audience for a public
 * MCP server is not only Portuguese-speaking — but the prompt itself asks for
 * the report in whatever language the client is written to, which is the part
 * that actually mattered.
 *
 * The prompt exists because the last mile of a retainer is not the checking, it
 * is the writing: turning "three sites have certificates expiring" into the
 * paragraph a client reads. It tells the model which tool to call and what the
 * finished text should look like, so that the report reads the same way every
 * quarter.
 *
 * @param server The server to register on.
 * @throws Never.
 */
export function registerQuarterlyReportPrompt(server: McpServer): void {
  server.registerPrompt(
    'quarterly_report',
    {
      title: 'Quarterly maintenance report',
      description:
        'Turns a portfolio run into the maintenance report a client reads: what was checked, ' +
        'what was found, what was done and what needs a decision. Use it at the end of a ' +
        'reporting period, after or instead of calling portfolio_report by hand.',
      argsSchema: z.object({
        period: z
          .string()
          .describe('The period being reported on, as the client should see it, e.g. "Q3 2026".'),
        tags: z
          .string()
          .optional()
          .describe(
            'Comma-separated tags limiting the report to part of the portfolio, e.g. ' +
              '"retainer,quarterly". Omit to report on every site.',
          ),
        language: z
          .string()
          .optional()
          .describe(
            'Language to write the report in, e.g. "Portuguese" or "English". Defaults to the ' +
              'language the conversation is already in.',
          ),
      }),
    },
    (args) => ({
      messages: [
        { role: 'user' as const, content: { type: 'text' as const, text: buildRequest(args) } },
      ],
    }),
  );
}

/**
 * Writes the request the model is asked to carry out.
 *
 * Separate from the registration so the wording can be tested directly. The
 * wording is the substance of a prompt: an instruction that omits "do not
 * invent anything the report does not contain" produces a confident report
 * about checks that never ran.
 *
 * @param args The prompt arguments.
 * @returns The message text.
 * @throws Never.
 */
export function buildRequest(args: {
  period: string;
  tags?: string | undefined;
  language?: string | undefined;
}): string {
  const { period, tags, language } = args;

  return [
    `Write the ${period} maintenance report for my client sites.`,
    '',
    'First call `portfolio_report`' +
      (tags === undefined ? '.' : ` with tags ${JSON.stringify(tags.split(','))}.`),
    '',
    'Then write the report itself, in this order:',
    '',
    '1. **One paragraph up front** saying whether everything is in order, and if not,',
    '   what is not. A client who reads only this paragraph should not be surprised',
    '   later.',
    '2. **What needs a decision from them** — renewals to approve, expiries coming up,',
    '   anything that costs money or needs their say-so. Give the date and the',
    '   consequence of doing nothing.',
    '3. **What was found and handled** — the warnings that do not need them, so the work',
    '   is visible.',
    '4. **A table of every site**, with its status this period.',
    '',
    'Rules for the writing:',
    '',
    '- No jargon a client would have to look up. "The certificate that proves the site',
    '  is genuine expires on 14 March" beats "TLS leaf cert expiry".',
    '- Give every date in full, and say how many days away it is.',
    '- Do not invent anything the report does not contain. If a check could not run,',
    '  say that it could not run and why.',
    '- Say what changed since the previous run only if the report says it was compared;',
    '  if it was not, do not imply stability that was not measured.',
    language === undefined ? '' : `- Write it in ${language}.`,
  ]
    .filter((line) => line !== '')
    .join('\n');
}
