"use strict";
const fs = require("node:fs");
const path = require("node:path");
const ts = require("typescript");
const HTTP = new Set(["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"]);
const CONFIG = new Set(["runtime", "dynamic", "revalidate", "maxDuration", "fetchCache", "dynamicParams", "preferredRegion"]);

// Inspect the actual shared IPP guards rather than allowlisting their routes.
// Only named, unaliased imports from this exact module can be expanded.
function expandIppHandlers(file, source) {
  const moduleName = "@/lib/print-queue/ipp-http";
  const allowed = new Set(["webDestinations", "webStatus", "webTest", "extensionDestinations", "extensionTest"]);
  const ast = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
  const names = [];
  for (const statement of ast.statements) {
    if (!ts.isImportDeclaration(statement) || statement.moduleSpecifier.text !== moduleName) continue;
    const bindings = statement.importClause?.namedBindings;
    if (!bindings || !ts.isNamedImports(bindings)) throw new Error("Unsupported IPP handler import");
    for (const entry of bindings.elements) {
      if (!allowed.has(entry.propertyName?.text ?? entry.name.text)) continue;
      if (entry.propertyName) throw new Error("Unsupported IPP handler binding");
      names.push(entry.name.text);
    }
  }
  if (!names.length) return source;
  const impl = fs.readFileSync(path.join(__dirname, "../lib/print-queue/ipp-http.ts"), "utf8");
  const parsed = ts.createSourceFile("ipp-http.ts", impl, ts.ScriptTarget.Latest, true);
  const replacements = [];
  for (const name of names) {
    const declaration = parsed.statements.find(s => ts.isFunctionDeclaration(s) && s.name?.text === name);
    if (!declaration?.body) throw new Error(`Missing IPP handler: ${name}`);
    const expanded = "(" + declaration.getText(parsed).replace(/^export\s+/, "") + ")";
    function visit(node) {
      if (ts.isImportDeclaration(node)) return;
      if (ts.isIdentifier(node) && node.text === name) {
        const parent = node.parent;
        // Expand only executed calls or direct exported handler bindings.
        // A bare import, comment, or unrelated reference cannot satisfy auth.
        const call = ts.isCallExpression(parent) && parent.expression === node;
        const binding = ts.isVariableDeclaration(parent) && parent.initializer === node &&
          HTTP.has(parent.name.getText(ast));
        const wrapped = ts.isCallExpression(parent) && parent.expression.getText(ast) === "withExtensionErrorMarker" &&
          parent.arguments.length === 1 && parent.arguments[0] === node;
        if (call || binding || wrapped) replacements.push({ start: node.getStart(ast), end: node.end, text: expanded });
      }
      ts.forEachChild(node, visit);
    }
    visit(ast);
  }
  for (const replacement of replacements.sort((a, b) => b.start - a.start))
    source = source.slice(0, replacement.start) + replacement.text + source.slice(replacement.end);
  return source;
}

// Follow only a complete, literal route adapter, never arbitrary imports.
// The security checks still inspect the real implementation, not its imports.
function readRouteSource(file) {
  const source = fs.readFileSync(file, "utf8");
  if (!source.includes('from "./route-handler"')) return expandIppHandlers(file, source);
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
module.exports = { readRouteSource, expandIppHandlers };
