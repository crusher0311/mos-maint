const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const ts = require("typescript");
const { spawnSync } = require("node:child_process");
const { readRouteSource } = require("../scripts/route-source.cjs");
const HTTP = new Set(["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"]);

test("auth inventory rejects unauthenticated, missing and malformed delegates", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "route-auth-"));
  const dir = path.join(root, "app/api/private");
  const script = path.resolve("scripts/check-unauthed-routes.cjs");
  fs.mkdirSync(dir, { recursive: true });
  const route = path.join(dir, "route.ts"), handler = path.join(dir, "route-handler.ts");
  const status = () => {
    const result = spawnSync(process.execPath, [script], { cwd: root, encoding: "utf8", timeout: 15000 });
    assert.equal(result.signal, null);
    return result.status;
  };
  try {
    fs.writeFileSync(route, 'export { GET } from "./route-handler";');
    assert.equal(status(), 1, "missing delegate");
    fs.writeFileSync(handler, 'import { getSession } from "@/lib/auth";\nexport function GET() { return "private"; }');
    assert.equal(status(), 1, "an import alone is not authorization");
    fs.writeFileSync(handler, 'export async function GET() { const session = await getSession(); if (!session) return new Response("Unauthorized", { status: 401 }); return session; }');
    assert.equal(status(), 0, "real handler has authorization");
    fs.writeFileSync(route, 'export { GET } from "./route-handler";\nexport function POST() { return "private"; }');
    assert.equal(status(), 1, "extra unguarded handler must not be skipped");
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("route security scanner follows real implementations, never import-only guards", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "route-entry-"));
  try {
    const route = path.join(dir, "route.ts"), handler = path.join(dir, "route-handler.ts");
    fs.writeFileSync(route, 'export { GET } from "./route-handler";\nexport const runtime = "nodejs";\n');
    fs.writeFileSync(handler, 'import { getSession } from "@/lib/auth";\nexport function GET() { return "no auth"; }\n');
    assert.equal(readRouteSource(route), fs.readFileSync(handler, "utf8"));
    fs.writeFileSync(handler, 'export async function GET() { const session = await getSession(); return session; }\n');
    assert.match(readRouteSource(route), /await getSession\(\)/);
    for (const text of [
      'export { POST as GET } from "./route-handler";',
      'export * from "./route-handler";',
      'export { GET } from "./route-handler";\nexport const __deps = {};',
      'export { GET } from "./route-handler";\nexport function POST() {}',
      'import { getSession } from "@/lib/auth";\nexport { GET } from "./route-handler";',
    ]) {
      fs.writeFileSync(route, text);
      assert.throws(() => readRouteSource(route), /Unsupported route adapter/);
    }
    fs.writeFileSync(route, 'export { GET } from "./route-handler";');
    fs.unlinkSync(handler);
    assert.throws(() => readRouteSource(route), /ENOENT/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("every thin route preserves its implementation's HTTP methods and literal configuration", () => {
  let count = 0;
  function walk(dir) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const file = path.join(dir, e.name);
      if (e.isDirectory()) walk(file);
      else if (e.name === "route.ts" && fs.readFileSync(file, "utf8").includes('from "./route-handler"')) {
        const wrapper = ts.createSourceFile(file, fs.readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true);
        const source = readRouteSource(file), implementation = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
        const delegated = wrapper.statements.filter(ts.isExportDeclaration).flatMap(s => s.exportClause.elements.map(e => e.name.text));
        const implemented = [];
        for (const s of implementation.statements) {
          if (!s.modifiers?.some(m => m.kind === ts.SyntaxKind.ExportKeyword)) continue;
          if (ts.isFunctionDeclaration(s) && HTTP.has(s.name?.text)) implemented.push(s.name.text);
          if (ts.isVariableStatement(s)) for (const d of s.declarationList.declarations) if (HTTP.has(d.name.getText(implementation))) implemented.push(d.name.getText(implementation));
        }
        assert.deepEqual(delegated.sort(), implemented.sort(), file);
        for (const s of wrapper.statements.filter(ts.isVariableStatement)) {
          const original = implementation.statements.find(o => ts.isVariableStatement(o) && o.declarationList.declarations[0].name.getText(implementation) === s.declarationList.declarations[0].name.getText(wrapper));
          assert.ok(original, file);
          assert.equal(s.declarationList.declarations[0].initializer.getText(wrapper), original.declarationList.declarations[0].initializer.getText(implementation), file);
        }
        count++;
      }
    }
  }
  walk("app/api");
  assert.ok(count >= 39);
});
