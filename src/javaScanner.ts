function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function maskCommentsAndStrings(text: string): string {
  const chars = text.split('');
  let state: 'code' | 'line' | 'block' | 'string' | 'char' = 'code';
  for (let i = 0; i < chars.length; i++) {
    const ch = chars[i];
    const next = chars[i + 1];
    if (state === 'code') {
      if (ch === '/' && next === '/') {
        chars[i] = chars[i + 1] = ' ';
        state = 'line';
        i++;
      } else if (ch === '/' && next === '*') {
        chars[i] = chars[i + 1] = ' ';
        state = 'block';
        i++;
      } else if (ch === '"') {
        chars[i] = ' ';
        state = 'string';
      } else if (ch === "'") {
        chars[i] = ' ';
        state = 'char';
      }
    } else if (state === 'line') {
      if (ch === '\n' || ch === '\r') state = 'code';
      else chars[i] = ' ';
    } else if (state === 'block') {
      if (ch === '*' && next === '/') {
        chars[i] = chars[i + 1] = ' ';
        state = 'code';
        i++;
      } else if (ch !== '\n' && ch !== '\r') {
        chars[i] = ' ';
      }
    } else {
      const quote = state === 'string' ? '"' : "'";
      if (ch === '\\') {
        chars[i] = ' ';
        if (i + 1 < chars.length) chars[++i] = ' ';
      } else if (ch === quote) {
        chars[i] = ' ';
        state = 'code';
      } else if (ch !== '\n' && ch !== '\r') {
        chars[i] = ' ';
      }
    }
  }
  return chars.join('');
}

export function findJavaMethodNameOffsets(
  source: string,
  methodName: string
): number[] {
  const text = maskCommentsAndStrings(source);
  const re = new RegExp(
    '(?:^|[;{}]|\\r?\\n)\\s*' +
      '(?!(?:return|new|throw|case|yield)\\b)' +
      '(?:(?:public|protected|private|abstract|default|static|final|synchronized|native|strictfp)\\s+)*' +
      '(?:<[^;{}()]+>\\s+)?' +
      '[A-Za-z_$][\\w$<>,.?\\[\\]\\s]*\\s+' +
      '(' + escapeRegExp(methodName) + ')\\s*\\(',
    'gm'
  );
  const offsets: number[] = [];
  let match: RegExpExecArray | null;
  while ((match = re.exec(text)) !== null) {
    offsets.push(match.index + match[0].lastIndexOf(match[1]));
  }
  return offsets;
}

export function findJavaTypeNameOffset(
  source: string,
  typeName: string
): number | undefined {
  const text = maskCommentsAndStrings(source);
  const re = new RegExp(
    '\\b(?:class|interface|enum|record)\\s+(' + escapeRegExp(typeName) + ')\\b'
  );
  const match = re.exec(text);
  return match ? match.index + match[0].lastIndexOf(match[1]) : undefined;
}
