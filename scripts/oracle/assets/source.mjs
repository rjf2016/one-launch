import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import ts from 'typescript';
import { repoRoot } from '../lib/out.mjs';

export const SOURCE_ROOT = 'src';
export const TYPESCRIPT_VERSION = ts.version;

const rel = (file) => relative(repoRoot, file).replace(/\\/g, '/');

export function sourceFiles(dir = join(repoRoot, SOURCE_ROOT)) {
  return readdirSync(dir, { withFileTypes: true })
    .flatMap((entry) => {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) return sourceFiles(full);
      return /\.tsx?$/.test(entry.name) && !entry.name.endsWith('.d.ts') ? [full] : [];
    })
    .sort((a, b) => (rel(a) < rel(b) ? -1 : rel(a) > rel(b) ? 1 : 0));
}

// Babel's and TypeScript's rule for JSX text: lines are trimmed where they meet a line break, blank lines go, the rest join with one space.
export function jsxText(raw) {
  const lines = raw.split(/\r\n|\n|\r/);
  let last = -1;
  lines.forEach((line, i) => {
    if (/[^ \t]/.test(line)) last = i;
  });
  let out = '';
  lines.forEach((line, i) => {
    let piece = line.replace(/\t/g, ' ');
    if (i !== 0) piece = piece.replace(/^ +/, '');
    if (i !== lines.length - 1) piece = piece.replace(/ +$/, '');
    if (piece === '') return;
    out += i === last ? piece : `${piece} `;
  });
  return out;
}

const HIDDEN_ATTRIBUTES = new Set([
  'className',
  'class',
  'key',
  'id',
  'type',
  'role',
  'href',
  'src',
  'viewBox',
  'd',
  'fill',
  'stroke',
  'strokeWidth',
  'strokeLinecap',
  'strokeLinejoin',
  'htmlFor',
  'name',
  'autoComplete',
  'inputMode',
  'tabIndex',
  'rel',
  'target',
  'xmlns',
  'width',
  'height',
  'x',
  'y',
  'cx',
  'cy',
  'r',
  'rx',
  'ry',
  'points',
  'transform',
  'spellCheck',
  'accept',
  'pattern',
  'dir',
  'lang',
  'loading',
  'decoding',
  'draggable',
  'enterKeyHint',
  'autoCapitalize',
  'autoCorrect',
  'style',
  'variant',
  'size',
  'tone',
  'align',
  'side',
  'kind',
  'mode',
  'as',
  'launcher',
]);
const VISIBLE_ATTRIBUTES = new Set(['aria-label', 'title', 'placeholder', 'alt', 'aria-valuetext', 'aria-roledescription', 'label']);

const CLASS_CALLS = new Set(['cn', 'clsx', 'classNames', 'twMerge']);
const PLUMBING_CALLS =
  /^(import|require|join|resolve|dirname|basename|extname|addEventListener|removeEventListener|querySelector|querySelectorAll|getElementById|closest|matches|getItem|setItem|removeItem|startsWith|endsWith|includes|indexOf|lastIndexOf|split|replace|replaceAll|match|matchAll|test|exec|padStart|padEnd|localeCompare|getAttribute|setAttribute|removeAttribute|createElement|invoke|handle|handleOnce|on|once|off|send|emit|removeListener|removeAllListeners|getPath|setPath|get|has|set|delete|prepare|exec|pragma|getPropertyValue|setProperty|toLocaleString|toLocaleDateString|toLocaleTimeString|Symbol|Intl\.\w+|RegExp|Buffer\.from|toString|encodeURIComponent|createHash|digest|update|readFile|readFileSync|writeFile|writeFileSync|existsSync|mkdirSync|rmSync|spawn|execFile|cmd|reg|query|run|all|statement|isType|typeOf|ofType|field|channel|is)$/;
const LOG_CALLS = /^(log|logger|this\.log|console|deps\.log|opts\.log|options\.log)\.(debug|info|warn|error|log)$/;

function calleeName(call) {
  const expression = call.expression;
  if (ts.isIdentifier(expression)) return expression.text;
  if (ts.isPropertyAccessExpression(expression)) return expression.getText().replace(/\s+/g, '');
  return expression.getText().replace(/\s+/g, '').slice(0, 40);
}

function classListLike(text) {
  const tokens = text.trim().split(/\s+/);
  return tokens.length > 0 && tokens.every((token) => /^[!-]?[a-z0-9[\]&>:_./%#()=,'-]+$/.test(token)) && tokens.some((token) => /[-:[]/.test(token));
}

function looksLikeProse(text) {
  if (!/[A-Za-z]/.test(text)) return false;
  if (classListLike(text)) return false;
  if (/^(https?:|file:|[a-z]+:\/\/)/.test(text)) return false;
  if (/^[\w.-]+:[\w:.-]+$/.test(text)) return false;
  if (/^[A-Za-z]:\\|^\.{0,2}\/|\\\\/.test(text)) return false;
  if (/^[a-z][a-zA-Z0-9]*$/.test(text)) return false;
  if (/^[a-z0-9]+([_-][a-z0-9]+)+$/.test(text)) return false;
  if (/^[A-Z0-9_]+$/.test(text) && text.includes('_')) return false;
  return /\s/.test(text.trim()) || /^[A-Z]/.test(text) || /[….?!]$/.test(text);
}

function processOf(file) {
  if (file.startsWith('src/renderer/')) return 'renderer';
  if (file.startsWith('src/main/launchers/sim/')) return 'simulator';
  if (file.startsWith('src/main/')) return 'main';
  if (file.startsWith('src/preload/')) return 'preload';
  return 'shared';
}

function inTypePosition(node) {
  for (let p = node.parent; p; p = p.parent) {
    if (ts.isTypeNode(p) && !ts.isExpressionWithTypeArguments(p)) return true;
    if (ts.isStatement(p) || ts.isClassElement(p) || ts.isObjectLiteralElement(p) || ts.isJsxAttribute(p)) return false;
  }
  return false;
}

function holderOf(node) {
  const names = [];
  for (let p = node.parent; p && !ts.isSourceFile(p); p = p.parent) {
    if ((ts.isPropertyAssignment(p) || ts.isMethodDeclaration(p) || ts.isPropertyDeclaration(p)) && p.name) names.unshift(p.name.getText());
    else if ((ts.isVariableDeclaration(p) || ts.isFunctionDeclaration(p) || ts.isClassDeclaration(p)) && p.name) names.unshift(p.name.getText());
  }
  return names.join('.');
}

// The syntactic place a string sits in, which says whether it can reach a screen.
function contextOf(node) {
  let child = node;
  for (let p = node.parent; p; child = p, p = p.parent) {
    if (ts.isJsxAttribute(p)) return { context: `attr:${p.name.getText()}`, attribute: p.name.getText(), element: p.parent.parent.tagName.getText() };
    if (ts.isJsxExpression(p) && (ts.isJsxElement(p.parent) || ts.isJsxFragment(p.parent))) return { context: 'jsx-child' };
    if (ts.isParenthesizedExpression(p) || ts.isAsExpression(p) || ts.isSatisfiesExpression(p) || ts.isNonNullExpression(p)) continue;
    if (ts.isConditionalExpression(p)) {
      if (child === p.condition) return { context: 'condition', hidden: true };
      continue;
    }
    if (ts.isBinaryExpression(p)) {
      const op = p.operatorToken.kind;
      if (
        op === ts.SyntaxKind.EqualsEqualsEqualsToken ||
        op === ts.SyntaxKind.ExclamationEqualsEqualsToken ||
        op === ts.SyntaxKind.EqualsEqualsToken ||
        op === ts.SyntaxKind.ExclamationEqualsToken ||
        op === ts.SyntaxKind.InKeyword ||
        op === ts.SyntaxKind.InstanceOfKeyword
      )
        return { context: 'compare', hidden: true };
      continue;
    }
    if (ts.isTemplateSpan(p) || ts.isTemplateExpression(p)) continue;
    if (ts.isCaseClause(p)) return { context: 'case', hidden: true };
    if (ts.isElementAccessExpression(p)) return child === p.argumentExpression ? { context: 'index', hidden: true } : { context: 'access' };
    if (ts.isCallExpression(p) || ts.isNewExpression(p)) {
      if (child === p.expression) return { context: 'callee', hidden: true };
      const name = ts.isNewExpression(p) ? `new ${p.expression.getText()}` : calleeName(p);
      const short = name.split('.').pop();
      if (CLASS_CALLS.has(short)) return { context: `call:${name}`, hidden: true };
      if (LOG_CALLS.test(name) || /^log\.(debug|info|warn|error)$/.test(name) || /\.(debug|info|warn|error)$/.test(name))
        return { context: `log:${name}`, hidden: true, log: true };
      if (PLUMBING_CALLS.test(short) || PLUMBING_CALLS.test(name)) return { context: `call:${name}`, hidden: true };
      return { context: `call:${name}` };
    }
    if (ts.isPropertyAssignment(p)) return { context: `prop:${p.name.getText()}` };
    if (ts.isVariableDeclaration(p)) return { context: `var:${p.name.getText().slice(0, 40)}` };
    if (ts.isParameter(p) || ts.isBindingElement(p)) return { context: `default:${p.name.getText().slice(0, 40)}` };
    if (ts.isPropertyDeclaration(p)) return { context: `field:${p.name.getText()}` };
    if (ts.isReturnStatement(p) || ts.isArrowFunction(p)) return { context: 'return' };
    if (ts.isArrayLiteralExpression(p)) continue;
    if (ts.isSpreadElement(p) || ts.isObjectLiteralExpression(p) || ts.isShorthandPropertyAssignment(p)) continue;
    if (ts.isExportAssignment(p)) return { context: 'export' };
    if (ts.isThrowStatement(p)) return { context: 'throw' };
    if (ts.isEnumMember(p)) return { context: 'enum', hidden: true };
    if (ts.isStatement(p)) return { context: ts.SyntaxKind[p.kind] };
  }
  return { context: 'other' };
}

function jsxClassTokens(attribute, checker) {
  const required = new Set();
  const optional = new Set();
  const add = (set, text) => {
    for (const token of text.split(/\s+/)) if (token) set.add(token);
  };
  const init = attribute.initializer;
  if (!init) return null;
  if (ts.isStringLiteral(init)) {
    add(required, init.text);
    return { required: [...required], optional: [], complete: true };
  }
  if (!ts.isJsxExpression(init) || !init.expression) return null;
  const expression = init.expression;
  const seen = new Set();
  const collect = (node, set) => {
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
      add(set, node.text);
      return;
    }
    if (ts.isTemplateExpression(node)) {
      const pieces = [node.head.text, ...node.templateSpans.map((span) => span.literal.text)];
      pieces.forEach((piece, i) => {
        const tokens = piece.split(/\s+/);
        tokens.forEach((token, k) => {
          const touchesSlotBefore = k === 0 && i > 0 && !/^\s/.test(piece);
          const touchesSlotAfter = k === tokens.length - 1 && i < pieces.length - 1 && !/\s$/.test(piece);
          if (token && !touchesSlotBefore && !touchesSlotAfter) set.add(token);
        });
      });
      node.templateSpans.forEach((span) => collect(span.expression, optional));
      return;
    }
    if (ts.isIdentifier(node)) {
      const symbol = checker.getSymbolAtLocation(node);
      const declaration = symbol?.valueDeclaration;
      if (declaration && ts.isVariableDeclaration(declaration) && declaration.initializer && !seen.has(declaration)) {
        seen.add(declaration);
        collect(declaration.initializer, set);
      }
      return;
    }
    if (ts.isConditionalExpression(node)) {
      collect(node.whenTrue, optional);
      collect(node.whenFalse, optional);
      return;
    }
    if (ts.isCallExpression(node)) {
      node.arguments.forEach((arg) => collect(arg, optional));
      return;
    }
    if (ts.isParenthesizedExpression(node)) {
      collect(node.expression, set);
      return;
    }
    ts.forEachChild(node, (child) => collect(child, optional));
  };
  collect(expression, required);
  for (const token of required) optional.delete(token);
  return { required: [...required], optional: [...optional], complete: false };
}

const isTextLiteral = (node) => ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node);
const isPlus = (node) => ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken;
const isConcatTop = (node) => isPlus(node) && !isPlus(node.parent) && !(ts.isParenthesizedExpression(node.parent) && isPlus(node.parent.parent));

function concatOperands(node) {
  if (isPlus(node)) return [...concatOperands(node.left), ...concatOperands(node.right)];
  if (ts.isParenthesizedExpression(node) && isPlus(node.expression)) return concatOperands(node.expression);
  return [node];
}

export const templateText = (parts, slots) => parts.map((part, i) => (i === 0 ? part : `{${slots[i - 1]}}${part}`)).join('');

const position = (sf, pos) => {
  const { line, character } = sf.getLineAndCharacterOfPosition(pos);
  return { line: line + 1, col: character + 1 };
};

// Every string the source holds, where it sits, and the places its value can flow to on its way to a screen.
export function walkSource() {
  const files = sourceFiles();
  const program = ts.createProgram(files, {
    jsx: ts.JsxEmit.Preserve,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    target: ts.ScriptTarget.ES2022,
    noLib: true,
    types: [],
    allowImportingTsExtensions: true,
    noEmit: true,
    paths: {
      '@shared/*': [join(repoRoot, 'src', 'shared', '*')],
      '@renderer/*': [join(repoRoot, 'src', 'renderer', 'src', '*')],
    },
  });
  const checker = program.getTypeChecker();
  const sources = files.map((file) => program.getSourceFile(file));

  const resolveSymbol = (symbol) => {
    if (symbol && symbol.flags & ts.SymbolFlags.Alias) {
      try {
        return checker.getAliasedSymbol(symbol);
      } catch {
        return symbol;
      }
    }
    return symbol;
  };

  const references = new Map();
  const strings = [];
  const elements = [];
  const lucide = [];
  const jsxUsages = [];

  for (const sf of sources) {
    const file = rel(sf.fileName);
    const visit = (node) => {
      if (ts.isImportDeclaration(node)) {
        const from = node.moduleSpecifier.text;
        if (from === 'lucide-react' && node.importClause?.namedBindings && ts.isNamedImports(node.importClause.namedBindings)) {
          for (const spec of node.importClause.namedBindings.elements) {
            if (spec.isTypeOnly || node.importClause.isTypeOnly) continue;
            lucide.push({
              file,
              line: position(sf, spec.getStart()).line,
              imported: (spec.propertyName ?? spec.name).text,
              local: spec.name.text,
              node: spec.name,
            });
          }
        }
        return;
      }
      if (ts.isExportDeclaration(node) && node.moduleSpecifier) return;
      if (ts.isIdentifier(node)) {
        const symbol = resolveSymbol(checker.getSymbolAtLocation(node));
        if (symbol) {
          if (!references.has(symbol)) references.set(symbol, []);
          references.get(symbol).push(node);
        }
      }
      if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) {
        const tag = node.tagName.getText();
        const owner = ts.isJsxOpeningElement(node) ? node.parent : node;
        const classAttribute = node.attributes.properties.find((p) => ts.isJsxAttribute(p) && p.name.getText() === 'className');
        const props = {};
        for (const p of node.attributes.properties) {
          if (!ts.isJsxAttribute(p)) props['...'] = p.getText();
          else if (!p.initializer) props[p.name.getText()] = true;
          else if (ts.isStringLiteral(p.initializer)) props[p.name.getText()] = p.initializer.text;
          else props[p.name.getText()] = `{${p.initializer.expression?.getText().replace(/\s+/g, ' ') ?? ''}}`;
        }
        jsxUsages.push({ file, line: position(sf, node.getStart()).line, tag, props });
        elements.push({
          file,
          tag,
          start: owner.getStart(),
          end: owner.getEnd(),
          line: position(sf, owner.getStart()).line,
          classes: classAttribute ? jsxClassTokens(classAttribute, checker) : null,
        });
      }
      const record = (entry) => {
        const at = position(sf, node.getStart());
        const place = contextOf(node);
        strings.push({
          file,
          line: at.line,
          col: at.col,
          pos: node.getStart(),
          end: node.getEnd(),
          node,
          process: processOf(file),
          holder: holderOf(node),
          ...place,
          ...entry,
        });
      };
      if (ts.isJsxText(node)) {
        const text = jsxText(node.text);
        if (text.trim() !== '') {
          // getStart() of JSX text already skips its leading white space; the offset counts from the node's full start.
          const at = position(sf, node.pos + node.text.search(/\S/));
          strings.push({
            file,
            line: at.line,
            col: at.col,
            pos: node.getStart(),
            end: node.getEnd(),
            node,
            process: processOf(file),
            holder: holderOf(node),
            kind: 'jsx-text',
            text,
            context: 'jsx-text',
          });
        }
      } else if ((ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) && !inTypePosition(node)) {
        const parent = node.parent;
        const isKey = (ts.isPropertyAssignment(parent) || ts.isPropertyDeclaration(parent) || ts.isMethodDeclaration(parent)) && parent.name === node;
        const isModule = ts.isExternalModuleReference(parent) || ts.isImportTypeNode?.(parent) || ts.isLiteralTypeNode(parent);
        if (!isKey && !isModule) record({ kind: ts.isJsxAttribute(parent) ? 'jsx-attr' : 'literal', text: node.text });
      } else if (ts.isTemplateExpression(node) && !inTypePosition(node)) {
        const parts = [node.head.text, ...node.templateSpans.map((span) => span.literal.text)];
        const slots = node.templateSpans.map((span) => span.expression.getText().replace(/\s+/g, ' '));
        const slotSpans = node.templateSpans.map((span) => ({ start: span.expression.getStart(), end: span.expression.getEnd() }));
        record({ kind: 'template', text: templateText(parts, slots), parts, slots, slotSpans });
        node.templateSpans.forEach((span) => visit(span.expression));
        return;
      } else if (isConcatTop(node) && !inTypePosition(node)) {
        const operands = concatOperands(node);
        if (operands.some(isTextLiteral) && operands.some((operand) => !isTextLiteral(operand))) {
          const parts = [''];
          const slots = [];
          const slotSpans = [];
          for (const operand of operands) {
            if (isTextLiteral(operand)) parts[parts.length - 1] += operand.text;
            else {
              slots.push(operand.getText().replace(/\s+/g, ' '));
              slotSpans.push({ start: operand.getStart(), end: operand.getEnd() });
              parts.push('');
            }
          }
          record({ kind: 'concat', text: templateText(parts, slots), parts, slots, slotSpans });
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(sf);
  }

  for (const entry of strings) {
    const attribute = entry.attribute;
    if (entry.kind === 'jsx-text' || entry.context === 'jsx-child') entry.visible = true;
    else if (attribute !== undefined)
      entry.visible = !HIDDEN_ATTRIBUTES.has(attribute) && !attribute.startsWith('data-') && (VISIBLE_ATTRIBUTES.has(attribute) || looksLikeProse(entry.text));
    else if (entry.hidden) entry.visible = false;
    else entry.visible = looksLikeProse(entry.parts ? entry.parts.join(' ') : entry.text);
    if (entry.process === 'simulator') entry.visible = false;
  }

  for (const icon of lucide) {
    const symbol = resolveSymbol(checker.getSymbolAtLocation(icon.node));
    icon.uses = [];
    for (const ref of (symbol && references.get(symbol)) ?? []) {
      if (ref === icon.node || rel(ref.getSourceFile().fileName) !== icon.file) continue;
      const parent = ref.parent;
      const sf = ref.getSourceFile();
      const line = position(sf, ref.getStart()).line;
      if (ts.isJsxClosingElement(parent)) continue;
      if ((ts.isJsxOpeningElement(parent) || ts.isJsxSelfClosingElement(parent)) && parent.tagName === ref) {
        const usage = jsxUsages.find((u) => u.file === rel(sf.fileName) && u.line === line && u.tag === icon.local);
        icon.uses.push({ file: rel(sf.fileName), line, as: 'element', props: usage?.props ?? {} });
      } else {
        const holder = ts.isPropertyAssignment(parent)
          ? `prop:${parent.name.getText()}`
          : ts.isJsxExpression(parent)
            ? 'jsx-expression'
            : parent.getText().replace(/\s+/g, ' ').slice(0, 80);
        icon.uses.push({ file: rel(sf.fileName), line, as: 'value', where: holder });
      }
    }
  }
  const reachOf = (entry) => reach(entry.node, { checker, references, resolveSymbol });
  return { program, checker, strings, elements, lucide, jsxUsages, reachOf, rel };
}

function enclosingFunction(node) {
  for (let p = node.parent; p; p = p.parent) {
    if (ts.isFunctionDeclaration(p) || ts.isFunctionExpression(p) || ts.isArrowFunction(p) || ts.isMethodDeclaration(p)) return p;
    if (ts.isSourceFile(p)) return null;
  }
  return null;
}

function functionNameNode(fn) {
  if ((ts.isFunctionDeclaration(fn) || ts.isMethodDeclaration(fn)) && fn.name) return fn.name;
  const parent = fn.parent;
  if (ts.isVariableDeclaration(parent) && ts.isIdentifier(parent.name)) return parent.name;
  if (ts.isPropertyAssignment(parent)) return parent.name;
  return null;
}

const NON_TEXT_ATTRIBUTE = /^(aria-.*|title|alt|placeholder|className|key|id)$/;

// A value handed to an attribute of a DOM element that is never drawn as text (a tooltip, an accessible name) goes no further.
function inNonTextAttribute(node) {
  for (let p = node.parent; p; p = p.parent) {
    if (ts.isJsxAttribute(p)) return NON_TEXT_ATTRIBUTE.test(p.name.getText()) && /^[a-z]/.test(p.parent.parent.tagName.getText());
    if (ts.isJsxElement(p) || ts.isJsxSelfClosingElement(p) || ts.isJsxFragment(p) || ts.isStatement(p) || ts.isFunctionLike(p)) return false;
  }
  return false;
}

// Where a value can go: through conditionals, maps, variables, returns, props and arguments, up to a JSX child or attribute.
export function reach(start, { checker, references, resolveSymbol }) {
  const sites = [];
  const seen = new Set();
  const queue = [start];
  const bySymbolOf = (nameNode) => {
    const symbol = resolveSymbol(checker.getSymbolAtLocation(nameNode));
    return symbol ? (references.get(symbol) ?? []).filter((ref) => ref !== nameNode) : [];
  };
  let head = 0;
  while (head < queue.length && seen.size < 4000) {
    const node = queue[head];
    head += 1;
    if (seen.has(node)) continue;
    seen.add(node);
    if (node !== start && inNonTextAttribute(node)) continue;
    sites.push({ file: node.getSourceFile().fileName, pos: node.getStart() });
    const p = node.parent;
    if (!p || ts.isSourceFile(p)) continue;
    if (ts.isJsxText(node)) continue;
    if (
      ts.isParenthesizedExpression(p) ||
      ts.isAsExpression(p) ||
      ts.isSatisfiesExpression(p) ||
      ts.isNonNullExpression(p) ||
      ts.isTemplateSpan(p) ||
      ts.isArrayLiteralExpression(p) ||
      ts.isObjectLiteralExpression(p) ||
      ts.isSpreadElement(p) ||
      ts.isSpreadAssignment(p) ||
      ts.isTemplateExpression(p) ||
      ts.isAwaitExpression(p)
    ) {
      queue.push(p);
      continue;
    }
    if (ts.isConditionalExpression(p)) {
      if (node !== p.condition) queue.push(p);
      continue;
    }
    if (ts.isBinaryExpression(p)) {
      const op = p.operatorToken.kind;
      if (
        op === ts.SyntaxKind.QuestionQuestionToken ||
        op === ts.SyntaxKind.BarBarToken ||
        op === ts.SyntaxKind.AmpersandAmpersandToken ||
        op === ts.SyntaxKind.PlusToken
      )
        queue.push(p);
      else if (op === ts.SyntaxKind.EqualsToken && node === p.right) {
        if (ts.isIdentifier(p.left)) bySymbolOf(p.left).forEach((ref) => queue.push(ref));
        else queue.push(p.left);
      }
      continue;
    }
    if (ts.isPropertyAssignment(p) || ts.isShorthandPropertyAssignment(p)) {
      if (node !== p.name) queue.push(p.parent);
      continue;
    }
    if (ts.isPropertyAccessExpression(p) || ts.isElementAccessExpression(p)) {
      if (node === p.expression) queue.push(p);
      continue;
    }
    if (ts.isCallExpression(p) || ts.isNewExpression(p)) {
      if (node === p.expression) {
        queue.push(p);
        continue;
      }
      const index = (p.arguments ?? []).indexOf(node);
      if (
        ts.isCallExpression(p) &&
        ts.isPropertyAccessExpression(p.expression) &&
        /^(map|flatMap|filter|join|concat|find|slice|sort|reduce)$/.test(p.expression.name.text)
      ) {
        queue.push(p);
      }
      const callee = ts.isPropertyAccessExpression(p.expression) ? p.expression.name : p.expression;
      const symbol = resolveSymbol(checker.getSymbolAtLocation(callee));
      const declaration = symbol?.valueDeclaration;
      const fn =
        declaration && (ts.isFunctionDeclaration(declaration) || ts.isMethodDeclaration(declaration))
          ? declaration
          : declaration &&
              ts.isVariableDeclaration(declaration) &&
              declaration.initializer &&
              (ts.isArrowFunction(declaration.initializer) || ts.isFunctionExpression(declaration.initializer))
            ? declaration.initializer
            : null;
      const param = fn && index >= 0 ? fn.parameters[index] : undefined;
      if (param) {
        if (ts.isIdentifier(param.name)) bySymbolOf(param.name).forEach((ref) => queue.push(ref));
        else param.name.elements?.forEach((element) => ts.isIdentifier(element.name) && bySymbolOf(element.name).forEach((ref) => queue.push(ref)));
      }
      continue;
    }
    if (ts.isArrowFunction(p) && node === p.body) {
      queue.push(p);
      continue;
    }
    if ((ts.isArrowFunction(node) || ts.isFunctionExpression(node)) && (ts.isCallExpression(p) || ts.isVariableDeclaration(p))) {
      queue.push(p);
      continue;
    }
    if (ts.isReturnStatement(p)) {
      const fn = enclosingFunction(p);
      if (fn) {
        const name = functionNameNode(fn);
        if (name) bySymbolOf(name).forEach((ref) => queue.push(ref));
        if (ts.isArrowFunction(fn) || ts.isFunctionExpression(fn)) queue.push(fn);
      }
      continue;
    }
    if (ts.isVariableDeclaration(p) && node === p.initializer) {
      if (ts.isIdentifier(p.name)) bySymbolOf(p.name).forEach((ref) => queue.push(ref));
      else
        p.name.elements?.forEach((element) => {
          if (ts.isBindingElement(element) && ts.isIdentifier(element.name)) bySymbolOf(element.name).forEach((ref) => queue.push(ref));
        });
      continue;
    }
    if ((ts.isParameter(p) || ts.isBindingElement(p)) && node === p.initializer && ts.isIdentifier(p.name)) {
      bySymbolOf(p.name).forEach((ref) => queue.push(ref));
      continue;
    }
    if (ts.isPropertyDeclaration(p) && node === p.initializer) {
      bySymbolOf(p.name).forEach((ref) => queue.push(ref));
      continue;
    }
    if (ts.isJsxExpression(p)) {
      const attribute = p.parent;
      if (ts.isJsxAttribute(attribute)) queue.push(attribute);
      continue;
    }
    if (ts.isJsxAttribute(p)) {
      queue.push(p);
      continue;
    }
    if (ts.isJsxAttribute(node)) {
      const opening = node.parent.parent;
      const tag = opening.tagName;
      if (/^[A-Z]/.test(tag.getText())) {
        const symbol = resolveSymbol(checker.getSymbolAtLocation(tag));
        const declaration = symbol?.valueDeclaration;
        const fn =
          declaration && ts.isFunctionDeclaration(declaration)
            ? declaration
            : declaration && ts.isVariableDeclaration(declaration) && declaration.initializer && ts.isArrowFunction(declaration.initializer)
              ? declaration.initializer
              : null;
        const props = fn?.parameters[0]?.name;
        const name = node.name.getText();
        if (props && ts.isObjectBindingPattern(props)) {
          for (const element of props.elements) {
            const key = (element.propertyName ?? element.name).getText();
            if (key === name && ts.isIdentifier(element.name)) bySymbolOf(element.name).forEach((ref) => queue.push(ref));
          }
        } else if (props && ts.isIdentifier(props)) {
          for (const ref of bySymbolOf(props)) if (ts.isPropertyAccessExpression(ref.parent) && ref.parent.name.text === name) queue.push(ref.parent);
        }
      }
      continue;
    }
  }
  return sites.map((site) => ({ file: rel(site.file), pos: site.pos }));
}
