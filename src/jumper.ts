import * as path from 'path';
import * as vscode from 'vscode';

// ============================================================
// 工具函数
// ============================================================

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function fqnToPath(fqn: string): string {
  return fqn.replace(/\./g, '/');
}

function normalize(p: string): string {
  return p.replace(/\\/g, '/');
}

// ============================================================
// 源码根 / 资源根定位(模块就近)
// ============================================================

function findJavaRoot(filePath: string): string | undefined {
  const norm = normalize(filePath);
  const maven = norm.lastIndexOf('/src/main/java');
  if (maven >= 0) return norm.slice(0, maven + '/src/main/java'.length);
  const src = norm.lastIndexOf('/src/');
  if (src >= 0) return norm.slice(0, src + '/src'.length);
  return undefined;
}

function xmlPathToJavaRoot(filePath: string): string | undefined {
  const norm = normalize(filePath);
  const idx = norm.lastIndexOf('/src/main/resources');
  if (idx >= 0) return norm.slice(0, idx) + '/src/main/java';
  return undefined;
}

// ============================================================
// 文件读取
// ============================================================

async function fileExists(uri: vscode.Uri): Promise<boolean> {
  try {
    await vscode.workspace.fs.stat(uri);
    return true;
  } catch {
    return false;
  }
}

async function readText(uri: vscode.Uri): Promise<string> {
  const buf = await vscode.workspace.fs.readFile(uri);
  return Buffer.from(buf).toString('utf8');
}

// ============================================================
// 目标位置定位
// ============================================================

function findJavaMethodRange(
  doc: vscode.TextDocument,
  methodName: string
): vscode.Range | undefined {
  const re = new RegExp('\\b' + escapeRegExp(methodName) + '\\s*\\(');
  for (let i = 0; i < doc.lineCount; i++) {
    const text = doc.lineAt(i).text;
    const m = re.exec(text);
    if (m) {
      return new vscode.Range(i, m.index, i, m.index + methodName.length);
    }
  }
  return undefined;
}

function findXmlIdRange(
  doc: vscode.TextDocument,
  id: string
): vscode.Range | undefined {
  const re = new RegExp(
    '<(?:select|insert|update|delete)\\b[^>]*?\\bid="' + escapeRegExp(id) + '"',
    'g'
  );
  const text = doc.getText();
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const idIdx = text.indexOf('id="' + id + '"', m.index);
    if (idIdx >= 0) {
      const valueStart = idIdx + 'id="'.length;
      const start = doc.positionAt(valueStart);
      const end = doc.positionAt(valueStart + id.length);
      return new vscode.Range(start, end);
    }
  }
  return undefined;
}

// ============================================================
// namespace 索引(方案 A 核心: namespace(FQN) -> xmlUri)
// ============================================================

const nsIndex = new Map<string, vscode.Uri>(); // namespace -> xmlUri
const uriToNs = new Map<string, string>(); // xmlUri.toString() -> namespace(删除时反查)
let indexPromise: Promise<void> | undefined;

function isExcluded(uri: vscode.Uri): boolean {
  return /[\\/](target|node_modules|\.git|build)[\\/]/.test(uri.fsPath);
}

async function readNamespace(uri: vscode.Uri): Promise<string | undefined> {
  try {
    const m = (await readText(uri)).match(/<mapper\s+namespace="([^"]+)"/);
    return m ? m[1] : undefined;
  } catch {
    return undefined;
  }
}

async function buildNamespaceIndex(): Promise<void> {
  const uris = await vscode.workspace.findFiles(
    '**/*.xml',
    '**/{target,node_modules,.git,build}/**'
  );
  for (const uri of uris) {
    if (isExcluded(uri)) continue;
    const ns = await readNamespace(uri);
    if (ns) {
      nsIndex.set(ns, uri);
      uriToNs.set(uri.toString(), ns);
    }
  }
}

/** 后台构建索引(首次调用触发, 之后复用 promise) */
export function ensureIndex(): Promise<void> {
  if (!indexPromise) indexPromise = buildNamespaceIndex();
  return indexPromise;
}

/** 单个 XML 新增/修改时增量更新 */
export async function refreshXmlFile(uri: vscode.Uri): Promise<void> {
  if (isExcluded(uri)) return;
  const oldNs = uriToNs.get(uri.toString());
  if (oldNs) nsIndex.delete(oldNs);
  const ns = await readNamespace(uri);
  if (ns) {
    nsIndex.set(ns, uri);
    uriToNs.set(uri.toString(), ns);
  } else {
    uriToNs.delete(uri.toString());
  }
}

/** 单个 XML 删除时清理 */
export function removeXmlFile(uri: vscode.Uri): void {
  const oldNs = uriToNs.get(uri.toString());
  if (oldNs) nsIndex.delete(oldNs);
  uriToNs.delete(uri.toString());
}

async function findXmlByNamespace(
  namespace: string
): Promise<vscode.Uri | undefined> {
  await ensureIndex();
  return nsIndex.get(namespace);
}

// ============================================================
// Java 全限定名 / 就近定位
// ============================================================

function parseJavaFqn(
  doc: vscode.TextDocument
): { fqn: string; className: string } | undefined {
  const pkgM = doc.getText().match(/^package\s+([\w.]+);/m);
  const pkg = pkgM ? pkgM[1] : '';
  const className = path.basename(doc.fileName).replace(/\.java$/, '');
  const fqn = pkg ? pkg + '.' + className : className;
  return { fqn, className };
}

async function locateJava(
  currentPath: string,
  targetFqn: string
): Promise<vscode.Uri | undefined> {
  const javaRoot = findJavaRoot(currentPath);
  if (javaRoot) {
    const candidate = vscode.Uri.file(
      javaRoot + '/' + fqnToPath(targetFqn) + '.java'
    );
    if (await fileExists(candidate)) return candidate;
  }
  const found = await vscode.workspace.findFiles(
    '**/' + fqnToPath(targetFqn) + '.java',
    '**/{target,node_modules,build}/**',
    1
  );
  return found.length > 0 ? found[0] : undefined;
}

// ============================================================
// 当前符号解析(基于光标位置)
// ============================================================

const CONTROL_RE =
  /^\s*(if|for|while|switch|catch|synchronized|return|new|super|this|throw|else|do)\b/;

async function getJavaMethodName(
  doc: vscode.TextDocument,
  pos: vscode.Position
): Promise<string | undefined> {
  try {
    const symbols = (await vscode.commands.executeCommand(
      'vscode.executeDocumentSymbolProvider',
      doc.uri
    )) as vscode.DocumentSymbol[] | undefined;
    const name = findMethodSymbol(symbols, pos);
    if (name) return name;
  } catch {
    // 走正则
  }
  return getJavaMethodNameByRegex(doc, pos);
}

function findMethodSymbol(
  symbols: vscode.DocumentSymbol[] | undefined,
  pos: vscode.Position
): string | undefined {
  if (!symbols) return undefined;
  for (const s of symbols) {
    if (s.range.contains(pos)) {
      if (s.kind === vscode.SymbolKind.Method) return s.name;
      const child = findMethodSymbol(s.children, pos);
      if (child) return child;
    }
  }
  return undefined;
}

function getJavaMethodNameByRegex(
  doc: vscode.TextDocument,
  pos: vscode.Position
): string | undefined {
  for (let line = pos.line; line >= 0; line--) {
    const text = doc.lineAt(line).text;
    const trimmed = text.trim();
    if (
      !trimmed ||
      trimmed.startsWith('@') ||
      trimmed.startsWith('//') ||
      trimmed.startsWith('/*') ||
      trimmed.startsWith('*')
    ) {
      continue;
    }
    if (CONTROL_RE.test(text)) continue;
    const m = text.match(/([A-Za-z_$][\w$]*)\s*\(/);
    if (m) return m[1];
  }
  return undefined;
}

/** 定位光标所在的 XML 标签名 + 属性名 + 属性值(光标须落在某属性值范围内) */
function getXmlAttributeAtCursor(
  doc: vscode.TextDocument,
  pos: vscode.Position
): { tag: string; attr: string; value: string } | undefined {
  const text = doc.getText();
  const cursor = doc.offsetAt(pos);
  const tagStartRe = /<([a-zA-Z][\w-]*)\b/g;
  let lastStart = -1;
  let lastTag = '';
  let m: RegExpExecArray | null;
  while ((m = tagStartRe.exec(text)) !== null) {
    if (m.index > cursor) break;
    lastStart = m.index;
    lastTag = m[1];
  }
  if (lastStart < 0) return undefined;
  const closeIdx = text.indexOf('>', lastStart);
  if (closeIdx < 0) return undefined;
  if (cursor < lastStart || cursor > closeIdx) return undefined;
  const tagText = text.slice(lastStart, closeIdx + 1);
  const attrRe = /\b([a-zA-Z][\w-]*)\s*=\s*"([^"]*)"/g;
  let am: RegExpExecArray | null;
  while ((am = attrRe.exec(tagText)) !== null) {
    const valueStart = lastStart + am.index + am[0].indexOf(am[2]);
    const valueEnd = valueStart + am[2].length;
    if (cursor >= valueStart && cursor <= valueEnd) {
      return { tag: lastTag, attr: am[1], value: am[2] };
    }
  }
  return undefined;
}

/** 在 XML 文档中定位 <resultMap id="id"> 的 id 值 range */
function findResultMapIdRange(
  doc: vscode.TextDocument,
  id: string
): vscode.Range | undefined {
  const re = new RegExp('<resultMap\\b[^>]*?\\bid="' + escapeRegExp(id) + '"', 'g');
  const text = doc.getText();
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const idIdx = text.indexOf('id="' + id + '"', m.index);
    if (idIdx >= 0) {
      const valueStart = idIdx + 'id="'.length;
      return new vscode.Range(
        doc.positionAt(valueStart),
        doc.positionAt(valueStart + id.length)
      );
    }
  }
  return undefined;
}

/** 在 Java 文档中定位 class|interface|enum 类名声明 range */
function findJavaTypeRange(
  doc: vscode.TextDocument,
  className: string
): vscode.Range | undefined {
  const re = new RegExp(
    '\\b(class|interface|enum)\\s+' + escapeRegExp(className) + '\\b'
  );
  for (let i = 0; i < doc.lineCount; i++) {
    const m = re.exec(doc.lineAt(i).text);
    if (m) {
      return new vscode.Range(i, m.index, i, m.index + m[0].length);
    }
  }
  return undefined;
}

// ============================================================
// 主入口(Go to Implementation / Declaration / Definition)
// ============================================================

export async function resolveTargets(
  document: vscode.TextDocument,
  position: vscode.Position
): Promise<vscode.Location[]> {
  if (document.languageId === 'xml') {
    return resolveFromXml(document, position);
  }
  if (document.languageId === 'java') {
    return resolveFromJava(document, position);
  }
  return [];
}

/** Go to References: <sql id="x"> -> 所有 <include refid="x"> 用法 */
export async function resolveReferences(
  document: vscode.TextDocument,
  position: vscode.Position
): Promise<vscode.Location[]> {
  if (document.languageId !== 'xml') return [];
  const at = getXmlAttributeAtCursor(document, position);
  if (!at) return [];
  if (at.tag === 'sql' && at.attr === 'id') {
    const nsM = document.getText().match(/<mapper\s+namespace="([^"]+)"/);
    const ns = nsM ? nsM[1] : '';
    return findIncludeUsages(document, ns, at.value);
  }
  return [];
}

async function resolveFromXml(
  doc: vscode.TextDocument,
  pos: vscode.Position
): Promise<vscode.Location[]> {
  const at = getXmlAttributeAtCursor(doc, pos);
  if (!at) return [];
  const { tag, attr, value } = at;

  // select|insert|update|delete 的 id -> mapper 方法
  if (attr === 'id' && /^(select|insert|update|delete)$/.test(tag)) {
    return resolveXmlIdToJava(doc, value);
  }
  // <sql id="x"> 的 id -> <include refid="x"> 用法(含跨文件 namespace.id)
  if (attr === 'id' && tag === 'sql') {
    return resolveSqlIdToIncludes(doc, value);
  }
  // resultMap 引用 -> <resultMap id="...">
  if (attr === 'resultMap') {
    return resolveResultMapRef(doc, value);
  }
  // Java 类型属性 -> Java 类
  if (
    attr === 'resultType' ||
    attr === 'parameterType' ||
    attr === 'type' ||
    attr === 'ofType'
  ) {
    return resolveJavaType(doc.uri.fsPath, value);
  }
  // select 引用 -> <select id="...">
  if (attr === 'select') {
    return resolveSelectRef(doc, value);
  }
  // include refid -> <sql id="...">
  if (attr === 'refid') {
    return resolveSqlRef(doc, value);
  }
  // property -> resultMap/association/collection 的 type 类字段
  if (attr === 'property') {
    return resolvePropertyRef(doc, pos, value);
  }
  // test -> mapper 方法参数(光标处标识符)
  if (attr === 'test') {
    return resolveTestRef(doc, pos);
  }
  return [];
}

async function resolveXmlIdToJava(
  doc: vscode.TextDocument,
  id: string
): Promise<vscode.Location[]> {
  const nsM = doc.getText().match(/<mapper\s+namespace="([^"]+)"/);
  if (!nsM) return [];
  const javaUri = await locateJavaByXml(doc.uri.fsPath, nsM[1]);
  if (!javaUri) return [];
  const javaDoc = await vscode.workspace.openTextDocument(javaUri);
  const range = findJavaMethodRange(javaDoc, id);
  if (!range) return [];
  return [new vscode.Location(javaUri, range)];
}

async function locateJavaByXml(
  xmlPath: string,
  fqn: string
): Promise<vscode.Uri | undefined> {
  const javaRoot = xmlPathToJavaRoot(xmlPath);
  if (javaRoot) {
    const candidate = vscode.Uri.file(javaRoot + '/' + fqnToPath(fqn) + '.java');
    if (await fileExists(candidate)) return candidate;
  }
  return locateJava(xmlPath, fqn);
}

async function resolveResultMapRef(
  doc: vscode.TextDocument,
  value: string
): Promise<vscode.Location[]> {
  const same = findResultMapIdRange(doc, value);
  if (same) return [new vscode.Location(doc.uri, same)];
  if (value.includes('.')) {
    const lastDot = value.lastIndexOf('.');
    const ns = value.slice(0, lastDot);
    const rid = value.slice(lastDot + 1);
    const xmlUri = await findXmlByNamespace(ns);
    if (xmlUri) {
      const xmlDoc = await vscode.workspace.openTextDocument(xmlUri);
      const r = findResultMapIdRange(xmlDoc, rid);
      if (r) return [new vscode.Location(xmlUri, r)];
    }
  }
  return [];
}

async function resolveJavaType(
  currentPath: string,
  value: string
): Promise<vscode.Location[]> {
  // 无包名的别名(map/int 等)不跳
  if (!value.includes('.')) return [];
  const javaUri = await locateJava(currentPath, value);
  if (!javaUri) return [];
  const javaDoc = await vscode.workspace.openTextDocument(javaUri);
  const className = value.slice(value.lastIndexOf('.') + 1);
  const range =
    findJavaTypeRange(javaDoc, className) || new vscode.Range(0, 0, 0, 0);
  return [new vscode.Location(javaUri, range)];
}

async function resolveSelectRef(
  doc: vscode.TextDocument,
  value: string
): Promise<vscode.Location[]> {
  const same = findXmlIdRange(doc, value);
  if (same) return [new vscode.Location(doc.uri, same)];
  if (value.includes('.')) {
    const lastDot = value.lastIndexOf('.');
    const ns = value.slice(0, lastDot);
    const sid = value.slice(lastDot + 1);
    const xmlUri = await findXmlByNamespace(ns);
    if (xmlUri) {
      const xmlDoc = await vscode.workspace.openTextDocument(xmlUri);
      const r = findXmlIdRange(xmlDoc, sid);
      if (r) return [new vscode.Location(xmlUri, r)];
    }
  }
  return [];
}

async function resolveSqlRef(
  doc: vscode.TextDocument,
  value: string
): Promise<vscode.Location[]> {
  const same = findSqlIdRange(doc, value);
  if (same) return [new vscode.Location(doc.uri, same)];
  if (value.includes('.')) {
    const lastDot = value.lastIndexOf('.');
    const ns = value.slice(0, lastDot);
    const sid = value.slice(lastDot + 1);
    const xmlUri = await findXmlByNamespace(ns);
    if (xmlUri) {
      const xmlDoc = await vscode.workspace.openTextDocument(xmlUri);
      const r = findSqlIdRange(xmlDoc, sid);
      if (r) return [new vscode.Location(xmlUri, r)];
    }
  }
  return [];
}

/** 在 XML 文档中定位 <sql id="id"> 的 id 值 range */
function findSqlIdRange(
  doc: vscode.TextDocument,
  id: string
): vscode.Range | undefined {
  const re = new RegExp('<sql\\b[^>]*?\\bid="' + escapeRegExp(id) + '"', 'g');
  const text = doc.getText();
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const idIdx = text.indexOf('id="' + id + '"', m.index);
    if (idIdx >= 0) {
      const valueStart = idIdx + 'id="'.length;
      return new vscode.Range(
        doc.positionAt(valueStart),
        doc.positionAt(valueStart + id.length)
      );
    }
  }
  return undefined;
}

/** <include refid="id"> 的 refid 值 range 列表(同文件, 基于 doc.positionAt) */
function findIncludeRefRanges(
  doc: vscode.TextDocument,
  id: string
): vscode.Range[] {
  const text = doc.getText();
  const ranges: vscode.Range[] = [];
  const re = new RegExp(
    '<include\\b[^>]*?\\brefid="' + escapeRegExp(id) + '"',
    'g'
  );
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const idIdx = text.indexOf('refid="' + id + '"', m.index);
    if (idIdx >= 0) {
      const valueStart = idIdx + 'refid="'.length;
      ranges.push(
        new vscode.Range(
          doc.positionAt(valueStart),
          doc.positionAt(valueStart + id.length)
        )
      );
    }
  }
  return ranges;
}

/** 原始文本 offset -> Position(兼容 \r\n / \r / \n 行结束符) */
function offsetToPosition(text: string, offset: number): vscode.Position {
  let line = 0;
  let lineStart = 0;
  for (let i = 0; i < offset; i++) {
    const ch = text[i];
    if (ch === '\n') {
      line++;
      lineStart = i + 1;
    } else if (ch === '\r') {
      line++;
      if (text[i + 1] === '\n') i++; // 跳过 \r\n 的 \n
      lineStart = i + 1;
    }
  }
  return new vscode.Position(line, offset - lineStart);
}

/** <include refid="id"> 的 refid 值 range 列表(跨文件, 基于原始文本) */
function findIncludeRefRangesInText(
  text: string,
  id: string
): vscode.Range[] {
  const ranges: vscode.Range[] = [];
  const re = new RegExp(
    '<include\\b[^>]*?\\brefid="' + escapeRegExp(id) + '"',
    'g'
  );
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const idIdx = text.indexOf('refid="' + id + '"', m.index);
    if (idIdx >= 0) {
      const valueStart = idIdx + 'refid="'.length;
      ranges.push(
        new vscode.Range(
          offsetToPosition(text, valueStart),
          offsetToPosition(text, valueStart + id.length)
        )
      );
    }
  }
  return ranges;
}

async function readTextSafe(uri: vscode.Uri): Promise<string | undefined> {
  try {
    return await readText(uri);
  } catch {
    return undefined;
  }
}

/**
 * 查找 <sql id="id">(所属 namespace 下) 的所有 <include> 用法:
 * - 同文件短形式 refid="id"
 * - 跨文件前缀形式 refid="namespace.id"
 */
async function findIncludeUsages(
  xmlDoc: vscode.TextDocument,
  namespace: string,
  id: string
): Promise<vscode.Location[]> {
  const locs: vscode.Location[] = [];
  // 同文件: 短形式 refid="id"
  for (const r of findIncludeRefRanges(xmlDoc, id)) {
    locs.push(new vscode.Location(xmlDoc.uri, r));
  }
  const prefixed = namespace ? namespace + '.' + id : '';
  if (!prefixed) return locs;
  // 同文件: 前缀形式 refid="namespace.id"(罕见)
  for (const r of findIncludeRefRanges(xmlDoc, prefixed)) {
    locs.push(new vscode.Location(xmlDoc.uri, r));
  }
  // 跨文件: 仅前缀形式 refid="namespace.id"
  await ensureIndex();
  const others: vscode.Uri[] = [];
  for (const u of nsIndex.values()) {
    if (u.toString() !== xmlDoc.uri.toString()) others.push(u);
  }
  const texts = await Promise.all(
    others.map(async (u) => ({ uri: u, text: await readTextSafe(u) }))
  );
  for (const { uri, text } of texts) {
    if (!text) continue;
    for (const r of findIncludeRefRangesInText(text, prefixed)) {
      locs.push(new vscode.Location(uri, r));
    }
  }
  return locs;
}

async function resolveSqlIdToIncludes(
  doc: vscode.TextDocument,
  id: string
): Promise<vscode.Location[]> {
  const nsM = doc.getText().match(/<mapper\s+namespace="([^"]+)"/);
  const ns = nsM ? nsM[1] : '';
  return findIncludeUsages(doc, ns, id);
}

/** 向上找光标所在的最近 <select|insert|update|delete id="x"> 的 id */
function findEnclosingStatementId(
  doc: vscode.TextDocument,
  pos: vscode.Position
): string | undefined {
  const text = doc.getText();
  const cursor = doc.offsetAt(pos);
  const re = /<(select|insert|update|delete)\b[^>]*?\bid="([^"]+)"/g;
  let last: string | undefined;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    if (m.index > cursor) break;
    last = m[2];
  }
  return last;
}

/** 在 Java 文档中定位字段声明 range(匹配 fieldName; 或 fieldName =) */
function findJavaFieldRange(
  doc: vscode.TextDocument,
  fieldName: string
): vscode.Range | undefined {
  const re = new RegExp('\\b' + escapeRegExp(fieldName) + '\\b\\s*[=;]');
  for (let i = 0; i < doc.lineCount; i++) {
    const text = doc.lineAt(i).text;
    const m = re.exec(text);
    if (m) {
      return new vscode.Range(i, m.index, i, m.index + fieldName.length);
    }
  }
  return undefined;
}

/** 在 Java 文档中定位方法 methodName 的参数 paramName 声明 range(排除 @Param("...") 里的同名值) */
function findJavaMethodParamRange(
  doc: vscode.TextDocument,
  methodName: string,
  paramName: string
): vscode.Range | undefined {
  const text = doc.getText();
  const methodRe = new RegExp('\\b' + escapeRegExp(methodName) + '\\s*\\(');
  const mm = methodRe.exec(text);
  if (!mm) return undefined;
  const start = mm.index;
  const end = text.indexOf(';', start);
  if (end < 0) return undefined;
  const sig = text.slice(start, end);
  const paramRe = new RegExp('[\\s,]' + escapeRegExp(paramName) + '\\s*[,)]');
  const pm = paramRe.exec(sig);
  if (!pm) return undefined;
  const absIdx = start + pm.index + 1;
  const startPos = doc.positionAt(absIdx);
  return new vscode.Range(
    startPos,
    new vscode.Position(startPos.line, startPos.character + paramName.length)
  );
}

async function resolvePropertyRef(
  doc: vscode.TextDocument,
  pos: vscode.Position,
  value: string
): Promise<vscode.Location[]> {
  // 向前找最近的 <resultMap|association|collection ... type/javaType/ofType="FQN">
  const text = doc.getText();
  const cursor = doc.offsetAt(pos);
  const containerRe = /<(resultMap|association|collection)\b[^>]*?(?:type|javaType|ofType)="([^"]+)"/g;
  let lastType: string | undefined;
  let m: RegExpExecArray | null;
  while ((m = containerRe.exec(text)) !== null) {
    if (m.index > cursor) break;
    lastType = m[2];
  }
  if (!lastType || !lastType.includes('.')) return [];
  const javaUri = await locateJava(doc.uri.fsPath, lastType);
  if (!javaUri) return [];
  const javaDoc = await vscode.workspace.openTextDocument(javaUri);
  const range = findJavaFieldRange(javaDoc, value);
  if (!range) return [];
  return [new vscode.Location(javaUri, range)];
}

async function resolveTestRef(
  doc: vscode.TextDocument,
  pos: vscode.Position
): Promise<vscode.Location[]> {
  // 光标处标识符(参数名)
  const wordRange = doc.getWordRangeAtPosition(pos, /[A-Za-z_$][\w$]*/);
  if (!wordRange) return [];
  const word = doc.getText(wordRange);
  // 向上找所在语句的 id(mapper 方法名)
  const methodId = findEnclosingStatementId(doc, pos);
  if (!methodId) return [];
  const nsM = doc.getText().match(/<mapper\s+namespace="([^"]+)"/);
  if (!nsM) return [];
  const javaUri = await locateJavaByXml(doc.uri.fsPath, nsM[1]);
  if (!javaUri) return [];
  const javaDoc = await vscode.workspace.openTextDocument(javaUri);
  const range = findJavaMethodParamRange(javaDoc, methodId, word);
  if (!range) return [];
  return [new vscode.Location(javaUri, range)];
}

async function resolveFromJava(
  doc: vscode.TextDocument,
  pos: vscode.Position
): Promise<vscode.Location[]> {
  const info = parseJavaFqn(doc);
  if (!info) return [];
  // 不再依赖类名后缀: 有对应 namespace 的 XML 才支持跳转(覆盖 Mapper/Dao/任意命名; 纯注解 Mapper 自动排除)
  const xmlUri = await findXmlByNamespace(info.fqn);
  if (!xmlUri) return [];

  const method = await getJavaMethodName(doc, pos);
  if (!method) return [];
  const cleanName = method.split('(')[0].trim();

  const xmlDoc = await vscode.workspace.openTextDocument(xmlUri);
  const range = findXmlIdRange(xmlDoc, cleanName);
  if (!range) return [];
  return [new vscode.Location(xmlUri, range)];
}

// ============================================================
// CodeLens(方法/语句上方的可点击标识)
// ============================================================

async function collectJavaMethods(
  doc: vscode.TextDocument
): Promise<{ name: string; range: vscode.Range }[]> {
  try {
    const symbols = (await vscode.commands.executeCommand(
      'vscode.executeDocumentSymbolProvider',
      doc.uri
    )) as vscode.DocumentSymbol[] | undefined;
    const out: vscode.DocumentSymbol[] = [];
    collectMethodSymbols(symbols, out);
    if (out.length) {
      return out.map((s) => ({ name: s.name, range: s.range }));
    }
  } catch {
    // 走正则
  }
  const out: { name: string; range: vscode.Range }[] = [];
  for (let i = 0; i < doc.lineCount; i++) {
    const text = doc.lineAt(i).text;
    const trimmed = text.trim();
    if (
      !trimmed ||
      trimmed.startsWith('@') ||
      trimmed.startsWith('//') ||
      trimmed.startsWith('/*') ||
      trimmed.startsWith('*')
    ) {
      continue;
    }
    if (CONTROL_RE.test(text)) continue;
    const m = text.match(/([A-Za-z_$][\w$]*)\s*\(/);
    if (m) {
      const idx = text.indexOf(m[1]);
      out.push({ name: m[1], range: new vscode.Range(i, idx, i, idx + m[1].length) });
    }
  }
  return out;
}

function collectMethodSymbols(
  symbols: vscode.DocumentSymbol[] | undefined,
  out: vscode.DocumentSymbol[]
): void {
  if (!symbols) return;
  for (const s of symbols) {
    if (s.kind === vscode.SymbolKind.Method) out.push(s);
    collectMethodSymbols(s.children, out);
  }
}

export async function provideCodeLenses(
  doc: vscode.TextDocument
): Promise<vscode.CodeLens[]> {
  if (doc.languageId === 'java') return javaLenses(doc);
  if (doc.languageId === 'xml') return xmlLenses(doc);
  return [];
}

async function javaLenses(doc: vscode.TextDocument): Promise<vscode.CodeLens[]> {
  const info = parseJavaFqn(doc);
  if (!info) return [];
  // 有对应 XML 才显示标识(纯注解 Mapper 不显示)
  const xmlUri = await findXmlByNamespace(info.fqn);
  if (!xmlUri) return [];
  const methods = await collectJavaMethods(doc);
  return methods.map(
    (m) =>
      new vscode.CodeLens(m.range, {
        title: '-> XML',
        command: 'mapperJumper.jump',
        arguments: ['java2xml', info.fqn, m.name],
      })
  );
}

function xmlLenses(doc: vscode.TextDocument): vscode.CodeLens[] {
  const nsM = doc.getText().match(/<mapper\s+namespace="([^"]+)"/);
  if (!nsM) return [];
  const ns = nsM[1];
  const lenses: vscode.CodeLens[] = [];
  const re = /<(select|insert|update|delete)\b[^>]*?\bid="([^"]+)"/g;
  const text = doc.getText();
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const line = doc.positionAt(m.index).line;
    lenses.push(
      new vscode.CodeLens(new vscode.Range(line, 0, line, 0), {
        title: '-> Mapper',
        command: 'mapperJumper.jump',
        arguments: ['xml2java', ns, m[2], doc.uri.toString()],
      })
    );
  }
  // <sql id="x"> -> <include refid="x"> 用法
  const sqlRe = /<sql\b[^>]*?\bid="([^"]+)"/g;
  let sm: RegExpExecArray | null;
  while ((sm = sqlRe.exec(text)) !== null) {
    const line = doc.positionAt(sm.index).line;
    lenses.push(
      new vscode.CodeLens(new vscode.Range(line, 0, line, 0), {
        title: '-> Include',
        command: 'mapperJumper.jump',
        arguments: ['sql2include', ns, sm[1], doc.uri.toString()],
      })
    );
  }
  return lenses;
}

// ============================================================
// CodeLens 点击执行的跳转命令
// ============================================================

export async function jump(
  direction: string,
  fqn: string,
  name: string,
  xmlUriStr?: string
): Promise<void> {
  const cleanName = name.split('(')[0].trim();

  if (direction === 'sql2include') {
    if (!xmlUriStr) return;
    const xmlUri = vscode.Uri.parse(xmlUriStr);
    const xmlDoc = await vscode.workspace.openTextDocument(xmlUri);
    const locs = await findIncludeUsages(xmlDoc, fqn, cleanName);
    if (locs.length === 0) {
      vscode.window.showWarningMessage(
        `未找到 refid="${cleanName}" 的 <include> 用法`
      );
      return;
    }
    const first = locs[0];
    const targetDoc =
      first.uri.toString() === xmlUri.toString()
        ? xmlDoc
        : await vscode.workspace.openTextDocument(first.uri);
    await revealInEditor(targetDoc, first.range);
    return;
  }

  if (direction === 'java2xml') {
    const xmlUri = await findXmlByNamespace(fqn);
    if (!xmlUri) {
      vscode.window.showWarningMessage(`未找到 namespace=${fqn} 的 XML`);
      return;
    }
    const xmlDoc = await vscode.workspace.openTextDocument(xmlUri);
    const range = findXmlIdRange(xmlDoc, cleanName);
    if (!range) {
      vscode.window.showWarningMessage(`在 XML 中未找到 id="${cleanName}"`);
      return;
    }
    await revealInEditor(xmlDoc, range);
    return;
  }

  if (!xmlUriStr) return;
  const xmlUri = vscode.Uri.parse(xmlUriStr);
  let javaUri: vscode.Uri | undefined;
  const javaRoot = xmlPathToJavaRoot(xmlUri.fsPath);
  if (javaRoot) {
    const candidate = vscode.Uri.file(javaRoot + '/' + fqnToPath(fqn) + '.java');
    if (await fileExists(candidate)) javaUri = candidate;
  }
  if (!javaUri) javaUri = await locateJava(xmlUri.fsPath, fqn);
  if (!javaUri) {
    vscode.window.showWarningMessage(`未找到 ${fqn}`);
    return;
  }
  const javaDoc = await vscode.workspace.openTextDocument(javaUri);
  const range = findJavaMethodRange(javaDoc, cleanName);
  if (!range) {
    vscode.window.showWarningMessage(`在 Mapper 中未找到方法 ${cleanName}`);
    return;
  }
  await revealInEditor(javaDoc, range);
}

async function revealInEditor(
  doc: vscode.TextDocument,
  range: vscode.Range
): Promise<void> {
  const editor = await vscode.window.showTextDocument(doc, { preview: true });
  editor.selection = new vscode.Selection(range.start, range.end);
  editor.revealRange(range, vscode.TextEditorRevealType.InCenter);
}
