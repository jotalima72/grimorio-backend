export class HttpError extends Error {
  constructor(status, code, message) { super(message); this.status = status; this.code = code; }
}
export const fail = (status, code, message) => { throw new HttpError(status, code, message); };
export const normalize = s => s.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
export function object(value, allowed) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(400,'VALIDATION_ERROR','Envie um objeto JSON.');
  const extra = Object.keys(value).filter(k => !allowed.includes(k));
  if (extra.length) fail(400,'VALIDATION_ERROR',`Campos desconhecidos: ${extra.join(', ')}.`);
  return value;
}
export function string(value, field, max = 200, trim = true) {
  if (typeof value !== 'string' || !value.trim() || value.length > max) fail(400,'VALIDATION_ERROR',`${field} deve ser um texto não vazio de até ${max} caracteres.`);
  return trim ? value.trim() : value;
}
export function integer(value, field, min = 1, max = Number.MAX_SAFE_INTEGER) {
  if (!Number.isSafeInteger(value) || value < min || value > max) fail(400,'VALIDATION_ERROR',`${field} deve ser um inteiro entre ${min} e ${max}.`);
  return value;
}
export function queryInteger(value, field, min = 1, max = Number.MAX_SAFE_INTEGER) {
  if (!/^\d+$/.test(value)) fail(400,'VALIDATION_ERROR',`${field} inválido.`);
  return integer(Number(value),field,min,max);
}
export function ids(value, field = 'classIds') {
  if (!Array.isArray(value) || value.length > 100) fail(400,'VALIDATION_ERROR',`${field} deve ser uma lista de até 100 IDs.`);
  const result = value.map(v => integer(v,field));
  if (new Set(result).size !== result.length) fail(400,'VALIDATION_ERROR',`${field} não pode repetir IDs.`);
  return result;
}
export function email(value) {
  const result = string(value,'email',254).toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(result)) fail(400,'VALIDATION_ERROR','Email inválido.');
  return result;
}
export function password(value) {
  const result = string(value,'password',256,false);
  if (result.length < 8 || !/\p{Lu}/u.test(result) || !/\p{Ll}/u.test(result) || !/[0-9]/.test(result)) fail(400,'VALIDATION_ERROR','A senha precisa de pelo menos 8 caracteres, uma letra maiúscula, uma letra minúscula e um número.');
  return result;
}
