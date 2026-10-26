export { type Expr, type BinaryOp, ExpressionError } from './ast';
export { parseExpression } from './parser';
export {
  evaluate,
  evaluateExpression,
  analyzeExpression,
  type ExpressionAnalysis,
  type ExpressionContext,
} from './evaluate';
export { FUNCTION_NAMES, FUNCTION_INFO, type FunctionInfo, callFunction, compileRegex } from './functions';
export {
  findTemplateExpressions,
  hasTemplate,
  renderTemplate,
  renderText,
  renderDeep,
  type TemplateMatch,
} from './template';
export {
  stringifyValue,
  looseEquals,
  compareValues,
  isNumberLike,
  toNumber,
  isTruthy,
  splitLines,
} from './values';
