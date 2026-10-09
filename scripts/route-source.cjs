"use strict";
const fs = require("node:fs");
const path = require("node:path");
const ts = require("typescript");
const HTTP = new Set(["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"]);
const CONFIG = new Set(["runtime", "dynamic", "revalidate", "maxDuration", "fetchCache", "dynamicParams", "preferredRegion"]);

// Follow only a complete, literal route adapter, never arbitrary imports.
// The security checks still inspect the real implementation, not its imports.
function readRouteSource(file) {
  const source = fs.readFileSync(file, "utf8");
  if (!source.includes('from "./route-handler"')) return source;
  const ast = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
  let delegate = false;
  for (const statement of ast.statements) {
    if (ts.isExportDeclaration(statement)
      && statement.moduleSpecifier?.text === "./route-handler"
      && statement.exportClause && ts.isNamedExports(statement.exportClause)
      && statement.exportClause.elements.length
      && statement.exportClause.elements.every(e => HTTP.has(e.name.text) && !e.propertyName)) {
      delegate = true;
      continue;
    }
    if (ts.isVariableStatement(statement)
      && statement.modifiers?.some(m => m.kind === ts.SyntaxKind.ExportKeyword)
      && statement.declarationList.declarations.every(d =>
        CONFIG.has(d.name.getText(ast)) && d.initializer &&
        /^(?:["'].*["']|-?\d+|true|false)$/.test(d.initializer.getText(ast)))) continue;
    throw new Error(`Unsupported route adapter: ${file}`);
  }
  if (!delegate) throw new Error(`Missing route handlers: ${file}`);
  return fs.readFileSync(path.join(path.dirname(file), "route-handler.ts"), "utf8");
}
module.exports = { readRouteSource };
