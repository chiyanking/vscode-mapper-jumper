export interface XmlAttribute {
  name: string;
  value: string;
  valueStart: number;
  valueEnd: number;
}

export interface XmlTag {
  name: string;
  start: number;
  end: number;
  closing: boolean;
  selfClosing: boolean;
  attributes: Map<string, XmlAttribute>;
}

export interface XmlBindingPath {
  segments: string[];
  activeIndex: number;
}

function isNameStart(ch: string): boolean {
  return /[A-Za-z_:]/.test(ch);
}

function isNameChar(ch: string): boolean {
  return /[\w:.-]/.test(ch);
}

function skipSpecialMarkup(text: string, start: number): number {
  if (text.startsWith('<!--', start)) {
    const end = text.indexOf('-->', start + 4);
    return end < 0 ? text.length : end + 3;
  }
  if (text.startsWith('<![CDATA[', start)) {
    const end = text.indexOf(']]>', start + 9);
    return end < 0 ? text.length : end + 3;
  }
  if (text.startsWith('<?', start)) {
    const end = text.indexOf('?>', start + 2);
    return end < 0 ? text.length : end + 2;
  }

  let quote: string | undefined;
  let bracketDepth = 0;
  for (let i = start + 2; i < text.length; i++) {
    const ch = text[i];
    if (quote) {
      if (ch === quote) quote = undefined;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
    } else if (ch === '[') {
      bracketDepth++;
    } else if (ch === ']') {
      bracketDepth = Math.max(0, bracketDepth - 1);
    } else if (ch === '>' && bracketDepth === 0) {
      return i + 1;
    }
  }
  return text.length;
}

function findTagEnd(text: string, start: number): number {
  let quote: string | undefined;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (quote) {
      if (ch === quote) quote = undefined;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
    } else if (ch === '>') {
      return i;
    }
  }
  return text.length - 1;
}

function parseAttributes(
  text: string,
  start: number,
  end: number
): Map<string, XmlAttribute> {
  const attributes = new Map<string, XmlAttribute>();
  let i = start;
  while (i < end) {
    while (i < end && /\s/.test(text[i])) i++;
    if (i >= end || text[i] === '/') break;
    if (!isNameStart(text[i])) {
      i++;
      continue;
    }

    const nameStart = i++;
    while (i < end && isNameChar(text[i])) i++;
    const name = text.slice(nameStart, i);
    while (i < end && /\s/.test(text[i])) i++;
    if (text[i] !== '=') continue;
    i++;
    while (i < end && /\s/.test(text[i])) i++;
    const quote = text[i];
    if (quote !== '"' && quote !== "'") continue;

    const valueStart = ++i;
    while (i < end && text[i] !== quote) i++;
    const valueEnd = i;
    attributes.set(name, {
      name,
      value: text.slice(valueStart, valueEnd),
      valueStart,
      valueEnd,
    });
    if (i < end) i++;
  }
  return attributes;
}

export function scanXmlTags(text: string): XmlTag[] {
  const tags: XmlTag[] = [];
  let i = 0;
  while (i < text.length) {
    const start = text.indexOf('<', i);
    if (start < 0) break;
    if (
      text.startsWith('<!--', start) ||
      text.startsWith('<![CDATA[', start) ||
      text.startsWith('<?', start) ||
      text.startsWith('<!', start)
    ) {
      i = skipSpecialMarkup(text, start);
      continue;
    }

    let cursor = start + 1;
    const closing = text[cursor] === '/';
    if (closing) cursor++;
    while (cursor < text.length && /\s/.test(text[cursor])) cursor++;
    if (!isNameStart(text[cursor] || '')) {
      i = start + 1;
      continue;
    }

    const nameStart = cursor++;
    while (cursor < text.length && isNameChar(text[cursor])) cursor++;
    const name = text.slice(nameStart, cursor);
    const end = findTagEnd(text, cursor);
    let tail = end - 1;
    while (tail > cursor && /\s/.test(text[tail])) tail--;
    const selfClosing = !closing && text[tail] === '/';
    tags.push({
      name,
      start,
      end,
      closing,
      selfClosing,
      attributes: closing
        ? new Map<string, XmlAttribute>()
        : parseAttributes(text, cursor, end),
    });
    i = Math.max(start + 1, end + 1);
  }
  return tags;
}

export function findOpenTagAtOffset(
  tags: XmlTag[],
  offset: number
): XmlTag | undefined {
  return tags.find(
    (tag) => !tag.closing && tag.start <= offset && offset <= tag.end
  );
}

export function getOpenTagStack(tags: XmlTag[], offset: number): XmlTag[] {
  const stack: XmlTag[] = [];
  for (const tag of tags) {
    if (tag.start > offset) break;
    if (tag.closing) {
      for (let i = stack.length - 1; i >= 0; i--) {
        if (stack[i].name === tag.name) {
          stack.splice(i);
          break;
        }
      }
      continue;
    }

    if (tag.start <= offset && offset <= tag.end) {
      stack.push(tag);
      break;
    }
    if (!tag.selfClosing && tag.end < offset) stack.push(tag);
  }
  return stack;
}

export function findTagById(
  tags: XmlTag[],
  names: ReadonlySet<string>,
  id: string
): XmlTag | undefined {
  return tags.find(
    (tag) =>
      !tag.closing &&
      names.has(tag.name) &&
      tag.attributes.get('id')?.value === id
  );
}

export function findDottedPathAtOffset(
  text: string,
  offset: number,
  start = 0,
  end = text.length
): XmlBindingPath | undefined {
  const boundedStart = Math.max(0, start);
  const boundedEnd = Math.min(text.length, end);
  const source = text.slice(boundedStart, boundedEnd);
  const pathRe = /[A-Za-z_$][\w$]*(?:\s*\.\s*[A-Za-z_$][\w$]*)*/g;
  let pathMatch: RegExpExecArray | null;
  while ((pathMatch = pathRe.exec(source)) !== null) {
    const pathStart = boundedStart + pathMatch.index;
    const identifiers = [...pathMatch[0].matchAll(/[A-Za-z_$][\w$]*/g)];
    const activeIndex = identifiers.findIndex((identifier) => {
      const identifierStart = pathStart + (identifier.index || 0);
      return (
        identifierStart <= offset &&
        offset <= identifierStart + identifier[0].length
      );
    });
    if (activeIndex >= 0) {
      return {
        segments: identifiers.map((identifier) => identifier[0]),
        activeIndex,
      };
    }
  }
  return undefined;
}

export function findPlaceholderPathAtOffset(
  text: string,
  offset: number
): XmlBindingPath | undefined {
  const placeholderRe = /#\{([\s\S]*?)\}/g;
  let match: RegExpExecArray | null;
  while ((match = placeholderRe.exec(text)) !== null) {
    const contentStart = match.index + 2;
    const contentEnd = contentStart + match[1].length;
    if (offset < contentStart || offset > contentEnd) continue;
    const optionOffset = match[1].indexOf(',');
    const pathEnd = optionOffset < 0 ? contentEnd : contentStart + optionOffset;
    return findDottedPathAtOffset(text, offset, contentStart, pathEnd);
  }
  return undefined;
}
