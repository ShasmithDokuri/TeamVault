const { isUuid } = require('../workspaces/validation');

const PROJECT_NAME_MAX = 120;
const TASK_TITLE_MAX = 200;
const PROJECT_DESCRIPTION_MAX = 5000;
const TASK_DESCRIPTION_MAX = 10000;
const TASK_STATUSES = new Set(['todo', 'in_progress', 'done']);
const TASK_PRIORITIES = new Set(['low', 'medium', 'high', 'urgent']);

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function hasOnlyKeys(value, allowedKeys) {
  return isPlainObject(value) && Object.keys(value).every((key) => allowedKeys.includes(key));
}

function validateText(value, { maxLength, nullable = false, allowMultiline = false }) {
  if (nullable && value === null) return { valid: true, value: null };
  if (typeof value !== 'string') return { valid: false };
  const text = value.normalize('NFKC').trim();
  const controls = allowMultiline
    ? /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u
    : /[\u0000-\u001f\u007f]/u;
  if ([...text].length > maxLength || controls.test(text)) {
    return { valid: false };
  }
  return { valid: true, value: text };
}

function validateRequiredText(value, maxLength) {
  const result = validateText(value, { maxLength });
  return result.valid && result.value.length > 0 ? result : { valid: false };
}

function validateDescription(value, maxLength) {
  return validateText(value, { maxLength, nullable: true, allowMultiline: true });
}

function validateTaskStatus(value) {
  return TASK_STATUSES.has(value);
}

function validateTaskPriority(value) {
  return TASK_PRIORITIES.has(value);
}

function validateDueDate(value) {
  if (value === null) return true;
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/u.test(value)) return false;
  if (value.startsWith('0000-')) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

function validateVersion(value) {
  return Number.isSafeInteger(value) && value > 0;
}

module.exports = {
  PROJECT_DESCRIPTION_MAX,
  PROJECT_NAME_MAX,
  TASK_DESCRIPTION_MAX,
  TASK_TITLE_MAX,
  hasOnlyKeys,
  isPlainObject,
  isUuid,
  validateDescription,
  validateDueDate,
  validateRequiredText,
  validateTaskPriority,
  validateTaskStatus,
  validateVersion,
};
