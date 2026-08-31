import { describe, expect, it } from 'vitest';
import { extractPage } from '../../src/lib/html.js';

const BASE = 'https://example.com/blog/post';

describe('extractPage', () => {
  it('reads the metadata a technical check reports on', () => {
    const page = extractPage(
      `<!doctype html>
       <html lang="pt-PT">
         <head>
           <title>  A   page   title </title>
           <meta name="description" content="What the page is about.">
           <meta name="robots" content="INDEX, FOLLOW">
           <meta name="viewport" content="width=device-width">
           <link rel="canonical" href="/blog/post">
           <meta property="og:title" content="Shared title">
           <meta property="og:image" content="https://cdn.example.com/card.png">
         </head>
         <body><h1>Heading</h1></body>
       </html>`,
      BASE,
    );

    expect(page.title).toBe('A page title');
    expect(page.metaDescription).toBe('What the page is about.');
    expect(page.metaRobots).toBe('index, follow');
    expect(page.hasViewport).toBe(true);
    expect(page.lang).toBe('pt-PT');
    expect(page.canonical).toBe('https://example.com/blog/post');
    expect(page.openGraph).toEqual({
      title: 'Shared title',
      image: 'https://cdn.example.com/card.png',
    });
  });

  it('distinguishes a missing alt from a deliberately empty one', () => {
    const page = extractPage(
      `<img src="/a.png" alt="A cat">
       <img src="/b.png" alt="">
       <img src="/c.png">`,
      BASE,
    );

    expect(page.images).toEqual([
      { src: 'https://example.com/a.png', alt: 'A cat' },
      { src: 'https://example.com/b.png', alt: '' },
      { src: 'https://example.com/c.png', alt: null },
    ]);
  });

  it('keeps headings in document order with their level', () => {
    const page = extractPage(
      `<h1>One</h1><section><h3>Three</h3></section><h2>Two <em>emphasised</em></h2>`,
      BASE,
    );

    expect(page.headings).toEqual([
      { level: 1, text: 'One' },
      { level: 3, text: 'Three' },
      { level: 2, text: 'Two emphasised' },
    ]);
  });

  it('resolves links and drops the ones a checker cannot request', () => {
    const page = extractPage(
      `<a href="/about">About</a>
       <a href="../index.html">Up</a>
       <a href="https://other.example/x" rel="NOFOLLOW">Away</a>
       <a href="mailto:someone@example.com">Mail</a>
       <a href="tel:+351210000000">Call</a>
       <a href="javascript:void(0)">Script</a>
       <a>No href</a>`,
      BASE,
    );

    expect(page.links).toEqual([
      { href: 'https://example.com/about', rel: null, text: 'About' },
      { href: 'https://example.com/index.html', rel: null, text: 'Up' },
      { href: 'https://other.example/x', rel: 'nofollow', text: 'Away' },
    ]);
  });

  it('honours a base href, as a browser would', () => {
    const page = extractPage(
      `<head><base href="https://cdn.example.com/v2/"></head><body><a href="page">P</a></body>`,
      BASE,
    );

    expect(page.links[0]?.href).toBe('https://cdn.example.com/v2/page');
  });

  it('collects hreflang alternates', () => {
    const page = extractPage(
      `<link rel="alternate" hreflang="en" href="/en/post">
       <link rel="alternate" hreflang="x-default" href="/post">
       <link rel="alternate" type="application/rss+xml" href="/feed">`,
      BASE,
    );

    expect(page.alternates).toEqual([
      { hreflang: 'en', href: 'https://example.com/en/post' },
      { hreflang: 'x-default', href: 'https://example.com/post' },
    ]);
  });

  it('ignores markup inside a template, which no visitor has seen', () => {
    const page = extractPage(
      `<h1>Real</h1><template><h1>Cloned later</h1><img src="/x.png"></template>`,
      BASE,
    );

    expect(page.headings).toEqual([{ level: 1, text: 'Real' }]);
    expect(page.images).toEqual([]);
  });

  it('keeps script and style text out of the text it reports', () => {
    const page = extractPage(
      `<h1>Title<script>var x = "noise";</script><style>h1{}</style></h1>`,
      BASE,
    );

    expect(page.headings).toEqual([{ level: 1, text: 'Title' }]);
  });

  it('reads a document a browser would fix up, not one it would reject', () => {
    // Unclosed <p>, metadata after the body has started, a stray close tag:
    // exactly what a real site serves.
    const page = extractPage(`<html><body><p>text<h1>Heading</div><img src=/a.png alt=Cat>`, BASE);

    expect(page.headings).toEqual([{ level: 1, text: 'Heading' }]);
    expect(page.images).toEqual([{ src: 'https://example.com/a.png', alt: 'Cat' }]);
  });

  it('comes back empty rather than throwing on a document with nothing in it', () => {
    const page = extractPage('', BASE);

    expect(page.title).toBeNull();
    expect(page.canonical).toBeNull();
    expect(page.headings).toEqual([]);
    expect(page.openGraph).toEqual({});
  });

  it('takes the first title and canonical when a page carries two', () => {
    const page = extractPage(
      `<title>First</title><title>Second</title>
       <link rel="canonical" href="/one"><link rel="canonical" href="/two">`,
      BASE,
    );

    expect(page.title).toBe('First');
    expect(page.canonical).toBe('https://example.com/one');
  });
});
