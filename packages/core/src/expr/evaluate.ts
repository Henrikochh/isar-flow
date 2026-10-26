import { type Expr, ExpressionError } from './ast';
import { callFunction } from './functions';
import { parseExpression } from './parser';
import { compareValues, isTruthy, looseEquals, stringifyValue, toNumber } from './values';

export type ExpressionContext = Record<string, unknown>;

const BLOCKED_PROPERTIES = new Set(['__proto__', 'constructor', 'prototype']);

function readProperty(object: unknown, key: unknown): unknown {
  if (object == null) return undefined;
  const name = typeof key === 'number' ? String(key) : stringifyValue(key);
  if (BLOCKED_PROPERTIES.has(name)) return undefined;
  if (typeof object === 'string') {
    if (name === 'length') return object.length;
    return /^\d+$/.test(name) ? object[Number(name)] : undefined;
  }
  if (Array.isArray(object)) {
    if (name === 'length') return object.length;
    return /^\d+$/.test(name) ? object[Number(name)] : undefined;
  }
  if (typeof object === 'object') {
    return Object.prototype.hasOwnProperty.call(object, name)
      ? (object as Record<string, unknown>)[name]
      : undefined;
  }
  return undefined;
}

export function evaluate(expr: Expr, ctx: ExpressionContext): unknown {
  switch (expr.kind) {
    case 'literal':
      return expr.value;
    case 'ident':
      return readProperty(ctx, expr.name);
    case 'member':
      return readProperty(evaluate(expr.object, ctx), evaluate(expr.property, ctx));
    case 'array':
      return expr.elements.map((element) => evaluate(element, ctx));
    case 'call':
      return callFunction(
        expr.callee,
        expr.args.map((arg) => evaluate(arg, ctx)),
        expr.start,
      );
    case 'unary': {
      const value = evaluate(expr.arg, ctx);
      return expr.op === '!' ? !isTruthy(value) : -toNumber(value);
    }
    case 'logical': {
      const left = evaluate(expr.left, ctx);
      if (expr.op === '&&') return isTruthy(left) ? evaluate(expr.right, ctx) : left;
      return isTruthy(left) ? left : evaluate(expr.right, ctx);
    }
    case 'conditional':
      return isTruthy(evaluate(expr.test, ctx))
        ? evaluate(expr.consequent, ctx)
        : evaluate(expr.alternate, ctx);
    case 'binary': {
      const left = evaluate(expr.left, ctx);
      const right = evaluate(expr.right, ctx);
      switch (expr.op) {
        case '+':
          return typeof left === 'string' || typeof right === 'string'
            ? stringifyValue(left) + stringifyValue(right)
            : toNumber(left) + toNumber(right);
        case '-':
          return toNumber(left) - toNumber(right);
        case '*':
          return toNumber(left) * toNumber(right);
        case '/':
          return toNumber(left) / toNumber(right);
        case '%':
          return toNumber(left) % toNumber(right);
        case '==':
          return looseEquals(left, right);
        case '!=':
          return !looseEquals(left, right);
        case '<':
          return compareValues(left, right) < 0;
        case '<=':
          return compareValues(left, right) <= 0;
        case '>':
          return compareValues(left, right) > 0;
        case '>=':
          return compareValues(left, right) >= 0;
      }
    }
  }
  throw new ExpressionError('Unsupported expression');
}

export function evaluateExpression(src: string, ctx: ExpressionContext): unknown {
  return evaluate(parseExpression(src), ctx);
}

export interface ExpressionAnalysis {
  /** Member paths rooted at an identifier, e.g. ['steps', 'tests', 'exitCode']. */
  references: string[][];
  functions: string[];
}

export function analyzeExpression(src: string): ExpressionAnalysis {
  const references: string[][] = [];
  const functions: string[] = [];

  // Returns the static path of a member chain, or null when the chain is not rooted at an identifier.
  const pathOf = (expr: Expr): string[] | null => {
    if (expr.kind === 'ident') return [expr.name];
    if (expr.kind === 'member') {
      const base = pathOf(expr.object);
      if (base && expr.property.kind === 'literal') return [...base, String(expr.property.value)];
    }
    return null;
  };

  const visit = (expr: Expr): void => {
    switch (expr.kind) {
      case 'ident':
        references.push([expr.name]);
        return;
      case 'member': {
        const path = pathOf(expr);
        if (path) {
          references.push(path);
          return;
        }
        // Dynamic member: record the static prefix and analyze the computed key separately.
        visit(expr.object);
        if (expr.property.kind !== 'literal') visit(expr.property);
        return;
      }
      case 'call':
        if (!functions.includes(expr.callee)) functions.push(expr.callee);
        expr.args.forEach((arg) => visit(arg));
        return;
      case 'array':
        expr.elements.forEach((element) => visit(element));
        return;
      case 'unary':
        visit(expr.arg);
        return;
      case 'binary':
      case 'logical':
        visit(expr.left);
        visit(expr.right);
        return;
      case 'conditional':
        visit(expr.test);
        visit(expr.consequent);
        visit(expr.alternate);
        return;
      case 'literal':
        return;
    }
  };

  visit(parseExpression(src));
  return { references, functions };
}
