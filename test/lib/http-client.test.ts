import { MockAgent, setGlobalDispatcher, type Dispatcher, getGlobalDispatcher } from 'undici';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { USER_AGENT } from '../../src/lib/constants.js';
import { CheckError } from '../../src/lib/errors.js';
import { getJson, httpHop } from '../../src/lib/http-client.js';

let agent: MockAgent;
let original: Dispatcher;

beforeEach(() => {
  original = getGlobalDispatcher();
  agent = new MockAgent();
  // Anything not explicitly intercepted must fail loudly rather than reach the
  // network. The default suite makes no real requests.
  agent.disableNetConnect();
  setGlobalDispatcher(agent);
});

afterEach(async () => {
  setGlobalDispatcher(original);
  await agent.close();
});

describe('httpHop', () => {
  it('returns the status without following the redirect', async () => {
    agent
      .get('http://example.test')
      .intercept({ path: '/', method: 'GET' })
      .reply(301, '', { headers: { location: 'https://example.test/' } });

    const result = await httpHop('http://example.test/', 1000);

    expect(result.status).toBe(301);
    expect(result.location).toBe('https://example.test/');
    expect(result.url).toBe('http://example.test/');
    expect(result.elapsedMs).toBeGreaterThanOrEqual(0);
  });

  it('identifies itself with a contact URL', async () => {
    agent
      .get('https://example.test')
      .intercept({ path: '/', method: 'GET', headers: { 'user-agent': USER_AGENT } })
      .reply(200, 'ok');

    await expect(httpHop('https://example.test/', 1000)).resolves.toMatchObject({ status: 200 });
  });

  it('reports a location of null when the response is not a redirect', async () => {
    agent.get('https://example.test').intercept({ path: '/', method: 'GET' }).reply(200, 'ok');
    await expect(httpHop('https://example.test/', 1000)).resolves.toMatchObject({ location: null });
  });

  it('turns an unreachable host into a network error, not a thrown TypeError', async () => {
    agent
      .get('https://example.test')
      .intercept({ path: '/', method: 'GET' })
      .replyWithError(new Error('getaddrinfo ENOTFOUND example.test'));

    const error = await httpHop('https://example.test/', 1000).catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(CheckError);
    expect((error as CheckError).code).toBe('network');
    expect((error as CheckError).message).toContain('example.test');
  });
});

describe('getJson', () => {
  it('decodes a JSON body', async () => {
    agent
      .get('https://example.test')
      .intercept({ path: '/data', method: 'GET' })
      .reply(200, { hello: 'world' });

    await expect(getJson('https://example.test/data', 1000)).resolves.toMatchObject({
      status: 200,
      body: { hello: 'world' },
    });
  });

  it('sends the Accept header it was given', async () => {
    // Cloudflare's DNS-over-HTTPS endpoint answers 400 without this.
    agent
      .get('https://example.test')
      .intercept({ path: '/dns', method: 'GET', headers: { accept: 'application/dns-json' } })
      .reply(200, { Status: 0 });

    await expect(
      getJson('https://example.test/dns', 1000, 'application/dns-json'),
    ).resolves.toMatchObject({ status: 200 });
  });

  it('returns a null body rather than throwing when the response is not JSON', async () => {
    // Several registries answer a 404 with HTML or with nothing at all.
    agent
      .get('https://example.test')
      .intercept({ path: '/missing', method: 'GET' })
      .reply(404, '<html>Not found</html>');

    await expect(getJson('https://example.test/missing', 1000)).resolves.toMatchObject({
      status: 404,
      body: null,
    });
  });

  it('returns a null body for an empty response', async () => {
    agent.get('https://example.test').intercept({ path: '/empty', method: 'GET' }).reply(200, '');
    await expect(getJson('https://example.test/empty', 1000)).resolves.toMatchObject({
      body: null,
    });
  });
});
