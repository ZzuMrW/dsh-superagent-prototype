/** Verifies that every TypeScript class declaration in src has a preceding JSDoc block. */
import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, it } from 'vitest'
import ts from 'typescript'

const SRC = join(dirname(fileURLToPath(import.meta.url)), '..', 'src')
/** Parse TypeScript instead of mistaking Python helper text or examples for declarations. */
function undocumentedClasses(text: string, path: string): string[] {
  const source = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true,
    path.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS)
  const missing: string[] = []
  const visit = (node: ts.Node): void => {
    if (ts.isClassDeclaration(node)) {
      const before = text.slice(0, node.getStart(source)).trimEnd(), start = before.lastIndexOf('/**')
      if (!(start >= 0 && before.indexOf('*/', start) === before.length - 2)) missing.push(node.name?.text ?? '(anonymous)')
    }
    ts.forEachChild(node, visit)
  }
  visit(source)
  return missing
}
it('gives every class declaration in src a JSDoc block right before it', () => {
  const undocumented = readdirSync(SRC, { recursive: true, encoding: 'utf8' }).filter(path => /\.tsx?$/.test(path)).flatMap(path =>
    undocumentedClasses(readFileSync(join(SRC, path), 'utf8'), path).map(name => `src/${path}: ${name}`))
  expect(undocumented).toEqual([])
})
it('still detects missing declaration docs while ignoring embedded guest code and string examples', () => {
  const fixture = 'const helper = `\nclass Failure(Exception):\n pass\n`;\nclass Missing {}\n/** Documented. */\nexport class Good {}\n/* Not JSDoc. */\nclass Other {}'
  expect(undocumentedClasses(fixture, 'fixture.ts')).toEqual(['Missing', 'Other'])
})
