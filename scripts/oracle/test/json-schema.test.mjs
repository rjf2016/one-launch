import { describe, expect, test } from 'vitest';
import { SchemaError, compileSchema, deepEqual, formatError } from '../lib/json-schema.mjs';

const errorsOf = (schema, value) => compileSchema(schema)(value).map(formatError);
const accepts = (schema, value) => expect(errorsOf(schema, value)).toEqual([]);
const rejects = (schema, value) => expect(errorsOf(schema, value)).not.toEqual([]);

describe('compileSchema', () => {
  test('type tells integer from number, null from object and array from object', () => {
    accepts({ type: 'integer' }, 3);
    rejects({ type: 'integer' }, 3.5);
    accepts({ type: 'number' }, 3.5);
    rejects({ type: 'object' }, null);
    rejects({ type: 'object' }, []);
    accepts({ type: ['string', 'null'] }, null);
    rejects({ type: ['string', 'null'] }, 0);
  });

  test('required, properties and additionalProperties', () => {
    const schema = { type: 'object', required: ['a'], additionalProperties: false, properties: { a: { type: 'string' }, b: { type: 'number' } } };
    accepts(schema, { a: 'x', b: 1 });
    expect(errorsOf(schema, {})).toEqual(['/ missing "a"']);
    expect(errorsOf(schema, { a: 'x', c: 1 })).toEqual(['/c nothing is allowed here']);
    expect(errorsOf(schema, { a: 1 })).toEqual(['/a expected string, found number']);
  });

  test('patternProperties take a key away from additionalProperties', () => {
    const schema = { patternProperties: { '^x-': { type: 'number' } }, additionalProperties: { type: 'string' } };
    accepts(schema, { 'x-a': 1, other: 's' });
    rejects(schema, { 'x-a': 's' });
    rejects(schema, { other: 1 });
  });

  test('propertyNames, minProperties and maxProperties', () => {
    accepts({ propertyNames: { pattern: '^[a-z]+$' } }, { ab: 1 });
    rejects({ propertyNames: { pattern: '^[a-z]+$' } }, { A: 1 });
    rejects({ minProperties: 1 }, {});
    rejects({ maxProperties: 1 }, { a: 1, b: 2 });
  });

  test('prefixItems, then items for the rest', () => {
    const tuple = { type: 'array', minItems: 2, prefixItems: [{ type: 'string' }, { type: 'number' }], items: false };
    accepts(tuple, ['a', 1]);
    rejects(tuple, ['a']);
    rejects(tuple, ['a', 1, 2]);
    rejects(tuple, [1, 1]);
    accepts({ prefixItems: [{ type: 'string' }], items: { type: 'number' } }, ['a', 1, 2]);
    rejects({ items: { type: 'number' } }, [1, 'a']);
  });

  test('uniqueItems compares deeply', () => {
    accepts({ uniqueItems: true }, [{ a: 1 }, { a: 2 }]);
    rejects({ uniqueItems: true }, [{ a: 1 }, { a: 1 }]);
  });

  test('enum and const compare deeply', () => {
    accepts({ enum: [true, 'mixed', null] }, null);
    rejects({ enum: [true, 'mixed', null] }, false);
    accepts({ const: { a: [1] } }, { a: [1] });
    rejects({ const: { a: [1] } }, { a: [2] });
  });

  test('pattern and length count code points, not UTF-16 units', () => {
    accepts({ pattern: '^[0-9a-f]{4}$' }, 'beef');
    rejects({ pattern: '^[0-9a-f]{4}$' }, 'beefy');
    accepts({ maxLength: 1 }, '\u{1F600}');
    rejects({ minLength: 2 }, '\u{1F600}');
    accepts({ pattern: '^.$' }, '\u{1F600}');
  });

  test('numeric limits', () => {
    accepts({ minimum: 0 }, 0);
    rejects({ minimum: 0 }, -1);
    rejects({ exclusiveMinimum: 0 }, 0);
    rejects({ maximum: 5 }, 6);
    rejects({ exclusiveMaximum: 5 }, 5);
  });

  test('anyOf, oneOf, allOf and not', () => {
    accepts({ anyOf: [{ type: 'string' }, { type: 'number' }] }, 1);
    rejects({ anyOf: [{ type: 'string' }, { type: 'number' }] }, null);
    accepts({ oneOf: [{ required: ['a'] }, { required: ['b'] }] }, { a: 1 });
    rejects({ oneOf: [{ required: ['a'] }, { required: ['b'] }] }, { a: 1, b: 2 });
    rejects({ oneOf: [{ required: ['a'] }, { required: ['b'] }] }, {});
    rejects({ allOf: [{ type: 'number' }, { minimum: 3 }] }, 2);
    rejects({ not: { type: 'string' } }, 's');
    accepts({ not: { type: 'string' } }, 1);
  });

  test('if picks then or else', () => {
    const schema = { if: { properties: { k: { const: 'job' } } }, then: { required: ['job'] }, else: { required: ['op'] } };
    accepts(schema, { k: 'job', job: 1 });
    rejects(schema, { k: 'job' });
    accepts(schema, { k: 'plat', op: 'x' });
    rejects(schema, { k: 'plat' });
  });

  test('a local $ref resolves, also to itself', () => {
    const schema = {
      $ref: '#/$defs/node',
      $defs: {
        node: { type: 'object', required: ['name'], properties: { name: { type: 'string' }, children: { type: 'array', items: { $ref: '#/$defs/node' } } } },
      },
    };
    accepts(schema, { name: 'a', children: [{ name: 'b', children: [] }] });
    expect(errorsOf(schema, { name: 'a', children: [{ name: 1 }] })).toEqual(['/children/0/name expected string, found number']);
  });

  test('error paths are JSON pointers', () => {
    expect(errorsOf({ additionalProperties: { type: 'number' } }, { 'a/b~c': 's' })).toEqual(['/a~1b~0c expected number, found string']);
  });

  test('boolean schemas', () => {
    accepts(true, 1);
    rejects(false, 1);
    accepts({}, { anything: [1, null] });
  });

  test('refuses what it does not check', () => {
    expect(() => compileSchema({ format: 'date-time' })).toThrow(SchemaError);
    expect(() => compileSchema({ properties: { a: { unevaluatedProperties: false } } })).toThrow(/unsupported keyword "unevaluatedProperties"/);
    expect(() => compileSchema({ $defs: { unused: { contains: {} } } })).toThrow(/unsupported keyword "contains"/);
    expect(() => compileSchema({ $ref: 'https://example.com/schema.json' })).toThrow(/only local references/);
    expect(() => compileSchema({ $ref: '#/$defs/missing' })).toThrow(/does not resolve/);
    expect(() => compileSchema({ type: 'text' })).toThrow(/unknown type/);
    expect(() => compileSchema({ pattern: '(' })).toThrow(SchemaError);
    expect(() => compileSchema({ then: {} })).toThrow(/need an if/);
    expect(() => compileSchema('object')).toThrow(/an object or a boolean/);
  });
});

describe('deepEqual', () => {
  test('keys in any order, arrays in order', () => {
    expect(deepEqual({ a: 1, b: [1, 2] }, { b: [1, 2], a: 1 })).toBe(true);
    expect(deepEqual([1, 2], [2, 1])).toBe(false);
    expect(deepEqual({ a: undefined }, { b: undefined })).toBe(false);
    expect(deepEqual(null, {})).toBe(false);
  });
});
