# Mapper Jumper

A VS Code extension for bidirectional navigation between MyBatis Mapper Java interfaces and XML mapping files. Associations are resolved through `<mapper namespace>` values, without relying on class-name suffixes such as `Mapper` or `Dao`. The extension does not register custom keyboard shortcuts.

## Navigation

| Current symbol | Target | Action |
|---|---|---|
| Java Mapper class or interface name | XML `<mapper namespace>` | `-> XML` CodeLens / `Cmd/Ctrl+F12` |
| Java Mapper class or interface name | XML `<mapper namespace>` reference | `Shift+F12` |
| Java Mapper method | XML CRUD statement `id` | `-> XML` CodeLens / `Cmd/Ctrl+F12` |
| Java Mapper method | XML CRUD statement `id` reference | `Shift+F12` |
| XML `<mapper namespace>` | Java Mapper class or interface | `-> JAVA` CodeLens / `Ctrl/Cmd+Click` / `F12` |
| XML CRUD statement `id` | Java Mapper method | `-> JAVA` CodeLens / `Ctrl/Cmd+Click` / `F12` |
| XML `<sql id="x">` | All `<include>` usages | `-> Include` CodeLens / `Shift+F12` / `Ctrl/Cmd+Click` |
| XML `<include refid="x">` | `<sql id="x">` | `Ctrl/Cmd+Click` / `F12` |

CodeLens requires the VS Code `editor.codeLens` setting, which is enabled by default.

## XML Navigation

| XML attribute or expression | Target |
|---|---|
| `<mapper namespace>` | Java class or interface declaration |
| `<select/insert/update/delete id>` | Mapper method declaration |
| `<sql id>` | `<include refid>` usages |
| `refid` | `<sql id>` definition; supports `namespace.id` |
| `resultMap` | `<resultMap id>` definition; supports cross-namespace references |
| `select` | Matching `<select id>` definition |
| `resultType`, `parameterType`, `type`, `javaType`, `ofType` | Fully qualified Java type declaration |
| `property` | Field on the Java type associated with the current `resultMap`, `association`, or `collection` |
| Variables in `test` expressions | Java parameter or parameter-object field of the corresponding Mapper method |
| Variables in `#{...}` | Java parameter or parameter-object field of the corresponding Mapper method |

The XML scanner supports single and double quotes, whitespace around equals signs, arbitrary attribute order, and `>` characters inside attribute values. Pseudo-tags inside comments, CDATA sections, processing instructions, and DOCTYPE declarations are ignored.

## Association and Indexing

- On activation, the extension scans workspace XML files, builds an in-memory `namespace -> XML[]` index, and maintains it incrementally with a file watcher.
- When multiple XML files use the same namespace, candidates are ranked by module, workspace folder, and longest common path prefix with the current file.
- XML-to-Java navigation first maps `src/main/resources` to `src/main/java` in the same module, then searches the workspace.
- Java-to-XML navigation uses the namespace index, so annotation-only Mappers do not display CodeLens entries.
- Scans exclude `.git`, `.gradle`, `target`, `build`, `out`, `dist`, and `node_modules`.

Source-root detection supports the standard Maven `src/main/java` layout and the legacy `src/` layout.

## Limitations

- Annotation-based SQL such as `@Select` and `@Insert` is not supported.
- Java type navigation requires fully qualified class names in XML. Aliases such as `map`, `string`, and custom type aliases are not resolved.
- `test` and `#{...}` bindings support Java parameter names, `@Param` aliases, and dot-separated object field paths.
- Java method and type lookup uses DocumentSymbol results from the Java language service when available, with a built-in fallback scanner otherwise.
- Cross-file `<include>` navigation only matches namespace-qualified references such as `refid="namespace.id"`. Short references such as `refid="id"` are only matched within the current XML file.

## Development

```bash
npm install
npm run compile
npm test
```

Use `npm run watch` for continuous compilation, or press `F5` in VS Code to launch an Extension Development Host.

Package a VSIX file with:

```bash
npx @vscode/vsce package
```
