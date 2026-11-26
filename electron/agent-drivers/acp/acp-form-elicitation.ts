// ACP `elicitation/create` forms as AhaStation question cards.
// Adapted from Orca (MIT, Copyright (c) 2026 Lovecast Inc.): src/main/acp/requests/acp-form-elicitation.ts
import type { AgentQuestion } from '../../orchestration/agent-session-driver.js';

export const ACP_FORM_ELICITATION_METHOD = 'elicitation/create';
/** A question card shows at most this many fields; the rest are answered as not shown. */
export const MAX_FORM_QUESTIONS = 4;
const OTHER_SUFFIXES = ['__other', '_custom', '_other'] as const;
const OTHER_CHOICE = 'other';
const NOT_SHOWN_ANSWER = `Not shown to the user: AhaStation shows at most ${MAX_FORM_QUESTIONS} questions at once. Ask again.`;
const YES = '是';
const NO = '否';

type Obj = Record<string, unknown>;
const object = (value: unknown): Obj => (value && typeof value === 'object' && !Array.isArray(value) ? value as Obj : {});
const text = (value: unknown): string | undefined => (typeof value === 'string' ? value : undefined);

interface Choice { value: string; label: string; description: string }
interface Field {
  key: string;
  type: 'string' | 'boolean' | 'array';
  required: boolean;
  otherKey?: string;
  otherChoice: boolean;
  choices: Choice[] | null;
  question: AgentQuestion;
}

/** The request could not be shown; the agent is answered with a JSON-RPC error. */
export class AcpRequestError extends Error {
  constructor(message: string, readonly code = -32602) {
    super(message);
  }
}

export interface AcpQuestionPresentation {
  questions: AgentQuestion[];
  /** The agent's reply for the person's answers, or for a skip when null. Throws on answers that do not fit. */
  reply(answers: Record<string, string[]> | null): unknown;
}

function choicesOf(property: Obj, type: Field['type'], otherChoice: boolean): Choice[] | null {
  if (type === 'boolean') return [{ value: 'true', label: YES, description: '' }, { value: 'false', label: NO, description: '' }];
  const holder = type === 'array' ? object(property.items) : property;
  const listed = (Array.isArray(holder.oneOf) ? holder.oneOf : Array.isArray(holder.anyOf) ? holder.anyOf : null)
    ?.map(object).filter((choice) => typeof choice.const === 'string');
  const fromList = listed
    ?.filter((choice) => !otherChoice || choice.const !== OTHER_CHOICE)
    .map((choice) => ({
      value: choice.const as string,
      label: text(choice.title) || (choice.const as string),
      description: text(choice.description) ?? '',
    }));
  const fromEnum = Array.isArray(holder.enum)
    ? holder.enum.filter((value): value is string => typeof value === 'string').map((value) => ({ value, label: value, description: '' }))
    : undefined;
  const choices = fromList ?? fromEnum ?? null;
  if (type === 'array' && !choices) throw new AcpRequestError('Unsupported ACP elicitation form');
  return choices;
}

/** Turns a form into question cards; each field keeps its key, so answers map back to the schema. */
export function acpFormQuestions(params: unknown): AcpQuestionPresentation {
  const form = object(params);
  const schema = object(form.requestedSchema);
  const properties = object(schema.properties);
  if (form.mode !== undefined && form.mode !== 'form') throw new AcpRequestError('Unsupported ACP elicitation mode');
  const message = text(form.message)?.trim() ?? '';
  const required = new Set(Array.isArray(schema.required) ? schema.required.filter((key): key is string => typeof key === 'string') : []);
  const typeOf = (key: string): Field['type'] | null => {
    const type = object(properties[key]).type;
    return type === 'string' || type === 'boolean' || type === 'array' ? type : null;
  };
  const isTextCompanion = (key: string) => {
    const property = object(properties[key]);
    return typeOf(key) === 'string' && !property.enum && !property.oneOf && property.format === undefined && !required.has(key);
  };
  const otherKeys = new Map<string, string>();
  const otherChoiceKeys = new Set<string>();
  for (const key of Object.keys(properties)) {
    const property = object(properties[key]);
    const type = typeOf(key);
    if (!type) throw new AcpRequestError('Unsupported ACP elicitation field');
    const listed = type === 'array' ? object(property.items).anyOf : property.oneOf;
    if (Array.isArray(listed) && listed.some((choice) => object(choice).const === OTHER_CHOICE) && isTextCompanion(`${key}_other`)) {
      otherKeys.set(key, `${key}_other`);
      otherChoiceKeys.add(key);
      continue;
    }
    if (required.has(key) || type === 'boolean' || !(property.enum || property.oneOf || type === 'array')) continue;
    const companion = OTHER_SUFFIXES.map((suffix) => key + suffix).find(isTextCompanion);
    if (companion) otherKeys.set(key, companion);
  }
  const companions = new Set(otherKeys.values());
  const keys = Object.keys(properties).filter((key) => !companions.has(key));
  if (keys.length === 0) throw new AcpRequestError('Unsupported ACP elicitation form');
  const fields: Field[] = keys.slice(0, MAX_FORM_QUESTIONS).map((key, index) => {
    const property = object(properties[key]);
    const type = typeOf(key)!;
    const otherKey = otherKeys.get(key);
    const choices = choicesOf(property, type, otherChoiceKeys.has(key));
    if (choices?.length === 0 && !otherKey) throw new AcpRequestError('Unsupported ACP elicitation form');
    const own = [text(property.title), text(property.description)].filter((part): part is string => Boolean(part));
    const shared = message && (index === 0 || own.length === 0) ? [message] : [];
    return {
      key, type, required: required.has(key), ...(otherKey ? { otherKey } : {}), otherChoice: otherChoiceKeys.has(key), choices,
      question: {
        id: `q${index + 1}`,
        header: text(property.title) ?? '',
        prompt: [...new Set([...shared, ...own])].join('\n\n'),
        allowOther: !choices || Boolean(otherKey),
        options: (choices ?? []).map((choice) => ({
          label: choice.value === property.default ? `${choice.label}（推荐）` : choice.label,
          description: choice.description,
        })),
      },
    };
  });
  return {
    questions: fields.map((field) => field.question),
    reply(answers) {
      if (answers === null) return { action: 'cancel' };
      const content: Record<string, string | boolean | string[]> = {};
      for (const field of fields) {
        const given = (answers[field.question.id] ?? []).map((value) => value.trim()).filter(Boolean);
        if (given.length === 0) {
          if (field.required) throw new AcpRequestError('Question answer does not match the offered questions');
          continue;
        }
        if (!field.choices) {
          content[field.key] = given.join('\n');
          continue;
        }
        const values: string[] = [];
        const typed: string[] = [];
        for (const value of given) {
          const index = field.question.options.findIndex((option) => option.label === value);
          if (index >= 0) values.push(field.choices[index]!.value);
          else typed.push(value);
        }
        if (typed.length && !field.otherKey) throw new AcpRequestError('Question answer does not match the offered questions');
        if (typed.length && field.otherChoice) values.push(OTHER_CHOICE);
        if (field.type === 'array') content[field.key] = values;
        else if (values[0] !== undefined) content[field.key] = field.type === 'boolean' ? values[0] === 'true' : values[0];
        if (typed.length && field.otherKey) content[field.otherKey] = typed.join('\n');
      }
      for (const key of keys.slice(MAX_FORM_QUESTIONS)) {
        const otherKey = otherKeys.get(key);
        if (otherKey) {
          content[otherKey] = NOT_SHOWN_ANSWER;
          if (otherChoiceKeys.has(key)) content[key] = typeOf(key) === 'array' ? [OTHER_CHOICE] : OTHER_CHOICE;
        } else if (typeOf(key) === 'string' && !object(properties[key]).enum && !object(properties[key]).oneOf) {
          content[key] = NOT_SHOWN_ANSWER;
        }
      }
      return { action: 'accept', content };
    },
  };
}
