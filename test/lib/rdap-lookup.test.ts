import { readFileSync } from 'node:fs';
import { MockAgent, setGlobalDispatcher, getGlobalDispatcher, type Dispatcher } from 'undici';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CheckError } from '../../src/lib/errors.js';
import { lookupDomain } from '../../src/lib/rdap.js';

/**
 * These exercise `lookupDomain` end to end over a mocked network, bootstrap
 * included. The bootstrap is fetched once per process and cached, which is
 * deliberate behaviour and is asserted here rather than worked around.
 */
const NOW = new Date('2026-08-31T12:00:00.000Z');

const exampleCom = readFileSync(
  new URL('../fixtures/rdap-example-com.json', import.meta.url),
  'utf8',
);

const BOOTSTRAP = {
  version: '1.0',
  services: [
    [['com'], ['https://rdap.verisign.test/com/v1/']],
    [['de'], ['https://rdap.denic.test/']],
  ],
};

let agent: MockAgent;
let original: Dispatcher;
let bootstrapRequests = 0;

beforeAll(() => {
  original = getGlobalDispatcher();
  agent = new MockAgent();
  agent.disableNetConnect();
  setGlobalDispatcher(agent);

  agent
    .get('https://data.iana.org')
    .intercept({ path: '/rdap/dns.json', method: 'GET' })
    .reply(
      200,
      () => {
        bootstrapRequests += 1;
        return BOOTSTRAP;
      },
      { headers: { 'content-type': 'application/json', 'cache-control': 'max-age=86400' } },
    )
    .persist();
});

afterAll(async () => {
  setGlobalDispatcher(original);
  await agent.close();
});

describe('lookupDomain', () => {
  it('reads a registration from the registry the bootstrap points at', async () => {
    agent
      .get('https://rdap.verisign.test')
      .intercept({ path: '/com/v1/domain/example.com', method: 'GET' })
      .reply(200, exampleCom, { headers: { 'content-type': 'application/rdap+json' } });

    const { registration, delegationSigned } = await lookupDomain('example.com', NOW);

    expect(registration).toMatchObject({
      source: 'rdap',
      rdapServer: 'https://rdap.verisign.test/com/v1/',
      ianaRegistrarId: '376',
      expiresAt: '2027-08-13T04:00:00.000Z',
      unavailableReason: null,
    });
    expect(registration.statuses).toContain('client transfer prohibited');
    expect(registration.daysUntilExpiry).toBe(346);
    expect(delegationSigned).not.toBeUndefined();
  });

  it('says which registry publishes no expiry date rather than reporting an unknown', async () => {
    agent
      .get('https://rdap.denic.test')
      .intercept({ path: '/domain/example.de', method: 'GET' })
      .reply(200, { objectClassName: 'domain', ldhName: 'example.de', status: ['connect'] });

    const { registration } = await lookupDomain('example.de', NOW);

    expect(registration.expiresAt).toBeNull();
    expect(registration.daysUntilExpiry).toBeNull();
    expect(registration.unavailableReason).toContain('.de');
  });

  it('reports a domain the registry does not know as not_found', async () => {
    agent
      .get('https://rdap.verisign.test')
      .intercept({ path: '/com/v1/domain/nothere.com', method: 'GET' })
      .reply(404, { errorCode: 404 });

    const error = await lookupDomain('nothere.com', NOW).catch((cause: unknown) => cause);

    expect(error).toBeInstanceOf(CheckError);
    expect((error as CheckError).code).toBe('not_found');
  });

  it('says so when a TLD publishes no RDAP service at all, without failing', async () => {
    const { registration } = await lookupDomain('example.invalidtld', NOW);

    expect(registration).toMatchObject({ source: 'unavailable', rdapServer: null });
    expect(registration.unavailableReason).toContain('.invalidtld');
  });

  it('fetches the bootstrap once for the whole process, not once per lookup', () => {
    // Twenty .com domains in a portfolio must not mean twenty requests to IANA.
    expect(bootstrapRequests).toBe(1);
  });
});
