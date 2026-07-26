# Mapper Jumper

VSCode 插件，用于在 MyBatis Mapper Java 接口与 XML 映射文件之间双向跳转。关联以 `<mapper namespace>` 为准，不依赖 `Mapper`、`Dao` 等类名后缀，也不注册自定义快捷键。

## 跳转入口

| 当前符号 | 跳转目标 | 入口 |
|---|---|---|
| Java Mapper 类/接口名 | XML `<mapper namespace>` | `-> XML` CodeLens / `Cmd/Ctrl+F12` |
| Java Mapper 类/接口名 | XML `<mapper namespace>`(作为引用) | `Shift+F12` |
| Java Mapper 方法 | XML CRUD 语句的 `id` | `-> XML` CodeLens / `Cmd/Ctrl+F12` |
| Java Mapper 方法 | XML CRUD 语句的 `id`(作为引用) | `Shift+F12` |
| XML `<mapper namespace>` | Java Mapper 类/接口 | `-> JAVA` CodeLens / `Ctrl/Cmd+Click` / `F12` |
| XML CRUD 语句的 `id` | Java Mapper 方法 | `-> JAVA` CodeLens / `Ctrl/Cmd+Click` / `F12` |
| XML `<sql id="x">` | 所有 `<include>` 用法 | `-> Include` CodeLens / `Shift+F12` / `Ctrl/Cmd+Click` |
| XML `<include refid="x">` | `<sql id="x">` | `Ctrl/Cmd+Click` / `F12` |

CodeLens 需要开启 VSCode 的 `editor.codeLens` 设置，该设置默认开启。

## XML 跳转支持

| XML 属性 | 跳转目标 |
|---|---|
| `<mapper namespace>` | Java 类或接口声明 |
| `<select/insert/update/delete id>` | Mapper 方法声明 |
| `<sql id>` | `<include refid>` 用法 |
| `refid` | `<sql id>` 定义，支持 `namespace.id` |
| `resultMap` | `<resultMap id>` 定义，支持跨 namespace |
| `select` | 对应 `<select id>` 定义 |
| `resultType`、`parameterType`、`type`、`javaType`、`ofType` | Java 全限定类型声明 |
| `property` | 当前 `resultMap`、`association` 或 `collection` 对应 Java 类型的字段 |
| `test` | 当前 CRUD 语句对应 Mapper 方法的 Java 参数 |

XML 扫描支持单双引号、等号两侧空格、任意属性顺序，以及属性值中的 `>`。注释、CDATA、处理指令和 DOCTYPE 中的伪标签不会参与跳转。

## 关联与索引

- 激活后扫描工作区 XML，建立 `namespace -> XML[]` 内存索引，并通过文件监听器增量维护。
- 同一个 namespace 存在多个 XML 时，优先选择与当前文件相同模块、相同 workspace folder、公共路径最长的候选。
- XML 到 Java 优先把同模块的 `src/main/resources` 映射为 `src/main/java`，找不到时再搜索工作区。
- Java 到 XML 通过 namespace 索引定位，因此纯注解 Mapper 不显示 CodeLens。
- 扫描会排除 `.git`、`.gradle`、`target`、`build`、`out`、`dist` 和 `node_modules`。

源码根兼容标准 Maven 结构 `src/main/java`，以及老式 `src/` 结构。

## 限制

- 不处理 `@Select`、`@Insert` 等注解 SQL。
- Java 类型跳转要求 XML 中使用全限定类名；`map`、`string`、项目自定义 typeAlias 等别名不会跳转。
- `test` 表达式按 Java 源码参数名定位，暂不解析名称不同的 `@Param` 别名。
- Java 方法和类型定位优先使用 Java 语言服务的 DocumentSymbol；语言服务不可用时使用内置降级解析。
- 跨文件 `<include>` 仅匹配带 namespace 前缀的 `refid="namespace.id"`；短 `refid="id"` 只在当前 XML 内匹配。

## 开发

```bash
npm install
npm run compile
npm test
```

使用 `npm run watch` 持续编译，或在 VSCode 中按 `F5` 启动扩展开发宿主。

打包 VSIX：

```bash
npx @vscode/vsce package
```
