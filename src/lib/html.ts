import { type DefaultTreeAdapterTypes, parse } from 'parse5';

/**
 * HTML parsing, reduced to the handful of facts a technical SEO check needs.
 *
 * `parse5` implements the HTML5 tree construction algorithm, which matters more
 * here than it might sound: real client sites serve unclosed tags, stray
 * `</div>`s and metadata after `<body>` has already started, and a tolerant
 * parser that guesses differently from a browser would report problems the
 * visitor never has. Everything below reads the tree a browser would build.
 *
 * The result is plain data, never a node tree: tools consume this module's
 * output and never traverse the DOM themselves.
 */

type Element = DefaultTreeAdapterTypes.Element;
type Node = DefaultTreeAdapterTypes.Node;

/** One heading, in document order. */
export interface Heading {
  /** 1 for `<h1>` through 6 for `<h6>`. */
  level: number;
  /** The heading's visible text, with whitespace collapsed. */
  text: string;
}

/** One `<img>`. */
export interface PageImage {
  /** Resolved absolute URL, or `null` when the element has no usable `src`. */
  src: string | null;
  /**
   * The `alt` attribute.
   *
   * `null` means the attribute is absent, which is an accessibility problem.
   * An empty string means it was written as `alt=""`, which is the correct way
   * to mark an image as decorative and is **not** a problem. Collapsing the two
   * into one "missing alt" count is the most common way this check is got wrong.
   */
  alt: string | null;
}

/** One `<a href>` pointing somewhere over HTTP. */
export interface PageLink {
  /** Resolved absolute URL. */
  href: string;
  /** The `rel` attribute, lowercased, or `null`. */
  rel: string | null;
  /** The link's visible text, with whitespace collapsed. */
  text: string;
}

/** One `<link rel="alternate" hreflang>` declaration. */
export interface AlternateLink {
  /** The language tag as written, e.g. `pt-PT` or `x-default`. */
  hreflang: string;
  /** Resolved absolute URL. */
  href: string;
}

/** Everything extracted from one page. */
export interface PageContent {
  /** The `<title>`, with whitespace collapsed, or `null` when absent or empty. */
  title: string | null;
  /** The `<meta name="description">` content. */
  metaDescription: string | null;
  /** The `<meta name="robots">` content, lowercased. */
  metaRobots: string | null;
  /** The `<link rel="canonical">` target, resolved. */
  canonical: string | null;
  /** The `lang` attribute of `<html>`. */
  lang: string | null;
  /** Whether a `<meta name="viewport">` is present. */
  hasViewport: boolean;
  /** Open Graph properties, keyed without the `og:` prefix, e.g. `title`. */
  openGraph: Record<string, string>;
  /** Every heading, in document order. */
  headings: Heading[];
  /** Every `<img>`, in document order. */
  images: PageImage[];
  /** Every `<a>` resolving to an `http:` or `https:` URL, in document order. */
  links: PageLink[];
  /** Every `<link rel="alternate" hreflang>`. */
  alternates: AlternateLink[];
}

/** Elements whose text is never shown to a reader. */
const NON_RENDERED = new Set(['script', 'style', 'template', 'noscript']);

/**
 * Nesting levels beyond which a document is refused rather than parsed.
 *
 * HTML5 tree construction costs roughly the square of the nesting depth:
 * measured here, 2,500 levels parse in 32ms, 5,000 in 104ms, 10,000 in 396ms
 * and 20,000 in 1.5s. A page is read up to two mebibytes, and two mebibytes of
 * `<div>` is four hundred thousand levels — which extrapolates to several
 * minutes of blocked event loop from a single hostile response. There is no way
 * to interrupt a synchronous parse, so the document is measured first and
 * refused if it is absurd.
 *
 * Two thousand is far past any real page: a deeply nested layout reaches a few
 * dozen, and the worst hand-written table markup a hundred or so.
 */
const MAX_NESTING_DEPTH = 2000;

/**
 * Whether a document is nested too deeply to be worth parsing.
 *
 * A single linear scan of the tag openers and closers, which is cheap enough to
 * run on every document and does not need a parser to answer.
 *
 * @param html The document as served.
 * @param limit Levels to allow. Defaults to {@link MAX_NESTING_DEPTH}.
 * @returns `true` when the document nests deeper than the limit.
 * @throws Never.
 */
export function nestsTooDeeply(html: string, limit: number = MAX_NESTING_DEPTH): boolean {
  let depth = 0;

  for (let index = 0; index < html.length; index += 1) {
    if (html[index] !== '<') continue;
    const next = html[index + 1];
    if (next === '/') {
      depth -= 1;
      continue;
    }
    // Comments, doctypes and processing instructions open nothing.
    if (next === '!' || next === '?') continue;
    if (next === undefined || !/[a-zA-Z]/.test(next)) continue;

    depth += 1;
    if (depth > limit) return true;
  }

  return false;
}

/**
 * Extracts everything a technical SEO check reads from one page.
 *
 * @param html The document as served.
 * @param baseUrl The URL it was fetched from, used to resolve relative links.
 *   A `<base href>` in the document overrides it, exactly as it would in a
 *   browser.
 * @returns The extracted facts. Absent things are `null` or empty, never
 *   guessed.
 * @throws Never — a document too broken to yield anything comes back empty.
 */
export function extractPage(html: string, baseUrl: string): PageContent {
  const document = parse(html);
  const elements = collectElements(document);

  const base = resolveBase(elements, baseUrl);
  const htmlElement = elements.find((element) => element.tagName === 'html');
  const openGraph: Record<string, string> = {};
  const headings: Heading[] = [];
  const images: PageImage[] = [];
  const links: PageLink[] = [];
  const alternates: AlternateLink[] = [];

  let title: string | null = null;
  let metaDescription: string | null = null;
  let metaRobots: string | null = null;
  let canonical: string | null = null;
  let hasViewport = false;

  for (const element of elements) {
    switch (element.tagName) {
      case 'title': {
        title ??= textOf(element) || null;
        break;
      }
      case 'meta': {
        const name = attribute(element, 'name')?.toLowerCase();
        const property = attribute(element, 'property')?.toLowerCase();
        const content = attribute(element, 'content');
        if (content === null) break;
        if (name === 'description') metaDescription ??= collapse(content) || null;
        if (name === 'robots') metaRobots ??= collapse(content).toLowerCase() || null;
        if (name === 'viewport') hasViewport = true;
        if (property?.startsWith('og:') === true) {
          openGraph[property.slice(3)] ??= collapse(content);
        }
        break;
      }
      case 'link': {
        const rel = attribute(element, 'rel')?.toLowerCase() ?? '';
        const href = resolve(attribute(element, 'href'), base);
        if (href === null) break;
        if (rel.split(/\s+/).includes('canonical')) canonical ??= href;
        if (rel.split(/\s+/).includes('alternate')) {
          const hreflang = attribute(element, 'hreflang');
          if (hreflang !== null) alternates.push({ hreflang, href });
        }
        break;
      }
      case 'h1':
      case 'h2':
      case 'h3':
      case 'h4':
      case 'h5':
      case 'h6': {
        headings.push({ level: Number(element.tagName.slice(1)), text: textOf(element) });
        break;
      }
      case 'img': {
        images.push({
          src: resolve(attribute(element, 'src'), base),
          alt: attribute(element, 'alt'),
        });
        break;
      }
      case 'a': {
        const href = resolve(attribute(element, 'href'), base);
        // Only what can be requested. `mailto:`, `tel:` and `javascript:` are
        // links a reader can follow and a link checker cannot.
        if (href === null || !href.startsWith('http')) break;
        links.push({
          href,
          rel: attribute(element, 'rel')?.toLowerCase() ?? null,
          text: textOf(element),
        });
        break;
      }
      default:
        break;
    }
  }

  return {
    title,
    metaDescription,
    metaRobots,
    canonical,
    lang: htmlElement === undefined ? null : (attribute(htmlElement, 'lang') ?? null),
    hasViewport,
    openGraph,
    headings,
    images,
    links,
    alternates,
  };
}

/**
 * Flattens the tree into every element, in document order.
 *
 * `<template>` contents are skipped: they are inert until a script clones them,
 * so counting a heading or an image inside one would report markup no visitor
 * has ever seen.
 *
 * @param root The parsed document.
 * @returns Every element, outermost first.
 * @throws Never.
 */
function collectElements(root: Node): Element[] {
  const found: Element[] = [];
  const stack: Node[] = [root];

  while (stack.length > 0) {
    const node = stack.pop();
    if (node === undefined) continue;
    if (isElement(node)) {
      found.push(node);
      if (node.tagName === 'template') continue;
    }
    const children = 'childNodes' in node ? node.childNodes : [];
    // Pushed in reverse so that popping walks the children left to right, which
    // is what makes "document order" true of the result.
    for (let index = children.length - 1; index >= 0; index -= 1) {
      const child = children[index];
      if (child !== undefined) stack.push(child);
    }
  }

  return found;
}

/**
 * The URL relative links resolve against.
 *
 * @param elements Every element in the document.
 * @param fallback The URL the page was fetched from.
 * @returns The first usable `<base href>`, or the fallback.
 * @throws Never.
 */
function resolveBase(elements: readonly Element[], fallback: string): string {
  for (const element of elements) {
    if (element.tagName !== 'base') continue;
    const href = resolve(attribute(element, 'href'), fallback);
    if (href !== null) return href;
  }
  return fallback;
}

/**
 * @param node Any node.
 * @returns Whether it is an element, narrowing the type.
 * @throws Never.
 */
function isElement(node: Node): node is Element {
  return 'tagName' in node;
}

/**
 * @param element The element to read.
 * @param name Attribute name, lowercase.
 * @returns The attribute value, or `null` when it is not present. An attribute
 *   written without a value reads as an empty string, which is how `alt=""`
 *   stays distinguishable from a missing `alt`.
 * @throws Never.
 */
function attribute(element: Element, name: string): string | null {
  return element.attrs.find((candidate) => candidate.name === name)?.value ?? null;
}

/**
 * @param element The element whose text is wanted.
 * @returns Its descendant text with whitespace collapsed, skipping anything a
 *   reader never sees.
 * @throws Never.
 */
function textOf(element: Element): string {
  const parts: string[] = [];
  const stack: Node[] = [element];

  while (stack.length > 0) {
    const node = stack.pop();
    if (node === undefined) continue;
    if (isElement(node) && NON_RENDERED.has(node.tagName)) continue;
    if (node.nodeName === '#text' && 'value' in node) parts.push(node.value);
    const children = 'childNodes' in node ? node.childNodes : [];
    for (let index = children.length - 1; index >= 0; index -= 1) {
      const child = children[index];
      if (child !== undefined) stack.push(child);
    }
  }

  return collapse(parts.join(' '));
}

/**
 * @param value Any text from the document.
 * @returns The same text with runs of whitespace reduced to one space and the
 *   ends trimmed, so that a heading broken across three source lines compares
 *   as the one string a reader sees.
 * @throws Never.
 */
function collapse(value: string): string {
  return value.replace(/\s+/gu, ' ').trim();
}

/**
 * @param href An attribute value, possibly relative, possibly absent.
 * @param base The URL to resolve against.
 * @returns An absolute URL, or `null` when there is nothing usable to resolve.
 * @throws Never.
 */
function resolve(href: string | null, base: string): string | null {
  if (href === null || href.trim() === '') return null;
  try {
    return new URL(href, base).toString();
  } catch {
    return null;
  }
}
