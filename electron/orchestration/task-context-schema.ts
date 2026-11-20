import { z } from 'zod';
import {
  TASK_CONTEXT_MAX_ACCEPTANCE_CHARS,
  TASK_CONTEXT_MAX_BACKGROUND_CHARS,
  TASK_CONTEXT_MAX_CONSTRAINTS,
  TASK_CONTEXT_MAX_FILES,
  TASK_CONTEXT_MAX_ITEM_CHARS,
} from './worker-brief-context.js';

const background = z.string().trim().max(TASK_CONTEXT_MAX_BACKGROUND_CHARS).optional();
const acceptance = z.string().trim().max(TASK_CONTEXT_MAX_ACCEPTANCE_CHARS).optional();
const item = z.string().trim().min(1).max(TASK_CONTEXT_MAX_ITEM_CHARS);
const constraints = z.array(item).max(TASK_CONTEXT_MAX_CONSTRAINTS).optional();
const files = z.array(item).max(TASK_CONTEXT_MAX_FILES).optional();

export const taskContextFields = {
  context: background,
  background,
  acceptance,
  constraints,
  files,
  taskContext: z.object({ background, acceptance, constraints, files }).nullish(),
};
