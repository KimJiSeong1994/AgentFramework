import { expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import ts from "typescript"

const rolePath = fileURLToPath(new URL("../src/hosts/types.ts", import.meta.url))
const configPath = fileURLToPath(new URL("../tsconfig.json", import.meta.url))

function diagnostics(source: string): readonly ts.Diagnostic[] {
  const config = ts.readConfigFile(configPath, ts.sys.readFile)
  if (config.error) throw new Error(ts.flattenDiagnosticMessageText(config.error.messageText, "\n"))
  const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, dirname(configPath))
  if (parsed.errors.length) throw new Error(parsed.errors.map(item => ts.flattenDiagnosticMessageText(item.messageText, "\n")).join("\n"))
  const host = ts.createCompilerHost(parsed.options)
  const original = host.getSourceFile.bind(host)
  host.getSourceFile = (path, languageVersion, onError, shouldCreateNewSourceFile) =>
    resolve(path) === rolePath ? ts.createSourceFile(path, source, languageVersion, true) :
      original(path, languageVersion, onError, shouldCreateNewSourceFile)
  return ts.getPreEmitDiagnostics(ts.createProgram({ rootNames: [rolePath], options: parsed.options, host }))
}

test("an added runtime role cannot compile without an explicit CLI capability entry", () => {
  const source = readFileSync(rolePath, "utf8")
  const baseline = diagnostics(source)
  expect(baseline.map(item => ts.flattenDiagnosticMessageText(item.messageText, "\n"))).toEqual([])
  const syntax = ts.createSourceFile(rolePath, source, ts.ScriptTarget.Latest, true)
  const declaration = syntax.statements.filter(ts.isVariableStatement)
    .flatMap(statement => [...statement.declarationList.declarations])
    .find(item => ts.isIdentifier(item.name) && item.name.text === "WORKFLOW_READ_ONLY_ROLES")
  const initializer = declaration?.initializer
  if (!initializer || !ts.isCallExpression(initializer)) throw new Error("runtime role registry is not a frozen tuple")
  const argument = initializer.arguments[0]
  if (!argument || !ts.isAsExpression(argument) || !ts.isArrayLiteralExpression(argument.expression)) {
    throw new Error("runtime role registry has no explicit tuple")
  }
  const offset = argument.expression.getEnd() - 1
  const addition = argument.expression.elements.hasTrailingComma ? ' "unhandled-test-role",' : ', "unhandled-test-role"'
  const changed = source.slice(0, offset) + addition + source.slice(offset)
  const failures = diagnostics(changed)
  expect(failures.some(item => item.file?.fileName === rolePath &&
    ts.flattenDiagnosticMessageText(item.messageText, "\n").includes("unhandled-test-role") &&
    ts.flattenDiagnosticMessageText(item.messageText, "\n").includes("missing"))).toBe(true)
  expect(readFileSync(rolePath, "utf8")).toBe(source)
}, 30_000)
