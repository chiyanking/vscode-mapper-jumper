import * as path from 'path';
import * as vscode from 'vscode';
import {
  findJavaMethodNameOffsets,
  findJavaTypeNameOffset,
} from './javaScanner';
import {
  XmlAttribute,
  XmlBindingPath,
  XmlTag,
  findDottedPathAtOffset,
  findOpenTagAtOffset,
  findPlaceholderPathAtOffset,
  findTagById,
  getOpenTagStack,
  scanXmlTags,
} from './xmlScanner';

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

function findJavaMethodRangesByRegex(
  doc: vscode.TextDocument,
  methodName: string
): vscode.Range[] {
  return findJavaMethodNameOffsets(doc.getText(), methodName).map((offset) =>
    new vscode.Range(
      doc.positionAt(offset),
      doc.positionAt(offset + methodName.length)
    )
  );
}

async function findJavaMethodRanges(
  doc: vscode.TextDocument,
  methodName: string
): Promise<vscode.Range[]> {
  try {
    const symbols = (await vscode.commands.executeCommand(
      'vscode.executeDocumentSymbolProvider',
      doc.uri
    )) as vscode.DocumentSymbol[] | undefined;
    const methods: vscode.DocumentSymbol[] = [];
    collectMethodSymbols(symbols, methods);
    const matches = methods.filter(
      (symbol) => symbol.name.split('(')[0].trim() === methodName
    );
    if (matches.length > 0) return matches.map((symbol) => symbol.selectionRange);
  } catch {
    // Java 语言服务不可用时使用保守的声明正则。
  }
  return findJavaMethodRangesByRegex(doc, methodName);
}

function rangeForAttribute(
  doc: vscode.TextDocument,
  tag: XmlTag | undefined,
  name: string
): vscode.Range | undefined {
  const attr = tag?.attributes.get(name);
  if (!attr) return undefined;
  return new vscode.Range(
    doc.positionAt(attr.valueStart),
    doc.positionAt(attr.valueEnd)
  );
}

function findXmlAttributeRange(
  doc: vscode.TextDocument,
  tagNames: ReadonlySet<string>,
  attrName: string,
  value: string
): vscode.Range | undefined {
  const tag = scanXmlTags(doc.getText()).find(
    (candidate) =>
      !candidate.closing &&
      tagNames.has(candidate.name) &&
      candidate.attributes.get(attrName)?.value === value
  );
  return rangeForAttribute(doc, tag, attrName);
}

function getMapperNamespace(text: string): string | undefined {
  return scanXmlTags(text)
    .find((tag) => !tag.closing && tag.name === 'mapper')
    ?.attributes.get('namespace')?.value;
}

function findMapperNamespaceRange(
  doc: vscode.TextDocument
): vscode.Range | undefined {
  const mapper = scanXmlTags(doc.getText()).find(
    (tag) => !tag.closing && tag.name === 'mapper'
  );
  return rangeForAttribute(doc, mapper, 'namespace');
}

function findXmlIdRange(
  doc: vscode.TextDocument,
  id: string
): vscode.Range | undefined {
  return findXmlAttributeRange(
    doc,
    new Set(['select', 'insert', 'update', 'delete']),
    'id',
    id
  );
}

// ============================================================
// namespace 索引(namespace(FQN) -> 模块内所有 xmlUri)
// ============================================================

const nsIndex = new Map<string, Map<string, vscode.Uri>>();
const uriToNs = new Map<string, string>(); // xmlUri.toString() -> namespace(删除时反查)
let indexPromise: Promise<void> | undefined;

function isExcluded(uri: vscode.Uri): boolean {
  return /[\\/](target|node_modules|\.git|build|out|dist|\.gradle)[\\/]/.test(uri.fsPath);
}

async function readNamespace(uri: vscode.Uri): Promise<string | undefined> {
  try {
    return getMapperNamespace(await readText(uri));
  } catch {
    return undefined;
  }
}

function addNamespaceEntry(namespace: string, uri: vscode.Uri): void {
  let entries = nsIndex.get(namespace);
  if (!entries) {
    entries = new Map<string, vscode.Uri>();
    nsIndex.set(namespace, entries);
  }
  entries.set(uri.toString(), uri);
  uriToNs.set(uri.toString(), namespace);
}

function removeNamespaceEntry(uri: vscode.Uri): void {
  const key = uri.toString();
  const namespace = uriToNs.get(key);
  if (!namespace) return;
  const entries = nsIndex.get(namespace);
  entries?.delete(key);
  if (entries?.size === 0) nsIndex.delete(namespace);
  uriToNs.delete(key);
}

async function buildNamespaceIndex(): Promise<void> {
  const uris = await vscode.workspace.findFiles(
    '**/*.xml',
    '**/{target,node_modules,.git,build,out,dist,.gradle}/**'
  );
  for (const uri of uris) {
    if (isExcluded(uri)) continue;
    const ns = await readNamespace(uri);
    if (ns) addNamespaceEntry(ns, uri);
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
  removeNamespaceEntry(uri);
  const ns = await readNamespace(uri);
  if (ns) addNamespaceEntry(ns, uri);
}

/** 单个 XML 删除时清理 */
export function removeXmlFile(uri: vscode.Uri): void {
  removeNamespaceEntry(uri);
}

function moduleRoot(filePath: string): string | undefined {
  const norm = normalize(filePath);
  const src = norm.lastIndexOf('/src/');
  return src >= 0 ? norm.slice(0, src) : undefined;
}

function commonPrefixLength(left: string, right: string): number {
  const max = Math.min(left.length, right.length);
  let i = 0;
  while (i < max && left[i] === right[i]) i++;
  return i;
}

function rankNamespaceCandidate(uri: vscode.Uri, currentPath?: string): number {
  if (!currentPath) return 0;
  const current = normalize(currentPath);
  const candidate = normalize(uri.fsPath);
  let score = commonPrefixLength(current, candidate);
  const currentModule = moduleRoot(current);
  if (currentModule && currentModule === moduleRoot(candidate)) score += 100_000;
  const workspace = vscode.workspace.getWorkspaceFolder(vscode.Uri.file(current));
  const candidateWorkspace = vscode.workspace.getWorkspaceFolder(uri);
  if (
    workspace &&
    candidateWorkspace &&
    workspace.uri.toString() === candidateWorkspace.uri.toString()
  ) {
    score += 10_000;
  }
  return score;
}

async function findXmlByNamespace(
  namespace: string,
  currentPath?: string
): Promise<vscode.Uri | undefined> {
  await ensureIndex();
  const candidates = [...(nsIndex.get(namespace)?.values() || [])];
  candidates.sort(
    (left, right) =>
      rankNamespaceCandidate(right, currentPath) -
        rankNamespaceCandidate(left, currentPath) ||
      left.fsPath.localeCompare(right.fsPath)
  );
  return candidates[0];
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
    '**/{target,node_modules,.git,build,out,dist,.gradle}/**',
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
): {
  tag: string;
  attr: string;
  value: string;
  valueStart: number;
  valueEnd: number;
} | undefined {
  const text = doc.getText();
  const cursor = doc.offsetAt(pos);
  const tag = findOpenTagAtOffset(scanXmlTags(text), cursor);
  if (!tag) return undefined;
  for (const attr of tag.attributes.values()) {
    if (cursor >= attr.valueStart && cursor <= attr.valueEnd) {
      return {
        tag: tag.name,
        attr: attr.name,
        value: attr.value,
        valueStart: attr.valueStart,
        valueEnd: attr.valueEnd,
      };
    }
  }
  return undefined;
}

/** 在 XML 文档中定位 <resultMap id="id"> 的 id 值 range */
function findResultMapIdRange(
  doc: vscode.TextDocument,
  id: string
): vscode.Range | undefined {
  return findXmlAttributeRange(doc, new Set(['resultMap']), 'id', id);
}

/** 在 Java 文档中定位 class|interface|enum|record 类名声明 range */
function findJavaTypeRangeByRegex(
  doc: vscode.TextDocument,
  className: string
): vscode.Range | undefined {
  const offset = findJavaTypeNameOffset(doc.getText(), className);
  return offset === undefined
    ? undefined
    : new vscode.Range(
        doc.positionAt(offset),
        doc.positionAt(offset + className.length)
      );
}

async function findJavaTypeRange(
  doc: vscode.TextDocument,
  className: string
): Promise<vscode.Range | undefined> {
  try {
    const symbols = (await vscode.commands.executeCommand(
      'vscode.executeDocumentSymbolProvider',
      doc.uri
    )) as vscode.DocumentSymbol[] | undefined;
    const types: vscode.DocumentSymbol[] = [];
    collectTypeSymbols(symbols, types);
    const symbol = types.find((candidate) => candidate.name === className);
    if (symbol) return symbol.selectionRange;
  } catch {
    // Java 语言服务不可用时使用类型声明正则。
  }
  return findJavaTypeRangeByRegex(doc, className);
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

/** Go to References:
 *  - XML <sql id="x"> -> 所有 <include refid="x"> 用法
 *  - Java Mapper 类/接口名 -> 对应 <mapper namespace="...">
 *  - Java Mapper 方法名 -> 对应 XML CRUD 语句的 id
 */
export async function resolveReferences(
  document: vscode.TextDocument,
  position: vscode.Position
): Promise<vscode.Location[]> {
  if (document.languageId === 'java') {
    return resolveJavaReferences(document, position);
  }
  if (document.languageId !== 'xml') return [];
  const at = getXmlAttributeAtCursor(document, position);
  if (!at) return [];
  if (at.tag === 'sql' && at.attr === 'id') {
    const ns = getMapperNamespace(document.getText()) || '';
    return findIncludeUsages(document, ns, at.value);
  }
  return [];
}

/** Java Mapper 类型/方法声明上的 XML References */
async function resolveJavaReferences(
  doc: vscode.TextDocument,
  pos: vscode.Position
): Promise<vscode.Location[]> {
  const info = parseJavaFqn(doc);
  if (!info) return [];

  const typeRange = await findJavaTypeRange(doc, info.className);
  const exactXmlUri = await findXmlByNamespace(info.fqn, doc.uri.fsPath);
  // 精确 namespace 是识别 Mapper 类型的前提。
  if (!exactXmlUri) return [];

  const xmlDoc = await vscode.workspace.openTextDocument(exactXmlUri);
  if (typeRange?.contains(pos)) {
    const namespaceRange = findMapperNamespaceRange(xmlDoc);
    return namespaceRange
      ? [new vscode.Location(exactXmlUri, namespaceRange)]
      : [];
  }

  const method = await getJavaMethodName(doc, pos);
  if (!method) return [];
  const methodName = method.split('(')[0].trim();
  const declarationRanges = await findJavaMethodRanges(doc, methodName);
  if (!declarationRanges.some((range) => range.contains(pos))) return [];

  const idRange = findXmlIdRange(xmlDoc, methodName);
  return idRange ? [new vscode.Location(exactXmlUri, idRange)] : [];
}

async function resolveFromXml(
  doc: vscode.TextDocument,
  pos: vscode.Position
): Promise<vscode.Location[]> {
  const text = doc.getText();
  const cursor = doc.offsetAt(pos);
  const placeholderPath = findPlaceholderPathAtOffset(text, cursor);
  if (placeholderPath) {
    return resolveMapperBindingRef(doc, pos, placeholderPath);
  }

  const at = getXmlAttributeAtCursor(doc, pos);
  if (!at) return [];
  const { tag, attr, value } = at;

  // <mapper namespace="FQN"> -> Java Mapper 类/接口
  if (tag === 'mapper' && attr === 'namespace') {
    return resolveJavaType(doc.uri.fsPath, value);
  }
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
    attr === 'javaType' ||
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
  // test -> Mapper 方法参数或参数对象字段
  if (attr === 'test') {
    const path = findDottedPathAtOffset(
      text,
      cursor,
      at.valueStart,
      at.valueEnd
    );
    return path ? resolveMapperBindingRef(doc, pos, path) : [];
  }
  return [];
}

async function resolveXmlIdToJava(
  doc: vscode.TextDocument,
  id: string
): Promise<vscode.Location[]> {
  const namespace = getMapperNamespace(doc.getText());
  if (!namespace) return [];
  const javaUri = await locateJavaByXml(doc.uri.fsPath, namespace);
  if (!javaUri) return [];
  const javaDoc = await vscode.workspace.openTextDocument(javaUri);
  const ranges = await findJavaMethodRanges(javaDoc, id);
  return ranges.map((range) => new vscode.Location(javaUri, range));
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
    const xmlUri = await findXmlByNamespace(ns, doc.uri.fsPath);
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
    (await findJavaTypeRange(javaDoc, className)) ||
    new vscode.Range(0, 0, 0, 0);
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
    const xmlUri = await findXmlByNamespace(ns, doc.uri.fsPath);
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
    const xmlUri = await findXmlByNamespace(ns, doc.uri.fsPath);
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
  return findXmlAttributeRange(doc, new Set(['sql']), 'id', id);
}

/** <include refid="id"> 的 refid 值 range 列表(同文件, 基于 doc.positionAt) */
function findIncludeRefRanges(
  doc: vscode.TextDocument,
  id: string
): vscode.Range[] {
  return scanXmlTags(doc.getText())
    .filter(
      (tag) =>
        !tag.closing &&
        tag.name === 'include' &&
        tag.attributes.get('refid')?.value === id
    )
    .map((tag) => rangeForAttribute(doc, tag, 'refid'))
    .filter((range): range is vscode.Range => Boolean(range));
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
  return scanXmlTags(text)
    .filter(
      (tag) =>
        !tag.closing &&
        tag.name === 'include' &&
        tag.attributes.get('refid')?.value === id
    )
    .map((tag) => tag.attributes.get('refid'))
    .filter((attr): attr is XmlAttribute => Boolean(attr))
    .map(
      (attr) =>
        new vscode.Range(
          offsetToPosition(text, attr.valueStart),
          offsetToPosition(text, attr.valueEnd)
        )
    );
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
  for (const entries of nsIndex.values()) {
    for (const uri of entries.values()) {
      if (uri.toString() !== xmlDoc.uri.toString()) others.push(uri);
    }
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
  const ns = getMapperNamespace(doc.getText()) || '';
  return findIncludeUsages(doc, ns, id);
}

/** 向上找光标所在的最近 <select|insert|update|delete id="x"> 的 id */
function findEnclosingStatementId(
  doc: vscode.TextDocument,
  pos: vscode.Position
): string | undefined {
  const text = doc.getText();
  const cursor = doc.offsetAt(pos);
  const statementNames = new Set(['select', 'insert', 'update', 'delete']);
  return getOpenTagStack(scanXmlTags(text), cursor)
    .reverse()
    .find((tag) => statementNames.has(tag.name))
    ?.attributes.get('id')?.value;
}

interface JavaFieldInfo {
  range: vscode.Range;
  type?: string;
}

interface JavaMethodParameter {
  name: string;
  type: string;
  aliases: string[];
  range: vscode.Range;
}

/** 在 Java 文档中定位字段声明及其类型 */
function findJavaFieldInfo(
  doc: vscode.TextDocument,
  fieldName: string
): JavaFieldInfo | undefined {
  const re = new RegExp(
    '([A-Za-z_$][\\w$.]*(?:\\s*<[^;=(){}]+>)?(?:\\s*\\[\\s*\\])*)' +
      '\\s+(' +
      escapeRegExp(fieldName) +
      ')\\s*(?=[=;,)])'
  );
  for (let i = 0; i < doc.lineCount; i++) {
    const text = doc.lineAt(i).text;
    const m = re.exec(text);
    if (m) {
      const nameStart = m.index + m[0].lastIndexOf(m[2]);
      return {
        range: new vscode.Range(
          i,
          nameStart,
          i,
          nameStart + fieldName.length
        ),
        type: m[1].trim(),
      };
    }
  }
  const fallback = new RegExp(
    '\\b' + escapeRegExp(fieldName) + '\\b\\s*[=;]'
  );
  for (let i = 0; i < doc.lineCount; i++) {
    const match = fallback.exec(doc.lineAt(i).text);
    if (match) {
      return {
        range: new vscode.Range(
          i,
          match.index,
          i,
          match.index + fieldName.length
        ),
      };
    }
  }
  return undefined;
}

function findJavaFieldRange(
  doc: vscode.TextDocument,
  fieldName: string
): vscode.Range | undefined {
  return findJavaFieldInfo(doc, fieldName)?.range;
}

function findClosingParen(text: string, open: number): number {
  let depth = 0;
  let quote: string | undefined;
  for (let i = open; i < text.length; i++) {
    const ch = text[i];
    if (quote) {
      if (ch === '\\') i++;
      else if (ch === quote) quote = undefined;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
    } else if (ch === '(') {
      depth++;
    } else if (ch === ')' && --depth === 0) {
      return i;
    }
  }
  return -1;
}

function splitJavaParameterRanges(
  text: string,
  start: number,
  end: number
): { start: number; end: number }[] {
  const ranges: { start: number; end: number }[] = [];
  let segmentStart = start;
  let angleDepth = 0;
  let parenDepth = 0;
  let bracketDepth = 0;
  let quote: string | undefined;
  for (let i = start; i < end; i++) {
    const ch = text[i];
    if (quote) {
      if (ch === '\\') i++;
      else if (ch === quote) quote = undefined;
      continue;
    }
    if (ch === '"' || ch === "'") quote = ch;
    else if (ch === '<') angleDepth++;
    else if (ch === '>') angleDepth = Math.max(0, angleDepth - 1);
    else if (ch === '(') parenDepth++;
    else if (ch === ')') parenDepth = Math.max(0, parenDepth - 1);
    else if (ch === '[') bracketDepth++;
    else if (ch === ']') bracketDepth = Math.max(0, bracketDepth - 1);
    else if (
      ch === ',' &&
      angleDepth === 0 &&
      parenDepth === 0 &&
      bracketDepth === 0
    ) {
      ranges.push({ start: segmentStart, end: i });
      segmentStart = i + 1;
    }
  }
  ranges.push({ start: segmentStart, end });
  return ranges;
}

function maskJavaAnnotations(source: string): string {
  const chars = source.split('');
  for (let i = 0; i < chars.length; i++) {
    if (chars[i] !== '@') continue;
    let end = i + 1;
    while (end < chars.length && /[\w$.]/.test(chars[end])) end++;
    while (end < chars.length && /\s/.test(chars[end])) end++;
    if (chars[end] === '(') {
      let depth = 0;
      let quote: string | undefined;
      for (; end < chars.length; end++) {
        const ch = chars[end];
        if (quote) {
          if (ch === '\\') end++;
          else if (ch === quote) quote = undefined;
        } else if (ch === '"' || ch === "'") {
          quote = ch;
        } else if (ch === '(') {
          depth++;
        } else if (ch === ')' && --depth === 0) {
          end++;
          break;
        }
      }
    }
    for (let j = i; j < end; j++) {
      if (!/\s/.test(chars[j])) chars[j] = ' ';
    }
    i = end - 1;
  }
  return chars.join('');
}

async function findJavaMethodParameters(
  doc: vscode.TextDocument,
  methodName: string
): Promise<JavaMethodParameter[]> {
  const text = doc.getText();
  const methodRanges = await findJavaMethodRanges(doc, methodName);
  const parameters: JavaMethodParameter[] = [];
  for (const methodRange of methodRanges) {
    const methodEnd = doc.offsetAt(methodRange.end);
    const open = text.indexOf('(', methodEnd);
    if (open < 0) continue;
    const close = findClosingParen(text, open);
    if (close < 0) continue;
    for (const range of splitJavaParameterRanges(text, open + 1, close)) {
      const source = text.slice(range.start, range.end);
      const aliases = [...source.matchAll(
        /@(?:[\w$.]+\.)?Param\s*\(\s*(?:value\s*=\s*)?["']([^"']+)["']/g
      )].map((match) => match[1]);
      const masked = maskJavaAnnotations(source);
      const nameMatch = /([A-Za-z_$][\w$]*)\s*(?:\[\s*\])?\s*$/.exec(masked);
      if (!nameMatch) continue;
      const name = nameMatch[1];
      const nameOffset = range.start + nameMatch.index;
      const type = masked
        .slice(0, nameMatch.index)
        .replace(/\b(?:final|volatile|transient)\b/g, ' ')
        .trim();
      if (!type) continue;
      parameters.push({
        name,
        type,
        aliases,
        range: new vscode.Range(
          doc.positionAt(nameOffset),
          doc.positionAt(nameOffset + name.length)
        ),
      });
    }
  }
  return parameters;
}

async function resolvePropertyRef(
  doc: vscode.TextDocument,
  pos: vscode.Position,
  value: string
): Promise<vscode.Location[]> {
  const text = doc.getText();
  const cursor = doc.offsetAt(pos);
  const containers = getOpenTagStack(scanXmlTags(text), cursor).filter((tag) =>
    /^(resultMap|association|collection)$/.test(tag.name)
  );
  const current = containers[containers.length - 1];
  if (
    current &&
    current.start <= cursor &&
    cursor <= current.end &&
    /^(association|collection)$/.test(current.name)
  ) {
    containers.pop();
  }
  const owner = containers[containers.length - 1];
  if (!owner) return [];
  const ownerType = await resolveContainerType(doc, owner, new Set<string>());
  if (!ownerType || !ownerType.includes('.')) return [];
  const javaUri = await locateJava(doc.uri.fsPath, ownerType);
  if (!javaUri) return [];
  const javaDoc = await vscode.workspace.openTextDocument(javaUri);
  const range = findJavaFieldRange(javaDoc, value);
  if (!range) return [];
  return [new vscode.Location(javaUri, range)];
}

async function resolveContainerType(
  doc: vscode.TextDocument,
  container: XmlTag,
  seen: Set<string>
): Promise<string | undefined> {
  const directNames =
    container.name === 'collection'
      ? ['ofType', 'javaType', 'type']
      : container.name === 'association'
        ? ['javaType', 'type']
        : ['type'];
  for (const name of directNames) {
    const value = container.attributes.get(name)?.value;
    if (value) return value;
  }

  const reference =
    container.attributes.get('resultMap')?.value ||
    (container.name === 'resultMap'
      ? container.attributes.get('extends')?.value
      : undefined);
  if (!reference) return undefined;
  return resolveResultMapType(doc, reference, seen);
}

async function resolveResultMapType(
  sourceDoc: vscode.TextDocument,
  reference: string,
  seen: Set<string>
): Promise<string | undefined> {
  let targetDoc = sourceDoc;
  let id = reference;
  if (reference.includes('.')) {
    const lastDot = reference.lastIndexOf('.');
    const namespace = reference.slice(0, lastDot);
    id = reference.slice(lastDot + 1);
    const uri = await findXmlByNamespace(namespace, sourceDoc.uri.fsPath);
    if (!uri) return undefined;
    targetDoc = await vscode.workspace.openTextDocument(uri);
  }

  const key = targetDoc.uri.toString() + '#' + id;
  if (seen.has(key)) return undefined;
  seen.add(key);
  const tag = findTagById(
    scanXmlTags(targetDoc.getText()),
    new Set(['resultMap']),
    id
  );
  return tag ? resolveContainerType(targetDoc, tag, seen) : undefined;
}

function extractReferencedJavaType(type: string): string | undefined {
  const cleaned = type
    .replace(/\.\.\./g, '')
    .replace(/\[\s*\]/g, '')
    .replace(/\?\s*(?:extends|super)?/g, ' ')
    .trim();
  const genericStart = cleaned.indexOf('<');
  const source =
    genericStart >= 0
      ? cleaned.slice(genericStart + 1, cleaned.lastIndexOf('>'))
      : cleaned;
  const names = source.match(/[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*/g);
  return names?.[names.length - 1];
}

const NON_OBJECT_JAVA_TYPES = new Set([
  'boolean',
  'byte',
  'char',
  'double',
  'float',
  'int',
  'long',
  'short',
  'void',
]);

async function openJavaTypeDocument(
  ownerDoc: vscode.TextDocument,
  type: string
): Promise<vscode.TextDocument | undefined> {
  const typeName = extractReferencedJavaType(type);
  if (!typeName || NON_OBJECT_JAVA_TYPES.has(typeName)) return undefined;
  const simpleName = typeName.slice(typeName.lastIndexOf('.') + 1);
  if (path.basename(ownerDoc.fileName, '.java') === simpleName) return ownerDoc;

  const source = ownerDoc.getText();
  const candidates: string[] = [];
  if (typeName.includes('.')) candidates.push(typeName);
  const importMatch = source.match(
    new RegExp(
      '^import\\s+(?:static\\s+)?([\\w.]+\\.' +
        escapeRegExp(simpleName) +
        ')\\s*;',
      'm'
    )
  );
  if (importMatch) candidates.push(importMatch[1]);
  const packageMatch = source.match(/^package\s+([\w.]+)\s*;/m);
  if (packageMatch) candidates.push(packageMatch[1] + '.' + simpleName);
  candidates.push(simpleName);

  for (const candidate of [...new Set(candidates)]) {
    const uri = await locateJava(ownerDoc.uri.fsPath, candidate);
    if (uri) return vscode.workspace.openTextDocument(uri);
  }
  return undefined;
}

async function resolveJavaFieldPath(
  mapperDoc: vscode.TextDocument,
  parameter: JavaMethodParameter,
  binding: XmlBindingPath,
  firstFieldIndex: number
): Promise<vscode.Location | undefined> {
  let ownerDoc = await openJavaTypeDocument(mapperDoc, parameter.type);
  if (!ownerDoc) return undefined;
  for (let i = firstFieldIndex; i <= binding.activeIndex; i++) {
    const field = findJavaFieldInfo(ownerDoc, binding.segments[i]);
    if (!field) return undefined;
    if (i === binding.activeIndex) {
      return new vscode.Location(ownerDoc.uri, field.range);
    }
    if (!field.type) return undefined;
    const nextOwner = await openJavaTypeDocument(ownerDoc, field.type);
    if (!nextOwner) return undefined;
    ownerDoc = nextOwner;
  }
  return undefined;
}

function uniqueLocations(locations: vscode.Location[]): vscode.Location[] {
  const seen = new Set<string>();
  return locations.filter((location) => {
    const key =
      location.uri.toString() +
      ':' +
      location.range.start.line +
      ':' +
      location.range.start.character;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

async function resolveMapperBindingRef(
  doc: vscode.TextDocument,
  pos: vscode.Position,
  binding: XmlBindingPath
): Promise<vscode.Location[]> {
  const methodId = findEnclosingStatementId(doc, pos);
  if (!methodId) return [];
  const namespace = getMapperNamespace(doc.getText());
  if (!namespace) return [];
  const javaUri = await locateJavaByXml(doc.uri.fsPath, namespace);
  if (!javaUri) return [];
  const javaDoc = await vscode.workspace.openTextDocument(javaUri);
  const parameters = await findJavaMethodParameters(javaDoc, methodId);
  const rootName = binding.segments[0];
  const explicitParameters = parameters.filter(
    (parameter) =>
      parameter.name === rootName || parameter.aliases.includes(rootName)
  );

  if (explicitParameters.length > 0) {
    if (binding.activeIndex === 0) {
      return uniqueLocations(
        explicitParameters.map(
          (parameter) => new vscode.Location(javaUri, parameter.range)
        )
      );
    }
    const fields = await Promise.all(
      explicitParameters.map((parameter) =>
        resolveJavaFieldPath(javaDoc, parameter, binding, 1)
      )
    );
    return uniqueLocations(
      fields.filter(
        (location): location is vscode.Location => Boolean(location)
      )
    );
  }

  // MyBatis 单对象参数可直接使用 #{field} / test="field != null";
  // 多个对象都命中时返回全部候选，交给 VSCode 选择。
  const fields = await Promise.all(
    parameters.map((parameter) =>
      resolveJavaFieldPath(javaDoc, parameter, binding, 0)
    )
  );
  return uniqueLocations(
    fields.filter((location): location is vscode.Location => Boolean(location))
  );
}

async function resolveFromJava(
  doc: vscode.TextDocument,
  pos: vscode.Position
): Promise<vscode.Location[]> {
  const info = parseJavaFqn(doc);
  if (!info) return [];
  // 不再依赖类名后缀: 有对应 namespace 的 XML 才支持跳转(覆盖 Mapper/Dao/任意命名; 纯注解 Mapper 自动排除)
  const xmlUri = await findXmlByNamespace(info.fqn, doc.uri.fsPath);
  if (!xmlUri) return [];

  const typeRange = await findJavaTypeRange(doc, info.className);
  if (typeRange?.contains(pos)) {
    const xmlDoc = await vscode.workspace.openTextDocument(xmlUri);
    const namespaceRange = findMapperNamespaceRange(xmlDoc);
    return namespaceRange
      ? [new vscode.Location(xmlUri, namespaceRange)]
      : [];
  }

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

function collectTypeSymbols(
  symbols: vscode.DocumentSymbol[] | undefined,
  out: vscode.DocumentSymbol[]
): void {
  if (!symbols) return;
  for (const symbol of symbols) {
    if (
      symbol.kind === vscode.SymbolKind.Class ||
      symbol.kind === vscode.SymbolKind.Interface ||
      symbol.kind === vscode.SymbolKind.Enum ||
      symbol.kind === vscode.SymbolKind.Struct
    ) {
      out.push(symbol);
    }
    collectTypeSymbols(symbol.children, out);
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
  const xmlUri = await findXmlByNamespace(info.fqn, doc.uri.fsPath);
  if (!xmlUri) return [];
  const methods = await collectJavaMethods(doc);
  const lenses = methods.map(
    (m) =>
      new vscode.CodeLens(m.range, {
        title: '-> XML',
        command: 'mapperJumper.jump',
        arguments: ['java2xml', info.fqn, m.name, doc.uri.toString()],
      })
  );
  const typeRange = await findJavaTypeRange(doc, info.className);
  if (typeRange) {
    lenses.unshift(
      new vscode.CodeLens(typeRange, {
        title: '-> XML',
        command: 'mapperJumper.jump',
        arguments: ['java2namespace', info.fqn, '', doc.uri.toString()],
      })
    );
  }
  return lenses;
}

function xmlLenses(doc: vscode.TextDocument): vscode.CodeLens[] {
  const text = doc.getText();
  const ns = getMapperNamespace(text);
  if (!ns) return [];
  const lenses: vscode.CodeLens[] = [];
  const tags = scanXmlTags(text);
  const mapper = tags.find((tag) => !tag.closing && tag.name === 'mapper');
  if (mapper) {
    const line = doc.positionAt(mapper.start).line;
    lenses.push(
      new vscode.CodeLens(new vscode.Range(line, 0, line, 0), {
        title: '-> JAVA',
        command: 'mapperJumper.jump',
        arguments: ['namespace2java', ns, '', doc.uri.toString()],
      })
    );
  }
  for (const tag of tags) {
    const id = tag.attributes.get('id')?.value;
    if (tag.closing || !id || !/^(select|insert|update|delete)$/.test(tag.name)) {
      continue;
    }
    const line = doc.positionAt(tag.start).line;
    lenses.push(
      new vscode.CodeLens(new vscode.Range(line, 0, line, 0), {
        title: '-> JAVA',
        command: 'mapperJumper.jump',
        arguments: ['xml2java', ns, id, doc.uri.toString()],
      })
    );
  }
  // <sql id="x"> -> <include refid="x"> 用法
  for (const tag of tags) {
    const id = tag.attributes.get('id')?.value;
    if (tag.closing || tag.name !== 'sql' || !id) continue;
    const line = doc.positionAt(tag.start).line;
    lenses.push(
      new vscode.CodeLens(new vscode.Range(line, 0, line, 0), {
        title: '-> Include',
        command: 'mapperJumper.jump',
        arguments: ['sql2include', ns, id, doc.uri.toString()],
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

  if (direction === 'namespace2java') {
    if (!xmlUriStr) return;
    const xmlUri = vscode.Uri.parse(xmlUriStr);
    const javaUri = await locateJavaByXml(xmlUri.fsPath, fqn);
    if (!javaUri) {
      vscode.window.showWarningMessage(`未找到 ${fqn}`);
      return;
    }
    const javaDoc = await vscode.workspace.openTextDocument(javaUri);
    const className = fqn.slice(fqn.lastIndexOf('.') + 1);
    const range = await findJavaTypeRange(javaDoc, className);
    if (!range) {
      vscode.window.showWarningMessage(`在 Java 文件中未找到类型 ${className}`);
      return;
    }
    await revealInEditor(javaDoc, range);
    return;
  }

  if (direction === 'java2namespace') {
    const currentPath = xmlUriStr ? vscode.Uri.parse(xmlUriStr).fsPath : undefined;
    const xmlUri = await findXmlByNamespace(fqn, currentPath);
    if (!xmlUri) {
      vscode.window.showWarningMessage(`未找到 namespace=${fqn} 的 XML`);
      return;
    }
    const xmlDoc = await vscode.workspace.openTextDocument(xmlUri);
    const range = findMapperNamespaceRange(xmlDoc);
    if (!range) {
      vscode.window.showWarningMessage(`XML 中未找到 namespace=${fqn}`);
      return;
    }
    await revealInEditor(xmlDoc, range);
    return;
  }

  if (direction === 'java2xml') {
    const currentPath = xmlUriStr ? vscode.Uri.parse(xmlUriStr).fsPath : undefined;
    const xmlUri = await findXmlByNamespace(fqn, currentPath);
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
  const ranges = await findJavaMethodRanges(javaDoc, cleanName);
  if (ranges.length === 0) {
    vscode.window.showWarningMessage(`在 Mapper 中未找到方法 ${cleanName}`);
    return;
  }
  await revealInEditor(javaDoc, ranges[0]);
}

async function revealInEditor(
  doc: vscode.TextDocument,
  range: vscode.Range
): Promise<void> {
  const editor = await vscode.window.showTextDocument(doc, { preview: true });
  editor.selection = new vscode.Selection(range.start, range.end);
  editor.revealRange(range, vscode.TextEditorRevealType.InCenter);
}
