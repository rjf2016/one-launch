const ANNOTATIONS = new Set(['$schema', '$id', '$comment', 'title', 'description', 'examples', 'default']);
const TYPES = new Set(['null', 'boolean', 'number', 'integer', 'string', 'array', 'object']);

export class SchemaError extends Error {}

const kindOf = (value) => (value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value);
const isObject = (value) => kindOf(value) === 'object';
const hasType = (value, type) => (type === 'integer' ? Number.isInteger(value) : kindOf(value) === type);
const segment = (key) => String(key).replace(/~/g, '~0').replace(/\//g, '~1');

export function deepEqual(a, b) {
  if (a === b) return true;
  const kind = kindOf(a);
  if (kind !== kindOf(b)) return false;
  if (kind === 'array') return a.length === b.length && a.every((item, i) => deepEqual(item, b[i]));
  if (kind !== 'object') return false;
  const keys = Object.keys(a);
  return keys.length === Object.keys(b).length && keys.every((key) => Object.hasOwn(b, key) && deepEqual(a[key], b[key]));
}

function resolveRef(root, ref, where) {
  if (typeof ref !== 'string' || (ref !== '#' && !ref.startsWith('#/'))) throw new SchemaError(`${where}: only local references (#/...) are supported`);
  let target = root;
  for (const raw of ref.split('/').slice(1)) {
    const key = raw.replace(/~1/g, '/').replace(/~0/g, '~');
    if (!isObject(target) && !Array.isArray(target)) throw new SchemaError(`${where}: ${ref} does not resolve`);
    target = target[key];
    if (target === undefined) throw new SchemaError(`${where}: ${ref} does not resolve`);
  }
  return target;
}

// Any keyword outside this subset of JSON Schema 2020-12 is refused, so a schema can never lean on a check that does not run.
export function compileSchema(root) {
  const compiled = new Map();

  const build = (schema, where) => {
    if (schema === true) return () => {};
    if (schema === false) return (_value, at, errors) => errors.push({ path: at, message: 'nothing is allowed here' });
    if (!isObject(schema)) throw new SchemaError(`${where}: a schema is an object or a boolean`);
    if (compiled.has(schema)) return compiled.get(schema);

    const checks = [];
    const run = (value, at, errors) => {
      for (const check of checks) check(value, at, errors);
    };
    compiled.set(schema, run);

    const sub = (keyword, value = schema[keyword]) => build(value, `${where}/${keyword}`);
    const list = (keyword) => {
      if (!Array.isArray(schema[keyword]) || schema[keyword].length === 0) throw new SchemaError(`${where}/${keyword}: expected a non-empty array`);
      return schema[keyword].map((item, i) => build(item, `${where}/${keyword}/${i}`));
    };
    const count = (keyword) => {
      if (!Number.isInteger(schema[keyword]) || schema[keyword] < 0) throw new SchemaError(`${where}/${keyword}: expected a non-negative integer`);
      return schema[keyword];
    };
    const number = (keyword) => {
      if (typeof schema[keyword] !== 'number') throw new SchemaError(`${where}/${keyword}: expected a number`);
      return schema[keyword];
    };
    const regex = (source, at) => {
      try {
        return new RegExp(source, 'u');
      } catch (error) {
        throw new SchemaError(`${at}: ${error.message}`);
      }
    };
    const passes = (validate, value, at) => {
      const errors = [];
      validate(value, at, errors);
      return errors;
    };

    let objectDone = false;
    let arrayDone = false;
    let conditionDone = false;

    for (const keyword of Object.keys(schema)) {
      if (ANNOTATIONS.has(keyword)) continue;
      switch (keyword) {
        case '$defs': {
          if (!isObject(schema.$defs)) throw new SchemaError(`${where}/$defs: expected an object`);
          for (const [name, def] of Object.entries(schema.$defs)) build(def, `${where}/$defs/${name}`);
          break;
        }
        case '$ref': {
          const target = resolveRef(root, schema.$ref, `${where}/$ref`);
          const validate = build(target, schema.$ref);
          checks.push((value, at, errors) => validate(value, at, errors));
          break;
        }
        case 'type': {
          const types = Array.isArray(schema.type) ? schema.type : [schema.type];
          if (types.length === 0 || types.some((type) => !TYPES.has(type))) throw new SchemaError(`${where}/type: unknown type`);
          checks.push((value, at, errors) => {
            if (!types.some((type) => hasType(value, type))) errors.push({ path: at, message: `expected ${types.join(' or ')}, found ${kindOf(value)}` });
          });
          break;
        }
        case 'const': {
          const expected = schema.const;
          checks.push((value, at, errors) => {
            if (!deepEqual(value, expected)) errors.push({ path: at, message: `expected exactly ${JSON.stringify(expected)}` });
          });
          break;
        }
        case 'enum': {
          if (!Array.isArray(schema.enum) || schema.enum.length === 0) throw new SchemaError(`${where}/enum: expected a non-empty array`);
          const allowed = schema.enum;
          checks.push((value, at, errors) => {
            if (!allowed.some((item) => deepEqual(value, item))) errors.push({ path: at, message: `expected one of ${JSON.stringify(allowed)}` });
          });
          break;
        }
        case 'properties':
        case 'patternProperties':
        case 'additionalProperties': {
          if (objectDone) break;
          objectDone = true;
          for (const name of ['properties', 'patternProperties']) {
            if (schema[name] !== undefined && !isObject(schema[name])) throw new SchemaError(`${where}/${name}: expected an object`);
          }
          const named = Object.entries(schema.properties ?? {}).map(([name, value]) => [name, build(value, `${where}/properties/${name}`)]);
          const byName = new Map(named);
          const patterns = Object.entries(schema.patternProperties ?? {}).map(([source, value]) => [
            regex(source, `${where}/patternProperties/${source}`),
            build(value, `${where}/patternProperties/${source}`),
          ]);
          const rest = schema.additionalProperties === undefined ? null : sub('additionalProperties');
          checks.push((value, at, errors) => {
            if (!isObject(value)) return;
            for (const [key, item] of Object.entries(value)) {
              const next = `${at}/${segment(key)}`;
              let matched = false;
              if (byName.has(key)) {
                matched = true;
                byName.get(key)(item, next, errors);
              }
              for (const [pattern, validate] of patterns) {
                if (!pattern.test(key)) continue;
                matched = true;
                validate(item, next, errors);
              }
              if (!matched && rest) rest(item, next, errors);
            }
          });
          break;
        }
        case 'propertyNames': {
          const validate = sub('propertyNames');
          checks.push((value, at, errors) => {
            if (!isObject(value)) return;
            for (const key of Object.keys(value)) validate(key, `${at}/${segment(key)}`, errors);
          });
          break;
        }
        case 'required': {
          if (!Array.isArray(schema.required) || schema.required.some((name) => typeof name !== 'string'))
            throw new SchemaError(`${where}/required: expected an array of names`);
          const names = schema.required;
          checks.push((value, at, errors) => {
            if (!isObject(value)) return;
            for (const name of names) if (!Object.hasOwn(value, name)) errors.push({ path: at, message: `missing ${JSON.stringify(name)}` });
          });
          break;
        }
        case 'minProperties':
        case 'maxProperties': {
          const limit = count(keyword);
          const min = keyword === 'minProperties';
          checks.push((value, at, errors) => {
            if (!isObject(value)) return;
            const size = Object.keys(value).length;
            if (min ? size < limit : size > limit)
              errors.push({ path: at, message: `expected at ${min ? 'least' : 'most'} ${limit} properties, found ${size}` });
          });
          break;
        }
        case 'prefixItems':
        case 'items': {
          if (arrayDone) break;
          arrayDone = true;
          const prefix = schema.prefixItems === undefined ? [] : list('prefixItems');
          const rest = schema.items === undefined ? null : sub('items');
          checks.push((value, at, errors) => {
            if (!Array.isArray(value)) return;
            value.forEach((item, i) => {
              const validate = i < prefix.length ? prefix[i] : rest;
              if (validate) validate(item, `${at}/${i}`, errors);
            });
          });
          break;
        }
        case 'minItems':
        case 'maxItems': {
          const limit = count(keyword);
          const min = keyword === 'minItems';
          checks.push((value, at, errors) => {
            if (!Array.isArray(value)) return;
            if (min ? value.length < limit : value.length > limit)
              errors.push({ path: at, message: `expected at ${min ? 'least' : 'most'} ${limit} items, found ${value.length}` });
          });
          break;
        }
        case 'uniqueItems': {
          if (typeof schema.uniqueItems !== 'boolean') throw new SchemaError(`${where}/uniqueItems: expected a boolean`);
          if (!schema.uniqueItems) break;
          checks.push((value, at, errors) => {
            if (!Array.isArray(value)) return;
            value.forEach((item, i) => {
              if (value.slice(0, i).some((earlier) => deepEqual(earlier, item))) errors.push({ path: `${at}/${i}`, message: 'repeats an earlier item' });
            });
          });
          break;
        }
        case 'pattern': {
          if (typeof schema.pattern !== 'string') throw new SchemaError(`${where}/pattern: expected a string`);
          const pattern = regex(schema.pattern, `${where}/pattern`);
          checks.push((value, at, errors) => {
            if (typeof value === 'string' && !pattern.test(value)) errors.push({ path: at, message: `does not match ${schema.pattern}` });
          });
          break;
        }
        case 'minLength':
        case 'maxLength': {
          const limit = count(keyword);
          const min = keyword === 'minLength';
          checks.push((value, at, errors) => {
            if (typeof value !== 'string') return;
            const length = [...value].length;
            if (min ? length < limit : length > limit)
              errors.push({ path: at, message: `expected at ${min ? 'least' : 'most'} ${limit} characters, found ${length}` });
          });
          break;
        }
        case 'minimum':
        case 'maximum':
        case 'exclusiveMinimum':
        case 'exclusiveMaximum': {
          const limit = number(keyword);
          const fails = {
            minimum: (value) => value < limit,
            maximum: (value) => value > limit,
            exclusiveMinimum: (value) => value <= limit,
            exclusiveMaximum: (value) => value >= limit,
          }[keyword];
          checks.push((value, at, errors) => {
            if (typeof value === 'number' && fails(value)) errors.push({ path: at, message: `${keyword} is ${limit}, found ${value}` });
          });
          break;
        }
        case 'allOf': {
          const all = list('allOf');
          checks.push((value, at, errors) => {
            for (const validate of all) validate(value, at, errors);
          });
          break;
        }
        case 'anyOf':
        case 'oneOf': {
          const branches = list(keyword);
          const exactlyOne = keyword === 'oneOf';
          checks.push((value, at, errors) => {
            const results = branches.map((validate) => passes(validate, value, at));
            const matched = results.filter((found) => found.length === 0).length;
            if (exactlyOne ? matched === 1 : matched > 0) return;
            if (matched > 1) {
              errors.push({ path: at, message: `matches ${matched} of the ${branches.length} alternatives, expected exactly one` });
              return;
            }
            const closest = results.reduce((best, found) => (found.length < best.length ? found : best))[0];
            errors.push({ path: at, message: `matches none of the ${branches.length} alternatives (closest: ${closest.path || '/'} ${closest.message})` });
          });
          break;
        }
        case 'not': {
          const validate = sub('not');
          checks.push((value, at, errors) => {
            if (passes(validate, value, at).length === 0) errors.push({ path: at, message: 'matches a schema it must not match' });
          });
          break;
        }
        case 'if':
        case 'then':
        case 'else': {
          if (conditionDone) break;
          conditionDone = true;
          if (schema.if === undefined) throw new SchemaError(`${where}: then and else need an if`);
          const condition = sub('if');
          const then = schema.then === undefined ? null : sub('then');
          const otherwise = schema.else === undefined ? null : sub('else');
          checks.push((value, at, errors) => {
            const branch = passes(condition, value, at).length === 0 ? then : otherwise;
            if (branch) branch(value, at, errors);
          });
          break;
        }
        default:
          throw new SchemaError(`${where}: unsupported keyword ${JSON.stringify(keyword)}`);
      }
    }
    return run;
  };

  const validate = build(root, '#');
  return (value) => {
    const errors = [];
    validate(value, '', errors);
    return errors;
  };
}

export const formatError = (error) => `${error.path || '/'} ${error.message}`;
