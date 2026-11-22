// Minimal Node test runner reporter that emits GitHub Actions ::error::
// annotations for failed or timed-out tests.

import { relative } from 'node:path';

function escapeProp(value) {
  return String(value ?? '')
    .replace(/%/g, '%25')
    .replace(/\r/g, '%0D')
    .replace(/\n/g, '%0A')
    .replace(/:/g, '%3A')
    .replace(/,/g, '%2C');
}

function escapeData(value) {
  return String(value ?? '')
    .replace(/%/g, '%25')
    .replace(/\r/g, '%0D')
    .replace(/\n/g, '%0A');
}

function formatErrorMessage(details) {
  const err = details?.error;
  if (!err) return 'Test failed';
  const cause = err.cause;
  const parts = [];
  if (err.code) parts.push(`[${err.code}]`);
  if (cause?.message && cause.message !== err.message) {
    parts.push(`${err.message}: ${cause.message}`);
  } else if (err.message) {
    parts.push(err.message);
  }
  const text = parts.join(' ').trim() || String(err);
  return text.length > 600 ? `${text.slice(0, 597)}...` : text;
}

export default async function* ghTestReporter(source) {
  for await (const event of source) {
    if (event.type !== 'test:fail') continue;
    const { data } = event;
    // Skip aggregate suite/file wrappers when child test failures already emit details,
    // except when the file itself errored/timed out before or outside individual tests.
    if (data?.details?.error?.failureType === 'subtestsFailed') continue;

    const props = [];
    if (data.file) {
      const rel = relative(process.cwd(), data.file).replaceAll('\\', '/');
      props.push(`file=${escapeProp(rel)}`);
    }
    if (typeof data.line === 'number') {
      props.push(`line=${data.line}`);
    }
    if (data.name) {
      props.push(`title=${escapeProp(data.name)}`);
    }
    const header = props.length > 0 ? `::error ${props.join(',')}::` : '::error::';
    yield `${header}${escapeData(formatErrorMessage(data.details))}\n`;
  }
}
