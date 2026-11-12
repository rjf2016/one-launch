import ts from 'typescript';

const FUNCTION_KINDS = new Set([
  ts.SyntaxKind.FunctionDeclaration,
  ts.SyntaxKind.FunctionExpression,
  ts.SyntaxKind.ArrowFunction,
  ts.SyntaxKind.MethodDeclaration,
  ts.SyntaxKind.Constructor,
  ts.SyntaxKind.GetAccessor,
  ts.SyntaxKind.SetAccessor,
]);
const SHORT_CIRCUIT = new Map([
  [ts.SyntaxKind.AmpersandAmpersandToken, '&&'],
  [ts.SyntaxKind.BarBarToken, '||'],
  [ts.SyntaxKind.QuestionQuestionToken, '??'],
  [ts.SyntaxKind.AmpersandAmpersandEqualsToken, '&&='],
  [ts.SyntaxKind.BarBarEqualsToken, '||='],
  [ts.SyntaxKind.QuestionQuestionEqualsToken, '??='],
]);

export const SyntaxKind = ts.SyntaxKind;

export const parseSource = (path, text) =>
  ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true, path.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);

const nameOf = (node) => (node.name && ts.isIdentifier(node.name) ? node.name.text : null);

function topLevel(file) {
  const functions = new Map();
  const classes = new Map();
  const values = new Map();
  for (const statement of file.statements) {
    if (ts.isFunctionDeclaration(statement) && statement.name && statement.body) functions.set(statement.name.text, statement);
    else if (ts.isClassDeclaration(statement) && statement.name) classes.set(statement.name.text, statement);
    else if (ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        if (!ts.isIdentifier(declaration.name)) continue;
        const init = declaration.initializer;
        if (init && (ts.isArrowFunction(init) || ts.isFunctionExpression(init))) functions.set(declaration.name.text, init);
        else values.set(declaration.name.text, declaration);
      }
    }
  }
  return { functions, classes, values };
}

export function findTarget(file, name) {
  const { functions, classes, values } = topLevel(file);
  const [owner, member] = name.split('.');
  if (member !== undefined) {
    const cls = classes.get(owner);
    if (!cls) return null;
    const node = cls.members.find((m) => (member === 'constructor' ? ts.isConstructorDeclaration(m) : nameOf(m) === member));
    return node ? { node, kind: 'method' } : null;
  }
  if (functions.has(owner)) return { node: functions.get(owner), kind: 'function' };
  if (classes.has(owner)) return { node: classes.get(owner), kind: 'class' };
  if (values.has(owner)) return { node: values.get(owner), kind: 'value' };
  return null;
}

const firstOf = (statement) => (ts.isBlock(statement) ? (statement.statements[0] ?? null) : statement);
const throwTail = (anchor) => (anchor && ts.isThrowStatement(anchor) ? ', a throw' : '');

// Every place V8 counts on its own: a function body, each arm of a branch, a loop body, a catch, the right side of a short circuit.
export function collectBlocks(root) {
  const blocks = [];
  const add = (kind, node, anchor, extra = {}) => blocks.push({ kind, node, anchor, ...extra });
  const visit = (node) => {
    if (FUNCTION_KINDS.has(node.kind) && node.body) {
      const body = node.body;
      const anchor = ts.isBlock(body) ? (body.statements[0] ?? null) : body;
      add(node === root ? 'function' : 'nested function', node, anchor);
      for (const parameter of node.parameters) if (parameter.initializer) add('default parameter', parameter.initializer, parameter.initializer);
    } else if (ts.isIfStatement(node)) {
      const then = firstOf(node.thenStatement);
      add(`if arm${throwTail(then)}`, node.thenStatement, then);
      if (node.elseStatement) {
        const otherwise = firstOf(node.elseStatement);
        add(`else arm${throwTail(otherwise)}`, node.elseStatement, otherwise);
      } else add('if never false', node, node, { minus: then });
    } else if (ts.isConditionalExpression(node)) {
      add('?: true arm', node.whenTrue, node.whenTrue);
      add('?: false arm', node.whenFalse, node.whenFalse);
    } else if (ts.isBinaryExpression(node) && SHORT_CIRCUIT.has(node.operatorToken.kind)) {
      add(`${SHORT_CIRCUIT.get(node.operatorToken.kind)} right side`, node.right, node.right);
    } else if (ts.isCaseClause(node) || ts.isDefaultClause(node)) {
      if (node.statements.length > 0) add(ts.isCaseClause(node) ? 'case' : 'default case', node, node.statements[0]);
    } else if (ts.isCatchClause(node)) {
      add('catch', node.block, node.block.statements[0] ?? null);
    } else if (ts.isTryStatement(node) && node.finallyBlock) {
      add('finally', node.finallyBlock, node.finallyBlock.statements[0] ?? null);
    } else if (ts.isForStatement(node) || ts.isForInStatement(node) || ts.isForOfStatement(node) || ts.isWhileStatement(node)) {
      add('loop body', node.statement, firstOf(node.statement));
    }
    ts.forEachChild(node, visit);
  };
  visit(root);
  return blocks;
}

export function sameModuleCallees(file, root) {
  const { functions } = topLevel(file);
  const found = new Map();
  const queue = [root];
  while (queue.length > 0) {
    const node = queue.shift();
    const visit = (child) => {
      if ((ts.isCallExpression(child) || ts.isNewExpression(child)) && ts.isIdentifier(child.expression)) {
        const name = child.expression.text;
        const target = functions.get(name);
        if (target && target !== root && !found.has(name)) {
          found.set(name, target);
          queue.push(target);
        }
      }
      ts.forEachChild(child, visit);
    };
    visit(node);
  }
  return [...found].map(([name, node]) => ({ name, node }));
}

export function span(file, node) {
  const start = file.getLineAndCharacterOfPosition(node.getStart(file));
  const end = file.getLineAndCharacterOfPosition(node.getEnd());
  return { start, end, text: `${start.line + 1}:${start.character + 1}-${end.line + 1}:${end.character + 1}` };
}

export const firstLine = (file, node) => file.text.slice(node.getStart(file), node.getEnd()).split('\n')[0].trim().replace(/\s+/g, ' ').slice(0, 100);
