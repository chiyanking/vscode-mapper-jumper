# Mapper Jumper

VSCode 插件:在 MyBatis Mapper 接口与 XML 之间双向跳转,精准定位到对端方法。提供三种入口,均复用同一套定位逻辑,不自定义任何快捷键。

## 三种入口

| 当前文件 | 跳转到 | 入口 |
|---|---|---|
| Java Mapper 类/接口名 | XML `<mapper namespace>` | 类名上方「-> XML」标识 / `Cmd/Ctrl+F12` |
| XML `<mapper namespace>` | Java Mapper 类/接口 | 标签上方「-> JAVA」标识 / `Ctrl/Cmd+Click` |
| `XxxMapper.java` | `XxxMapper.xml` | 方法上方「-> XML」标识(点击)/ `Cmd/Ctrl+F12`(Go to Implementation) |
| `XxxMapper.xml` | `XxxMapper.java` | 语句上方「-> JAVA」标识(点击)/ `Ctrl/Cmd+Click`(Go to Definition) |
| `<sql id="x">` | `<include refid="x">` | 片段上方「-> Include」标识(点击)/ `Shift+F12`(查找引用)/ `Ctrl/Cmd+Click`(Go to Definition) |
| `<include refid="x">` | `<sql id="x">` | `Ctrl/Cmd+Click`(Go to Definition) |

1. **CodeLens 标识**:打开 `XxxMapper.java`,每个方法和类名上方显示「-> XML」,点击跳到 XML 对应位置;打开 `XxxMapper.xml`,每条语句上方显示「-> JAVA」,点击跳回 Java 方法。
2. **Go to Implementation**:`XxxMapper.java` 方法上 `Cmd/Ctrl+F12`(或右键「转到实现」)跳 XML。
3. **Go to Definition**:`XxxMapper.xml` 语句内 `Ctrl/Cmd+Click`(或 `F12`、右键「转到定义」)跳 Java 方法。右键「转到声明」同样可用。

CodeLens 标识即 VSCode 的 CodeLens,需 `editor.codeLens` 开启(默认开)。

## 关联策略

以 MyBatis 的 `namespace`(= Java 全限定名)为关联键:

- 激活时扫描工作区所有 XML,建立 `namespace -> XML` 索引(内存 <1MB),并用文件监听器增量维护。
- Java 是否支持跳 XML = 其全限定名是否在索引中。有对应 XML 才显示标识/提供跳转(纯注解 Mapper 不显示),覆盖 `Mapper`/`Dao`/任意命名。
- XML -> Java:从 XML 路径找最近的 `src/main/resources`,替换为 `src/main/java`,拼接 `namespace` 路径(模块就近)。
- Java -> XML:直接查索引(`namespace` 全局唯一)。

源码根兼容标准 Maven(`src/main/java`)与老式结构(`src/`)。

## 开发

```bash
npm install
npm run compile      # 或 npm run watch
```

在 VSCode 中按 `F5` 启动扩展开发宿主调试。

## 说明

- 不处理 `@Select` 等注解 SQL(它们不在 XML 中)。
- 方法名解析优先调用 Java 语言服务的 DocumentSymbol(需 Red Hat Java 扩展),失败时回退到正则。
- `<sql id="x">` 片段支持双向跳转:`<include refid="x">` -> 定义,`<sql id="x">` -> 所有用法。跨文件引用以 `namespace.id` 前缀形式匹配(短形式仅同文件内生效)。
