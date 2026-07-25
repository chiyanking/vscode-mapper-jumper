import * as vscode from 'vscode';
import {
  resolveTargets,
  provideCodeLenses,
  jump,
  ensureIndex,
  refreshXmlFile,
  removeXmlFile,
} from './jumper';

export function activate(context: vscode.ExtensionContext) {
  // 后台构建 namespace -> XML 索引(首次跳转/CodeLens 时 await)
  ensureIndex();

  // 监听 XML 增删改, 增量维护索引
  const watcher = vscode.workspace.createFileSystemWatcher('**/*.xml');
  watcher.onDidCreate(refreshXmlFile);
  watcher.onDidChange(refreshXmlFile);
  watcher.onDidDelete(removeXmlFile);
  context.subscriptions.push(watcher);

  // Java Mapper 方法 -> XML:Go to Implementation(Cmd/Ctrl+F12)
  context.subscriptions.push(
    vscode.languages.registerImplementationProvider(
      { scheme: 'file', language: 'java' },
      {
        provideImplementation(
          document: vscode.TextDocument,
          position: vscode.Position
        ) {
          return resolveTargets(document, position);
        },
      }
    )
  );

  // XML 语句 -> Java:Go to Declaration(右键「转到声明」)
  context.subscriptions.push(
    vscode.languages.registerDeclarationProvider(
      { scheme: 'file', language: 'xml' },
      {
        provideDeclaration(
          document: vscode.TextDocument,
          position: vscode.Position
        ) {
          return resolveTargets(document, position);
        },
      }
    )
  );

  // XML 语句 -> Java:Go to Definition(Ctrl/Cmd+Click、F12)
  context.subscriptions.push(
    vscode.languages.registerDefinitionProvider(
      { scheme: 'file', language: 'xml' },
      {
        provideDefinition(
          document: vscode.TextDocument,
          position: vscode.Position
        ) {
          return resolveTargets(document, position);
        },
      }
    )
  );

  // CodeLens 标识点击跳转(命令不暴露命令面板, 仅 CodeLens 内部用)
  context.subscriptions.push(
    vscode.commands.registerCommand('mapperJumper.jump', jump)
  );
  const lensSelector: vscode.DocumentSelector = [
    { scheme: 'file', language: 'java' },
    { scheme: 'file', language: 'xml' },
  ];
  context.subscriptions.push(
    vscode.languages.registerCodeLensProvider(lensSelector, {
      provideCodeLenses(document: vscode.TextDocument) {
        return provideCodeLenses(document);
      },
    })
  );
}

export function deactivate() {}
